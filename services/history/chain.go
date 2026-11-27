package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	pageRows  = 10_000 // hard cap of rows per query
	timeBatch = 100    // aliased point lookups; 200 exceeds the indexer's token limit
	workers   = 4
	tail      = 5 // newest blocks left for next time
)

// Source is one kind of market. The filters must match web/frontend/src/core/venues.
type Source struct {
	Stream string
	Like   string            // server-side narrowing
	Types  []string          // event types
	Pkg    func(string) bool // authoritative check on the emitting realm
	Group  func(pkg string, a map[string]string) string
	Keep   []string // attributes stored, in this order
	Realms []string // realms this source vouches for
}

const (
	poolRealm = "gno.land/r/gnoswap/pool"
	gnomiBase = "gno.land/r/g1n4pl5uc4yt5r96m9w6fmdznx3x0jyg8l6arhmt/gnomi/"
)

var pads = []string{gnomiBase + "padv3", gnomiBase + "padv2", gnomiBase + "pad"}

var sources = []Source{
	{
		Stream: "gnoswap:swap", Like: poolRealm, Types: []string{"Swap"}, Realms: []string{poolRealm},
		Pkg:   func(p string) bool { return p == poolRealm || strings.HasPrefix(p, poolRealm+"/") },
		Group: func(_ string, a map[string]string) string { return a["poolPath"] },
		Keep:  []string{"poolPath", "sqrtPriceX96", "token0Amount", "token1Amount"},
	},
	{
		Stream: "gnomi:trade", Like: gnomiBase, Types: []string{"Buy", "Sell", "SwapBuy", "SwapSell", "Graduated"}, Realms: pads,
		Pkg:   func(p string) bool { return slices.Contains(pads, p) },
		Group: func(pkg string, a map[string]string) string { return pkg + ":" + a["id"] },
		Keep:  []string{"id", "ugnot", "tokens", "poolUgnot", "poolToken"},
	},
}

type Client struct {
	Indexer, RPC string
	HTTP         *http.Client
	Window       int
}

// limitError means the range was too large, not that the read failed.
type limitError struct{ code string }

func (e limitError) Error() string { return e.code }

func (c *Client) post(ctx context.Context, url string, body, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		err := func() error {
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
			if err != nil {
				return err
			}
			req.Header.Set("Content-Type", "application/json")
			res, err := c.HTTP.Do(req)
			if err != nil {
				return err
			}
			defer res.Body.Close()
			raw, err := io.ReadAll(res.Body)
			if err != nil {
				return err
			}
			if res.StatusCode != http.StatusOK {
				return fmt.Errorf("HTTP %d from %s", res.StatusCode, url)
			}
			return json.Unmarshal(raw, out)
		}()
		if err == nil || ctx.Err() != nil || attempt == 3 {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(1<<attempt) * time.Second):
		}
	}
}

func (c *Client) gql(ctx context.Context, query string, vars map[string]any, out any) error {
	var r struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message    string `json:"message"`
			Extensions struct {
				Code string `json:"code"`
			} `json:"extensions"`
		} `json:"errors"`
	}
	if err := c.post(ctx, c.Indexer, map[string]any{"query": query, "variables": vars}, &r); err != nil {
		return err
	}
	if len(r.Errors) > 0 {
		e := r.Errors[0]
		if e.Extensions.Code == "MAX_ELEMENTS_REACHED" || e.Extensions.Code == "QUERY_DEADLINE_EXCEEDED" {
			return limitError{e.Extensions.Code}
		}
		return errors.New(e.Message)
	}
	return json.Unmarshal(r.Data, out)
}

func (c *Client) Latest(ctx context.Context) (int, error) {
	var d struct {
		H int `json:"latestBlockHeight"`
	}
	err := c.gql(ctx, "{ latestBlockHeight }", nil, &d)
	return d.H, err
}

type rawEvent struct {
	Type  string `json:"type"`
	Pkg   string `json:"pkg_path"`
	Attrs []struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	} `json:"attrs"`
}

type rawTx struct {
	Height   int `json:"block_height"`
	Response struct {
		Events []rawEvent `json:"events"`
	} `json:"response"`
}

const txQuery = `query($where: FilterTransaction!, $order: TransactionOrder) {
  getTransactions(where: $where, order: $order) {
    block_height response { events { ... on GnoEvent { type pkg_path attrs { key value } } } }
  }
}`

// txs returns matching transactions in [from, to), splitting the range whenever it hits a limit.
func (c *Client) txs(ctx context.Context, like string, types []string, from, to int) ([]rawTx, error) {
	ev := map[string]any{"pkg_path": map[string]any{"like": like}}
	if len(types) == 1 {
		ev["type"] = map[string]any{"eq": types[0]}
	}
	where := map[string]any{
		"block_height": map[string]any{"gt": from - 1, "lt": to}, "success": map[string]any{"eq": true},
		"response": map[string]any{"events": map[string]any{"GnoEvent": ev}},
	}
	var d struct {
		Txs []rawTx `json:"getTransactions"`
	}
	err := c.gql(ctx, txQuery, map[string]any{"where": where, "order": map[string]any{"heightAndIndex": "ASC"}}, &d)
	var limit limitError
	switch {
	case err == nil && len(d.Txs) < pageRows:
		return d.Txs, nil
	case err != nil && !errors.As(err, &limit):
		return nil, fmt.Errorf("blocks %d to %d: %w", from, to, err)
	case to-from <= 1:
		return nil, fmt.Errorf("block %d alone exceeds the indexer's limit", from)
	}
	mid := from + (to-from)/2
	a, err := c.txs(ctx, like, types, from, mid)
	if err != nil {
		return nil, err
	}
	b, err := c.txs(ctx, like, types, mid, to)
	return append(a, b...), err
}

// parallel runs fn for 0..n-1 with bounded concurrency and returns the first error.
func parallel(ctx context.Context, n int, fn func(context.Context, int) error) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	var wg sync.WaitGroup
	slots := make(chan struct{}, workers)
	for i := range n {
		slots <- struct{}{}
		if ctx.Err() != nil {
			<-slots
			break
		}
		wg.Go(func() {
			defer func() { <-slots }()
			if err := fn(ctx, i); err != nil {
				cancel(err)
			}
		})
	}
	wg.Wait()
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	return nil
}

// Scan reads one source's events in [from, to), in chain order.
func (c *Client) Scan(ctx context.Context, s Source, from, to int) ([]Event, error) {
	n := (to - from + c.Window - 1) / c.Window
	parts := make([][]rawTx, max(n, 0))
	err := parallel(ctx, len(parts), func(ctx context.Context, i int) (err error) {
		a := from + i*c.Window
		parts[i], err = c.txs(ctx, s.Like, s.Types, a, min(a+c.Window, to))
		return err
	})
	if err != nil {
		return nil, err
	}
	var out []Event
	for _, p := range parts {
		out = append(out, decode(s, p)...)
	}
	return out, nil
}

// decode keeps only events the source vouches for: a transaction carries everyone's.
func decode(s Source, txs []rawTx) []Event {
	var out []Event
	for _, tx := range txs {
		for _, e := range tx.Response.Events {
			if !slices.Contains(s.Types, e.Type) || !s.Pkg(e.Pkg) {
				continue
			}
			a := make(map[string]string, len(e.Attrs))
			for _, kv := range e.Attrs {
				a[kv.Key] = kv.Value
			}
			ev := Event{Height: tx.Height, Type: e.Type, Pkg: e.Pkg, Group: s.Group(e.Pkg, a), Values: make([]string, len(s.Keep))}
			for i, k := range s.Keep {
				ev.Values[i] = a[k]
			}
			out = append(out, ev)
		}
	}
	return out
}

// BlockTimes looks blocks up by height, in milliseconds.
func (c *Client) BlockTimes(ctx context.Context, heights []int) (map[int]int64, error) {
	out := make(map[int]int64, len(heights))
	var mu sync.Mutex
	err := parallel(ctx, (len(heights)+timeBatch-1)/timeBatch, func(ctx context.Context, i int) error {
		batch := heights[i*timeBatch : min((i+1)*timeBatch, len(heights))]
		var q strings.Builder
		q.WriteByte('{')
		for _, h := range batch {
			fmt.Fprintf(&q, "b%d:getBlocks(where:{height:{eq:%d}}){time} ", h, h)
		}
		q.WriteByte('}')
		var d map[string][]struct {
			Time time.Time `json:"time"`
		}
		if err := c.gql(ctx, q.String(), nil, &d); err != nil {
			return err
		}
		mu.Lock()
		defer mu.Unlock()
		for _, h := range batch {
			b := d[fmt.Sprintf("b%d", h)]
			if len(b) == 0 || b[0].Time.IsZero() {
				return fmt.Errorf("the indexer has no block %d", h)
			}
			out[h] = b[0].Time.UnixMilli()
		}
		return nil
	})
	return out, err
}

// Pools returns the pools created in [from, to).
func (c *Client) Pools(ctx context.Context, from, to int) ([]Pool, error) {
	s := sources[0]
	txs, err := c.txs(ctx, poolRealm, []string{"CreatePool"}, from, to)
	if err != nil {
		return nil, err
	}
	var out []Pool
	for _, tx := range txs {
		for _, e := range tx.Response.Events {
			if e.Type != "CreatePool" || !s.Pkg(e.Pkg) {
				continue
			}
			p := Pool{Height: tx.Height}
			for _, kv := range e.Attrs {
				switch kv.Key {
				case "poolPath":
					p.Path = kv.Value
				case "sqrtPriceX96":
					p.Sqrt = kv.Value
				}
			}
			if strings.Count(p.Path, ":") != 2 || !digits.MatchString(p.Sqrt) {
				return nil, fmt.Errorf("block %d: unexpected CreatePool event", tx.Height)
			}
			out = append(out, p)
		}
	}
	return out, nil
}

var (
	digits = regexp.MustCompile(`^\d+$`)
	quoted = regexp.MustCompile(`^\("(\d+)" string\)`)
	safe   = regexp.MustCompile(`^[A-Za-z0-9_./:-]+$`)
)

// slot0 reads a pool's current square-root price from the contract.
func (c *Client) slot0(ctx context.Context, pool string) (string, error) {
	if !safe.MatchString(pool) {
		return "", fmt.Errorf("unsafe pool path %q", pool)
	}
	expr := fmt.Sprintf(`%s.GetSlot0SqrtPriceX96("%s")`, poolRealm, pool)
	var r struct {
		Result struct {
			Response struct {
				ResponseBase struct {
					Data  []byte
					Error any
				}
			} `json:"response"`
		} `json:"result"`
	}
	err := c.post(ctx, c.RPC, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "abci_query", "params": map[string]any{"path": "vm/qeval", "data": base64.StdEncoding.EncodeToString([]byte(expr))}}, &r)
	if err != nil {
		return "", err
	}
	m := quoted.FindSubmatch(r.Result.Response.ResponseBase.Data)
	if m == nil {
		return "", fmt.Errorf("unexpected price reply for %s", pool)
	}
	return string(m[1]), nil
}

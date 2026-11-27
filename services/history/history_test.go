package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

const poolA = "gno.land/r/a/a.A:gno.land/r/gnoland/wugnot.wugnot:3000"

// fakeChain has one pool created at block 2 that swaps every 10 blocks, and one launch that trades every 25.
type fakeChain struct {
	tip, maxRange int
	slot          string // price the contract reports; empty means the true one
	failTimes     bool
}

func sqrtAt(h int) string { return strconv.Itoa(1_000_000 + h) }

func (f *fakeChain) server(t *testing.T) *Client {
	num := regexp.MustCompile(`b(\d+):getBlocks`)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			Query     string
			Method    string
			Variables struct {
				Where struct {
					Height   struct{ Gt, Lt int } `json:"block_height"`
					Response struct {
						Events struct {
							GnoEvent struct {
								Type *struct{ Eq string }
								Pkg  struct{ Like string } `json:"pkg_path"`
							}
						}
					}
				}
			}
		}
		if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
			t.Error(err)
		}
		reply := func(v any) { json.NewEncoder(w).Encode(v) }
		data := func(v any) { reply(map[string]any{"data": v}) }
		switch {
		case q.Method == "abci_query":
			v := f.slot
			if v == "" {
				v = sqrtAt(f.tip / 10 * 10)
			}
			reply(map[string]any{"result": map[string]any{"response": map[string]any{"ResponseBase": map[string]any{"Data": base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("(%q string)\n", v)))}}}})
		case strings.Contains(q.Query, "latestBlockHeight"):
			data(map[string]any{"latestBlockHeight": f.tip})
		case strings.Contains(q.Query, "getBlocks"):
			out := map[string]any{}
			for _, m := range num.FindAllStringSubmatch(q.Query, -1) {
				h, _ := strconv.Atoi(m[1])
				out["b"+m[1]] = []any{map[string]any{"time": time.UnixMilli(1e12 + int64(h)*3000).UTC().Format(time.RFC3339Nano)}}
				if f.failTimes {
					out["b"+m[1]] = nil
				}
			}
			data(out)
		default:
			wh := q.Variables.Where
			from, to := wh.Height.Gt+1, min(wh.Height.Lt, f.tip+1)
			if f.maxRange > 0 && wh.Height.Lt-from > f.maxRange {
				reply(map[string]any{"errors": []any{map[string]any{"message": "cap", "extensions": map[string]any{"code": "MAX_ELEMENTS_REACHED"}}}})
				return
			}
			ev := func(typ, pkg string, kv ...string) any {
				a := []any{}
				for i := 0; i < len(kv); i += 2 {
					a = append(a, map[string]any{"key": kv[i], "value": kv[i+1]})
				}
				return map[string]any{"type": typ, "pkg_path": pkg, "attrs": a}
			}
			e := wh.Response.Events.GnoEvent
			txs := []any{}
			for h := from; h < to; h++ {
				var evs []any
				switch {
				case e.Type != nil && e.Type.Eq == "CreatePool" && h == 2:
					evs = []any{ev("CreatePool", poolRealm+"/v1", "poolPath", poolA, "sqrtPriceX96", "5"), ev("CreatePool", "gno.land/r/evil/pool", "poolPath", "x", "sqrtPriceX96", "y")}
				case e.Type != nil && e.Type.Eq == "Swap" && h%10 == 0:
					sw := func(pkg string) any {
						return ev("Swap", pkg, "poolPath", poolA, "sqrtPriceX96", sqrtAt(h), "token0Amount", "7", "token1Amount", "-3", "junk", "z")
					}
					evs = []any{sw(poolRealm + "/v1"), sw("gno.land/r/gnoswap/poolfake"), sw("gno.land/r/evil/pool")}
				case e.Type == nil && e.Pkg.Like == gnomiBase && h%25 == 0:
					evs = []any{ev("Buy", pads[0], "id", "1", "ugnot", "9", "tokens", "8"), ev("Buy", gnomiBase+"padv9", "id", "1", "ugnot", "9", "tokens", "8"), ev("BuyRefund", pads[0], "id", "1")}
				}
				if evs != nil {
					txs = append(txs, map[string]any{"block_height": h, "response": map[string]any{"events": evs}})
				}
			}
			data(map[string]any{"getTransactions": txs})
		}
	}))
	t.Cleanup(s.Close)
	return &Client{Indexer: s.URL, RPC: s.URL, HTTP: s.Client(), Window: 100}
}

func extend(t *testing.T, c *Client, prev *History, to int) *History {
	t.Helper()
	h, err := c.Extend(context.Background(), prev, to)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestScanKeepsOnlyWhatTheSourceVouchesFor(t *testing.T) {
	h := extend(t, (&fakeChain{tip: 300}).server(t), &History{}, 300)
	sw, tr := h.Events["gnoswap:swap"], h.Events["gnomi:trade"]
	if len(sw) != 29 || len(tr) != 11 {
		t.Fatalf("got %d swaps and %d trades", len(sw), len(tr))
	}
	want := Event{Height: 10, Type: "Swap", Pkg: poolRealm + "/v1", Group: poolA, Values: []string{poolA, sqrtAt(10), "7", "-3"}}
	if !reflect.DeepEqual(sw[0], want) {
		t.Errorf("got %+v", sw[0])
	}
	if tr[0].Group != pads[0]+":1" {
		t.Errorf("group %q", tr[0].Group)
	}
	if len(h.Pools) != 1 || h.Pools[0].Path != poolA {
		t.Errorf("pools %+v", h.Pools)
	}
	if h.Times[10] != 1e12+30_000 || h.Times[2] == 0 || h.Times[1] == 0 {
		t.Error("missing block times")
	}
}

func TestSplitsWhenTheIndexerHitsItsLimit(t *testing.T) {
	a := extend(t, (&fakeChain{tip: 500}).server(t), &History{}, 500)
	b := extend(t, (&fakeChain{tip: 500, maxRange: 7}).server(t), &History{}, 500)
	if !reflect.DeepEqual(a, b) {
		t.Error("a limited indexer gave a different history")
	}
}

func TestExtendingEqualsScanningAtOnce(t *testing.T) {
	c := (&fakeChain{tip: 500}).server(t)
	h := &History{}
	for _, to := range []int{3, 10, 11, 120, 333, 500} {
		h = extend(t, c, h, to)
	}
	if whole := extend(t, c, &History{}, 500); !reflect.DeepEqual(h, whole) {
		t.Error("incremental history differs")
	}
}

func TestRoundTrip(t *testing.T) {
	h := extend(t, (&fakeChain{tip: 400}).server(t), &History{}, 400)
	dir := t.TempDir()
	name, _, err := Save(dir, h)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, h) {
		t.Error("history changed on disk")
	}
	if name != "history-400.json" {
		t.Error(name)
	}
}

func TestSaveKeepsThePreviousFileOneRound(t *testing.T) {
	c, dir := (&fakeChain{tip: 400}).server(t), t.TempDir()
	for _, to := range []int{90, 100, 400} {
		if _, _, err := Save(dir, extend(t, c, &History{}, to)); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := filepath.Glob(filepath.Join(dir, "*"))
	for i := range got {
		got[i] = filepath.Base(got[i])
	}
	if want := []string{"history-100.json", "history-400.json", "history.json"}; !reflect.DeepEqual(got, want) {
		t.Errorf("files %v", got)
	}
}

func TestRunRefusesToWriteWhatTheContractContradicts(t *testing.T) {
	f, dir := &fakeChain{tip: 300, slot: "123"}, t.TempDir()
	c := f.server(t)
	if err := run(context.Background(), c, dir, false); err == nil || !strings.Contains(err.Error(), "disagrees") {
		t.Fatalf("err %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, manifest)); err == nil {
		t.Fatal("wrote an unverified file")
	}
	f.slot = ""
	if err := run(context.Background(), c, dir, false); err != nil {
		t.Fatal(err)
	}
	h, err := Load(dir)
	if err != nil || h.Height != 300-tail {
		t.Fatalf("height %d, %v", h.Height, err)
	}
	// a later failure keeps the good file
	f.tip, f.failTimes = 600, true
	if err := run(context.Background(), c, dir, false); err == nil {
		t.Fatal("expected an error")
	}
	if again, _ := Load(dir); again.Height != 300-tail {
		t.Error("the good file was replaced")
	}
}

func TestVerifyAllowsTradesNewerThanTheFile(t *testing.T) {
	c := (&fakeChain{tip: 300}).server(t)
	if err := c.Verify(context.Background(), extend(t, c, &History{}, 255)); err != nil {
		t.Error(err)
	}
}

func TestParseRejectsDamage(t *testing.T) {
	b, err := encode(extend(t, (&fakeChain{tip: 200}).server(t), &History{}, 200))
	if err != nil {
		t.Fatal(err)
	}
	for name, bad := range map[string]string{
		"truncated": string(b[:len(b)/2]),
		"version":   strings.Replace(string(b), `"v":1`, `"v":2`, 1),
		"chain":     strings.Replace(string(b), `"gnoland-1"`, `"onyx-1"`, 1),
		"realms":    strings.Replace(string(b), "gnomi/padv2", "gnomi/padv8", 1),
		"index":     strings.Replace(string(b), `"rows":[[10,0,`, `"rows":[[10,9,`, 1),
		"negative":  strings.Replace(string(b), `"rows":[[10,0,`, `"rows":[[10,-1,`, 1),
	} {
		if bad == string(b) {
			t.Fatalf("%s: the test did not change the file", name)
		}
		if _, err := parse([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestManifestCannotPointElsewhere(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, manifest), []byte(`{"file":"../secret.json"}`), 0o644)
	if _, err := Load(dir); err == nil {
		t.Error("accepted")
	}
}

func TestSlot0RefusesUnsafePaths(t *testing.T) {
	c := (&fakeChain{tip: 10}).server(t)
	if _, err := c.slot0(context.Background(), `a")+Evil("`); err == nil {
		t.Error("accepted")
	}
}

// The browser reads this same file in its own tests, so both sides agree on the format.
func TestGoldenFileForTheBrowser(t *testing.T) {
	b, err := encode(extend(t, (&fakeChain{tip: 120}).server(t), &History{}, 120))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("testdata", "small.json")
	if os.Getenv("UPDATE") != "" {
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if want, err := os.ReadFile(path); err != nil || string(want) != string(b) {
		t.Errorf("format changed (err %v); run with UPDATE=1 and check the browser", err)
	}
}

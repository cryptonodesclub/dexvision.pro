package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

const (
	version  = 1
	chainID  = "gnoland-1"
	manifest = "history.json"
)

type Event struct {
	Height           int
	Type, Pkg, Group string
	Values           []string // aligned with Source.Keep
}

type Pool struct {
	Path   string `json:"path"`
	Sqrt   string `json:"sqrt"`
	Height int    `json:"height"`
}

// History is everything traded in blocks [1, Height).
type History struct {
	Height int
	Events map[string][]Event // by stream, in chain order
	Times  map[int]int64
	Pools  []Pool
}

func (h *History) Count() (n int) {
	for _, e := range h.Events {
		n += len(e)
	}
	return n
}

// Extend adds blocks [prev.Height, to) and returns a new History; prev is left alone.
func (c *Client) Extend(ctx context.Context, prev *History, to int) (*History, error) {
	from := max(prev.Height, 1)
	h := &History{Height: to, Events: map[string][]Event{}, Times: maps.Clone(prev.Times), Pools: slices.Clone(prev.Pools)}
	if h.Times == nil {
		h.Times = map[int]int64{}
	}
	need := map[int]bool{}
	for _, s := range sources {
		fresh, err := c.Scan(ctx, s, from, to)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", s.Stream, err)
		}
		h.Events[s.Stream] = append(slices.Clone(prev.Events[s.Stream]), fresh...)
		for _, e := range h.Events[s.Stream] {
			if _, ok := h.Times[e.Height]; !ok {
				need[e.Height] = true
			}
		}
	}
	pools, err := c.Pools(ctx, from, to)
	if err != nil {
		return nil, fmt.Errorf("pools: %w", err)
	}
	h.Pools = append(h.Pools, pools...)
	for _, p := range h.Pools {
		if _, ok := h.Times[p.Height]; !ok {
			need[p.Height] = true
		}
	}
	// anchors: they let the browser turn any date into a block without asking
	for b := 1; b < to; b += 20_000 {
		if _, ok := h.Times[b]; !ok {
			need[b] = true
		}
	}
	times, err := c.BlockTimes(ctx, slices.Sorted(maps.Keys(need)))
	if err != nil {
		return nil, fmt.Errorf("block times: %w", err)
	}
	maps.Copy(h.Times, times)
	return h, nil
}

// Verify compares the last swap of each pool with the price the contract reports now.
func (c *Client) Verify(ctx context.Context, h *History) error {
	last := map[string]string{}
	for _, p := range h.Pools {
		last[p.Path] = p.Sqrt
	}
	for _, e := range h.Events["gnoswap:swap"] {
		if _, ok := last[e.Group]; !ok {
			return fmt.Errorf("swap in a pool that was never created: %s", e.Group)
		}
		last[e.Group] = e.Values[1]
	}
	tip, err := c.Latest(ctx)
	if err != nil {
		return err
	}
	// trades after h.Height are legitimate reasons to differ
	recent, err := c.Scan(ctx, sources[0], h.Height, tip+1)
	if err != nil {
		return err
	}
	for _, e := range recent {
		last[e.Group] = e.Values[1]
	}
	for _, p := range h.Pools {
		now, err := c.slot0(ctx, p.Path)
		if err != nil {
			return err
		}
		if now != last[p.Path] {
			return fmt.Errorf("%s is at %s but its last known swap left it at %s", p.Path, now, last[p.Path])
		}
	}
	return nil
}

/* File format. Columns and deltas keep it small before compression:

   streams[name].rows is a flat list: [Δheight, group, type, values...] per event. */

type fileStream struct {
	Realms []string `json:"realms"`
	Keep   []string `json:"keep"`
	Types  []string `json:"types"`
	Pkgs   []string `json:"pkgs"`
	Groups []string `json:"groups"`
	Rows   [][]any  `json:"rows"` // [Δheight, group, type, pkg, ...values]
}

type file struct {
	V       int                   `json:"v"`
	Chain   string                `json:"chain"`
	Height  int                   `json:"height"`
	Streams map[string]fileStream `json:"streams"`
	Times   [][2]int64            `json:"times"` // [Δheight, Δms]
	Pools   []Pool                `json:"pools"`
}

// Manifest is the small file a browser reads first.
type Manifest struct {
	V      int    `json:"v"`
	Chain  string `json:"chain"`
	Height int    `json:"height"`
	File   string `json:"file"`
	Bytes  int    `json:"bytes"`
}

func index(list *[]string, at map[string]int, v string) int {
	i, ok := at[v]
	if !ok {
		i = len(*list)
		at[v] = i
		*list = append(*list, v)
	}
	return i
}

func encode(h *History) ([]byte, error) {
	f := file{V: version, Chain: chainID, Height: h.Height, Streams: map[string]fileStream{}, Pools: h.Pools}
	for _, s := range sources {
		out := fileStream{Realms: s.Realms, Keep: s.Keep, Types: []string{}, Pkgs: []string{}, Groups: []string{}, Rows: [][]any{}}
		types, pkgs, groups, prev := map[string]int{}, map[string]int{}, map[string]int{}, 0
		for _, e := range h.Events[s.Stream] {
			if e.Height < prev || e.Height >= h.Height {
				return nil, fmt.Errorf("%s: block %d is out of order", s.Stream, e.Height)
			}
			row := []any{e.Height - prev, index(&out.Groups, groups, e.Group), index(&out.Types, types, e.Type), index(&out.Pkgs, pkgs, e.Pkg)}
			for _, v := range e.Values {
				if v == e.Group { // the pool path is already the group
					v = "="
				}
				row = append(row, v)
			}
			for len(row) > 4 && row[len(row)-1] == "" {
				row = row[:len(row)-1]
			}
			out.Rows = append(out.Rows, row)
			prev = e.Height
		}
		f.Streams[s.Stream] = out
	}
	var ph, pt int64
	for _, b := range slices.Sorted(maps.Keys(h.Times)) {
		f.Times = append(f.Times, [2]int64{int64(b) - ph, h.Times[b] - pt})
		ph, pt = int64(b), h.Times[b]
	}
	return json.Marshal(f)
}

func parse(b []byte) (*History, error) {
	var f file
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	if f.V != version || f.Chain != chainID {
		return nil, fmt.Errorf("file is version %d of %s", f.V, f.Chain)
	}
	h := &History{Height: f.Height, Events: map[string][]Event{}, Times: map[int]int64{}, Pools: f.Pools}
	for _, s := range sources {
		in, ok := f.Streams[s.Stream]
		if !ok || !slices.Equal(in.Keep, s.Keep) || !slices.Equal(in.Realms, s.Realms) {
			return nil, fmt.Errorf("%s was written with other settings", s.Stream)
		}
		height := 0
		for _, r := range in.Rows {
			n := [4]int{}
			if len(r) < 4 {
				return nil, errors.New("short row")
			}
			for i := range n {
				v, ok := r[i].(float64)
				if !ok {
					return nil, errors.New("malformed row")
				}
				n[i] = int(v)
			}
			if n[1] >= len(in.Groups) || n[2] >= len(in.Types) || n[3] >= len(in.Pkgs) || min(n[0], n[1], n[2], n[3]) < 0 {
				return nil, errors.New("row points outside its tables")
			}
			height += n[0]
			e := Event{Height: height, Group: in.Groups[n[1]], Type: in.Types[n[2]], Pkg: in.Pkgs[n[3]], Values: make([]string, len(s.Keep))}
			for i, v := range r[4:] {
				t, ok := v.(string)
				if !ok || i >= len(s.Keep) {
					return nil, errors.New("malformed row")
				}
				if t == "=" {
					t = e.Group
				}
				e.Values[i] = t
			}
			h.Events[s.Stream] = append(h.Events[s.Stream], e)
		}
	}
	var b0, t0 int64
	for _, t := range f.Times {
		b0, t0 = b0+t[0], t0+t[1]
		h.Times[int(b0)] = t0
	}
	return h, nil
}

// Load returns nil when there is no previous file.
func Load(dir string) (*History, error) {
	b, err := os.ReadFile(filepath.Join(dir, manifest))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	if m.File != filepath.Base(m.File) {
		return nil, errors.New("manifest points outside its directory")
	}
	data, err := os.ReadFile(filepath.Join(dir, m.File))
	if err != nil {
		return nil, err
	}
	return parse(data)
}

func writeAtomic(path string, b []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := errors.Join(tmp.Chmod(0o644), tmp.Sync(), tmp.Close()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// Save writes the data under a new name, then points the manifest at it. The previous data stays one
// more round, for browsers that had already read the old manifest.
func Save(dir string, h *History) (string, int, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", 0, err
	}
	b, err := encode(h)
	if err != nil {
		return "", 0, err
	}
	name := fmt.Sprintf("history-%d.json", h.Height)
	if err := writeAtomic(filepath.Join(dir, name), b); err != nil {
		return "", 0, err
	}
	m, err := json.Marshal(Manifest{V: version, Chain: chainID, Height: h.Height, File: name, Bytes: len(b)})
	if err != nil {
		return "", 0, err
	}
	if err := writeAtomic(filepath.Join(dir, manifest), m); err != nil {
		return "", 0, err
	}
	old, _ := filepath.Glob(filepath.Join(dir, "history-*.json"))
	slices.SortFunc(old, func(a, b string) int { return heightOf(b) - heightOf(a) })
	for i, p := range old {
		if i > 1 && filepath.Base(p) != name {
			os.Remove(p)
		}
	}
	return name, len(b), nil
}

func heightOf(path string) int {
	n, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "history-"), ".json"))
	return n
}

// Command history writes everything that has ever traded on gno.land's known markets into one compact
// file, so a first visit to DexVision downloads that instead of scanning the chain from the browser.
//
//	go run ./services/history -out web/frontend/public/data           once
//	go run ./services/history -out web/frontend/public/data -every 10m  keep it fresh
//
// Runs are incremental: a previous file is extended, not rebuilt. Nothing is written unless the result
// agrees with the contracts.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	var (
		indexer = flag.String("indexer", "https://indexer.gno.land/graphql/query", "tx-indexer GraphQL endpoint")
		rpc     = flag.String("rpc", "https://rpc.gno.land:443", "node RPC, used to verify the result")
		out     = flag.String("out", "data", "directory to write to")
		every   = flag.Duration("every", 0, "repeat at this interval; 0 runs once")
		rebuild = flag.Bool("rebuild", false, "ignore the previous file and scan from the first block")
		window  = flag.Int("window", 200_000, "blocks per query")
	)
	flag.Parse()
	log.SetFlags(log.Ltime)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	c := &Client{Indexer: *indexer, RPC: *rpc, HTTP: &http.Client{Timeout: 60 * time.Second}, Window: *window}

	for {
		err := run(ctx, c, *out, *rebuild)
		*rebuild = false
		switch {
		case ctx.Err() != nil:
			return
		case err != nil && *every == 0:
			log.Fatal(err)
		case err != nil:
			log.Printf("kept the previous file: %v", err)
		}
		if *every == 0 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(*every):
		}
	}
}

func run(ctx context.Context, c *Client, out string, rebuild bool) error {
	start := time.Now()
	prev := &History{}
	if !rebuild {
		p, err := Load(out)
		if err != nil {
			log.Printf("starting over: %v", err)
		} else if p != nil {
			prev = p
		}
	}
	tip, err := c.Latest(ctx)
	if err != nil {
		return fmt.Errorf("latest height: %w", err)
	}
	// the indexer may announce a block just before its events
	to := tip - tail
	if to <= prev.Height {
		log.Printf("nothing new since block %d", prev.Height)
		return nil
	}
	h, err := c.Extend(ctx, prev, to)
	if err != nil {
		return err
	}
	if err := c.Verify(ctx, h); err != nil {
		return fmt.Errorf("not written, it disagrees with the chain: %w", err)
	}
	name, size, err := Save(out, h)
	if err != nil {
		return err
	}
	log.Printf("%s: %d events, %d block times, up to block %d (%d KB, %d new) in %s", name, h.Count(), len(h.Times), h.Height, size/1024, h.Count()-prev.Count(), time.Since(start).Round(100*time.Millisecond))
	return nil
}

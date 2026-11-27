# DexVision

**Live token prices, charts, holders and trading for gno.land, plus an on-chain registry where every token publishes its own verified profile.**

DexVision reads the chain straight from your browser: every Gnoswap pool and Gnomi launch, priced in GNOT (or USD), with candles, trades, holder maps and who can pull the liquidity. You can trade from the same page with Adena.

For the Gnome Tavern hackathon it adds **`tokeninfo`**, a realm that answers the question every explorer has: *which links really belong to this token?* The people behind a token write its description, logo and official links on-chain, once. The realm checks who is signing, so anyone reading the profile knows it came from the token's owner. Any app can read the same verified data.

- App: https://dexvision.pro (opens on the **onyx-1** testnet; click the chain name in the header for mainnet)
- Realm on Onyx: [`gno.land/r/g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh/tokeninfo/v1`](https://onyx.testnets.gno.land/r/g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh/tokeninfo/v1)
- Demo token on Onyx: [`gno.land/r/g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh/dxv`](https://onyx.testnets.gno.land/r/g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh/dxv)
- Demo video: _link added with the submission_

## What it does

| | |
| --- | --- |
| **Token list** | Every token with a market on Gnoswap or Gnomi, ranked by trending, gainers, losers, volume or depth. Search by symbol or realm path. |
| **Token page** | Price, 1m to 1d candles, depth, market cap, supply, every market it trades in, the latest trades, and the contract source. |
| **Holders** | Balances rebuilt from every transfer since genesis and checked against the contract, drawn as a map of who sent tokens to whom. |
| **Liquidity** | Who can withdraw each Gnoswap position, staked ones included. |
| **Trade** | Buy and sell in one transaction signed with Adena, dry-run on a node first so the fee, deposit and price impact are known before signing. Live on onyx-1; on mainnet it opens after a real-signature test. |
| **Token profile** | The token's on-chain description, logo and links, with who published them. If your wallet owns the token, you can edit them from the page. |
| **Two chains** | The Onyx testnet (`onyx-1`, the default) and mainnet (`gnoland-1`), one click apart in the header. |

## The `tokeninfo` realm

Source: [`realm/tokeninfo`](realm/tokeninfo).

### Who can write a profile

A token is identified by its registry key in [`grc20reg`](https://gno.land/r/nt/grc20reg/v0), `gno.land/r/<namespace>/<realm>.<SYMBOL>`. Only these callers can write its profile:

1. **The namespace owner.** This is the address in `gno.land/r/g1…/`, or whoever holds the name in `gno.land/r/<name>/` today according to `r/sys/users`. These are the same rules the chain uses to decide who may deploy there, so whoever controls the token's code also controls its profile.
2. **The token realm itself.** A token can set its own profile from its code, for example in `init`.
3. **Editors** that the owner or the realm added, so a team can share the job without sharing a key.

The realm checks these rules itself. It does not trust `r/sys/names` alone, because that verifier lets every address through while it is disabled. Tokens must be listed in `grc20reg`, so nobody can claim paths that don't exist.

### API

```go
// Write (crossing functions)
SetProfile(cur realm, token, description, website, logo, x, telegram, discord, github string)
ClearProfile(cur realm, token string)
AddEditor(cur realm, token string, editor address)     // owner or token realm
RemoveEditor(cur realm, token string, editor address)  // editors can remove themselves

// Read (any realm can import these, any client can qeval them)
Get(token string) (Profile, bool)   // a copy; false if missing or hidden
Fields(token string) (...)          // the same, one value per line for vm/qeval
CanEdit(token string, addr address) bool
IsEditor(token string, addr address) bool
Editors(token string) []address
Count() int
List(offset, limit int) []string

// Moderation (the deployer, until TransferAdmin)
Hide(cur realm, token, reason string)  // e.g. a phishing link; the reason is public
Unhide(cur realm, token string)
TransferAdmin(cur realm, next address)
```

The moderator can only hide a profile. It can never write one, and every action emits an event.

### Safety

- Inputs are checked on write. Links must be `https://` with no characters that could break out of Markdown or HTML. Handles are plain `[A-Za-z0-9_]`. The description is one paragraph of up to 280 characters with no control characters. Discord must be an invite link.
- `Render` escapes everything users wrote with `p/nt/markdown/sanitize`. Token paths in a page address must match a strict pattern before they are used in a link.
- The realm follows the [Gno contract review checklist](https://docs.gno.land/resources/gno-ai-contract-review): it calls `cur.IsCurrent()` on every write, reads identity from `cur.Previous()`, never imports `chain/runtime/unsafe`, and never returns pointers to its state.

### Try it with gnokey

```sh
REALM=gno.land/r/g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh/tokeninfo/v1
RPC=https://rpc.onyx.testnets.gno.land:443

# read
gnokey query vm/qrender -data "$REALM:" -remote $RPC
gnokey query vm/qeval -data "$REALM.Fields(\"gno.land/r/<you>/<token>.<SYMBOL>\")" -remote $RPC

# write, from the address that owns the token's namespace
gnokey maketx call -pkgpath $REALM -func SetProfile \
  -args "gno.land/r/<you>/<token>.<SYMBOL>" -args "What the token is for" \
  -args https://example.com -args https://example.com/logo.png \
  -args yourhandle -args yourgroup -args https://discord.gg/invite -args owner/repo \
  -gas-fee 1000000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote $RPC <key>
```

## The demo token, DXV

[`realm/demotoken`](realm/demotoken) is DexVision Demo (DXV), a GRC20 token with no value, registered in `grc20reg`. Anyone can claim 1,000 DXV a day with `Faucet`. The publisher holds the rest to seed a Gnoswap pool, so the whole flow can be tried on Onyx for free: find DXV, trade it, read its profile, and edit the profile from the publisher's wallet.

## How it works

```
browser ──► gno.land RPC    (vm/qeval, vm/qrender, vm/qfile, tx simulate)
        ──► tx-indexer      (GraphQL: swaps, transfers, pool events)
        ──► Adena           (signing)
        ◄── /data/*.json    (optional history file, services/history)
```

There is no backend. The browser reads the chain, keeps past trades in IndexedDB so they are fetched once, and checks what it remembered against the contract before trusting it.

| Path | What |
| --- | --- |
| [`realm/tokeninfo`](realm/tokeninfo) | The profile registry realm, with tests |
| [`realm/demotoken`](realm/demotoken) | DXV, the testnet demo token |
| [`web/frontend`](web/frontend) | The app (Astro + TypeScript, no framework at runtime) |
| [`web/frontend/src/core`](web/frontend/src/core) | Chain access: RPC, indexer, venues (Gnoswap, Gnomi), pricing, holders, trading, profiles |
| [`web/frontend/src/app`](web/frontend/src/app) | Page logic: list, token page, chart, trade panel, wallet, profile |
| [`services/history`](services/history) | Go service that publishes the trade history as a static file, so a first visit doesn't scan the chain |
| [`web/lab`](web/lab) | Design explorations, not part of the app |

## Run it

```sh
# the app
cd web/frontend
npm ci
npm run dev        # http://localhost:4321 (onyx-1), add ?network=mainnet for gnoland-1
npm test           # 165 tests
npm run check      # TypeScript

# the realms (needs the gno toolchain, https://docs.gno.land/builders/install)
cd realm/tokeninfo && gno test -v .
cd realm/demotoken && gno test -v .
```

## Deployments

| Chain | Package | Status |
| --- | --- | --- |
| onyx-1 | `gno.land/r/g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh/tokeninfo/v1` | deployed at block 1432851 |
| onyx-1 | `gno.land/r/g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh/dxv` | deployed at block 1432881 |
| gnoland-1 | `tokeninfo` | after the hackathon |

## Roadmap

- Deploy `tokeninfo` on mainnet and invite token teams to fill in their profiles.
- Show profiles in the token list (logos next to symbols).
- Let launchpads set a profile from the token realm when a token is created.
- Token safety facts read from the contract source: who can mint, pause or change fees.

## License

[MIT](LICENSE)

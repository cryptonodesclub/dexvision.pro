import { NETWORK, WUGNOT } from './config.ts';
import type { Store } from './cache.ts';
import { realmAddress } from './address.ts';
import { hasSigned, linksOf, ranked, readable, readLedger, totalOf, type HolderSet, type Holder, type Kind } from './holders.ts';
import { Indexer } from './indexer.ts';
import { mapPool, type NetOptions } from './net.ts';
import { InputError, parseRealm, splitTokenPath } from './paths.ts';
import type { Activity, LiveMarket, Snapshot, Supply } from './overview.ts';
import { candles, priceAll, relevant, type Candle, type Trade } from './price.ts';
import { Rpc, RpcError } from './rpc.ts';
import { checkManifest, decodeHistory, isWorthIt } from './snapshot.ts';
import { HISTORY, VENUES } from './venues/index.ts';
import type { Market, MarketState, Token, Venue, VenueContext, VenueFactory } from './venues/venue.ts';

const REGISTRY = 'gno.land/r/nt/grc20reg/v0';

/**
 * wugnot registers 0 decimals because it wraps ugnot one to one, but people read GNOT (10^6 ugnot).
 * Trusting the registry here would put every price off by a million.
 */
const DECIMALS: Record<string, number> = { [WUGNOT]: 6 };

export type { Token };
export interface MarketQuote {
  key: string; venue: string; feePct: number; pairedWith: string; stage?: string;
  price: number;            // token in the paired token
  priceGnot: number | null; // through the paired token's own best route
  depthGnot: number | null; // GNOT value of the paired side
  active: boolean;
}
export interface TokenPrice { token: Token; priceGnot: number | null; depthGnot: number | null; route: string[]; markets: MarketQuote[] }
/** `unavailable` lists what could not be read, so a partial answer never looks complete. */
export interface Prices { tokens: TokenPrice[]; unavailable: { source: string; reason: string }[]; at: number }
export interface CandleQuery { interval: number; from: number; to?: number; market?: string }
export interface CandleSet { market: string; venue: string; quote: string; interval: number; candles: Candle[]; trades: number; partial: boolean }

export interface TradeSet { market: string; venue: string; quote: string; seed?: number; trades: Trade[]; partial: boolean }

export interface OwnTrade { t: number; height: number; buy: boolean; price: number; amount: number }

export interface Provider { address: string; kind: Kind; realm?: string; parts: { key: string; staked: boolean; token: number; paired: number; positions: number }[] }
/** `covered`: how much of the paired side of a pool the positions add up to. `curve`: it also trades where nobody provides. */
export interface Liquidity { pools: { key: string; covered: number }[]; failed: string[]; curve: boolean; named: boolean; providers: Provider[] }

export interface EngineOptions extends NetOptions { rpc?: string; indexer?: string; marketTtlMs?: number; venues?: readonly VenueFactory[]; /** Remembers history between visits. */ store?: Store; /** Folder of the published history (services/history), e.g. "/data". */ history?: string }

const keyOf = (m: Market) => `${m.venue}|${m.id}`;
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createEngine(o: EngineOptions = {}) {
  const net: NetOptions = { fetch: o.fetch, signal: o.signal, timeoutMs: o.timeoutMs, retries: o.retries };
  const rpc = new Rpc(o.rpc ?? NETWORK.rpc, net), indexer = new Indexer(o.indexer ?? NETWORK.indexer, net, o.store);
  if (o.store && o.history && NETWORK.seeded) {
    const store = o.store, dir = o.history, get = async (file: string, cache: RequestCache) => { const r = await (o.fetch ?? fetch)(`${dir}/${file}`, { cache, signal: AbortSignal.timeout(8_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<unknown>; };
    indexer.prime(async () => {
      const m = checkManifest(await get('history.json', 'no-cache'), NETWORK.chainId);
      return (await isWorthIt(store, m.height, HISTORY)) ? decodeHistory(await get(m.file, 'force-cache'), NETWORK.chainId, HISTORY) : null;
    }, HISTORY.map((h) => h.stream));
  }
  const ttl = o.marketTtlMs ?? 60_000;
  const tokens = new Map<string, Promise<Token>>();

  function token(path: string): Promise<Token> {
    let p = tokens.get(path);
    if (!p) { tokens.set(path, p = loadToken(path)); p.catch(() => tokens.delete(path)); } // never cache a failure
    return p;
  }
  async function loadToken(path: string): Promise<Token> {
    const { realm, symbol } = splitTokenPath(path);
    const was = DECIMALS[path] ?? await indexer.recall<number>(`decimals:${path}`), decimals = was ?? Number(await rpc.evalInt(`${REGISTRY}.Get("${path}").GetDecimals()`));
    if (was === undefined) void indexer.note(`decimals:${path}`, decimals);
    if (decimals < 0 || decimals > 36) throw new RpcError(`${path} declares ${decimals} decimals`);
    return { path, realm, symbol, decimals };
  }

  const ctx: VenueContext = { rpc, indexer, token };
  const venues: Venue[] = (o.venues ?? VENUES).map((f) => f(ctx));
  const label = (id: string) => venues.find((v) => v.id === id)?.label ?? id;

  const listed = new Map<string, { at: number; list: Promise<Market[]> }>();
  function marketsOf(v: Venue): Promise<Market[]> {
    const hit = listed.get(v.id);
    if (hit && Date.now() - hit.at <= ttl) return hit.list;
    const list = v.markets();
    listed.set(v.id, { at: Date.now(), list });
    list.catch(() => listed.delete(v.id));
    return list;
  }
  /** Every market of every venue. One venue being down does not hide the others. */
  async function markets(): Promise<{ list: Market[]; unavailable: Prices['unavailable'] }> {
    const got = await Promise.allSettled(venues.map(marketsOf));
    if (got.every((g) => g.status === 'rejected')) throw (got[0] as PromiseRejectedResult | undefined)?.reason ?? new Error('no venues');
    return {
      list: got.flatMap((g) => (g.status === 'fulfilled' ? g.value : [])),
      unavailable: got.flatMap((g, i) => (g.status === 'rejected' ? [{ source: venues[i]!.label, reason: reason(g.reason) }] : [])),
    };
  }
  const venueOf = (m: Market): Venue => venues.find((v) => v.id === m.venue)!;

  /** Realm in, prices out. One entry per traded token in that realm. */
  async function prices(input: string): Promise<Prices> {
    const ref = parseRealm(input), { list, unavailable } = await markets();
    const paths = [...new Set(list.flatMap((m) => [m.token0, m.token1]))].filter((t) => {
      const s = splitTokenPath(t);
      return s.realm === ref.realm && (ref.symbol === undefined || s.symbol === ref.symbol);
    });
    if (!paths.length) {
      const missing = unavailable.length ? ` Could not check ${unavailable.map((u) => u.source).join(', ')}.` : '';
      throw new InputError(`No known market trades a token from ${ref.realm}${ref.symbol ? '.' + ref.symbol : ''}.${missing}`);
    }
    const states = (await mapPool(relevant(list, [...paths, WUGNOT]), 6, async (m) => {
      try { return { m, key: keyOf(m), token0: m.token0, token1: m.token1, ...(await venueOf(m).state(m)) }; }
      catch (e) { unavailable.push({ source: `${label(m.venue)} ${m.token0.split('.').pop()}/${m.token1.split('.').pop()}`, reason: reason(e) }); return null; }
    })).filter((x): x is { m: Market; key: string; token0: string; token1: string } & MarketState => x !== null);
    const quotes = priceAll(states, WUGNOT);
    const out = await Promise.all(paths.map(async (path): Promise<TokenPrice> => {
      const mine = quotes.get(path);
      const rows = states.filter((s) => s.token0 === path || s.token1 === path).map((s): MarketQuote => {
        const is0 = s.token0 === path, pairedWith = is0 ? s.token1 : s.token0, price = is0 ? s.price : 1 / s.price, q = quotes.get(pairedWith);
        return { key: s.key, venue: label(s.m.venue), feePct: s.m.feePct, pairedWith, stage: s.stage, price, priceGnot: q ? price * q.price : null, depthGnot: q ? (is0 ? s.balance1 : s.balance0) * q.price : null, active: s.active };
      }).sort((a, b) => Number(b.active) - Number(a.active) || (b.depthGnot ?? 0) - (a.depthGnot ?? 0));
      return { token: await token(path), priceGnot: mine?.price ?? null, depthGnot: mine && Number.isFinite(mine.depth) ? mine.depth : null, route: mine?.route ?? [], markets: rows };
    }));
    return { tokens: out, unavailable, at: Date.now() };
  }

  /** Trades of one market since a moment, as prices of the token, plus the price just before. */
  async function trades(tokenPath: string, key: string, from: number, to = Date.now()): Promise<TradeSet> {
    const { list } = await markets(), m = list.find((x) => keyOf(x) === key);
    if (!m || (m.token0 !== tokenPath && m.token1 !== tokenPath)) throw new InputError(`No such market for ${tokenPath}.`);
    const is0 = m.token0 === tokenPath, side = (p: number) => (is0 ? p : 1 / p), latest = await indexer.latestHeight();
    // starting a little early is cheaper and only makes the opening price better known
    const [a, b] = await Promise.all([indexer.heightAt(from, latest, (to - from) * 0.02), to >= Date.now() - 1000 ? latest + 1 : indexer.heightAt(to, latest)]);
    const { seed, fills, partial = false } = await venueOf(m).fills(m, a, b), times = await indexer.blockTimes(fills.map((f) => f.height));
    const all = fills.map((f): Trade => ({ t: times.get(f.height)!, price: side(f.price), vol: is0 ? f.amount0 : f.amount1, buy: is0 === f.buy }));
    const before = all.filter((t) => t.t < from).at(-1)?.price ?? (seed === undefined ? undefined : side(seed)), out: TradeSet = { market: key, venue: label(m.venue), quote: is0 ? m.token1 : m.token0, partial, trades: all.filter((t) => t.t >= from && t.t < to) };
    return before === undefined ? out : { ...out, seed: before };
  }

  /** What one account did in a market: when, which side, and the price it really paid. */
  async function myTrades(tokenPath: string, m: Market, account: string): Promise<OwnTrade[]> {
    if (!/^g1[02-9ac-hj-np-z]{38}$/.test(account)) throw new InputError('That is not a gno.land address.');
    const is0 = m.token0 === tokenPath, got = await venueOf(m).mine(m, account, (await indexer.latestHeight()) + 1), times = await indexer.blockTimes(got.map((f) => f.height));
    return got.map((f) => ({ t: times.get(f.height)!, height: f.height, buy: is0 === f.buy, price: is0 ? f.price : 1 / f.price, amount: is0 ? f.amount0 : f.amount1 }));
  }

  /** Like `trades`, from this device alone: at once, or null. */
  async function peekTrades(tokenPath: string, m: Market, from: number): Promise<TradeSet | null> {
    const got = await venueOf(m).peek(m).catch(() => null);
    if (!got) return null;
    const is0 = m.token0 === tokenPath, side = (p: number) => (is0 ? p : 1 / p), times = await indexer.blockTimes(got.fills.map((f) => f.height));
    const all = got.fills.map((f): Trade => ({ t: times.get(f.height)!, price: side(f.price), vol: is0 ? f.amount0 : f.amount1, buy: is0 === f.buy })), before = all.filter((t) => t.t < from).at(-1)?.price;
    const out: TradeSet = { market: keyOf(m), venue: label(m.venue), quote: is0 ? m.token1 : m.token0, partial: false, trades: all.filter((t) => t.t >= from) };
    return before === undefined ? out : { ...out, seed: before };
  }

  /** Candles of one market, by default the one that sets the token's price. */
  async function history(tokenPath: string, q: CandleQuery): Promise<CandleSet> {
    const to = q.to ?? Date.now(), key = q.market ?? (await prices(tokenPath)).tokens[0]?.route.at(-1);
    if (!key) throw new InputError(`No priced market for ${tokenPath}.`);
    const start = Math.floor(q.from / q.interval) * q.interval, t = await trades(tokenPath, key, start, to);
    return { market: key, venue: t.venue, quote: t.quote, interval: q.interval, trades: t.trades.length, partial: t.partial, candles: candles(t.trades, start, to, q.interval, t.seed) };
  }

  /** Current state of every market, or only those that can price `scope`. With `prev` and `only`, re-reads just those. */
  async function snapshot(prev?: Snapshot, only?: ReadonlySet<string>, scope?: string): Promise<Snapshot> {
    const [height, { list: every, unavailable }] = await Promise.all([indexer.latestHeight(), markets()]);
    const list = scope === undefined ? every : relevant(every, [scope, WUGNOT]);
    if (scope !== undefined && !every.some((m) => m.token0 === scope || m.token1 === scope)) throw new InputError(`No known market trades ${scope}.${unavailable.length ? ` Could not check ${unavailable.map((u) => u.source).join(', ')}.` : ''}`);
    const old = new Map(prev?.markets.map((x) => [x.key, x]));
    const paths = [...new Set(list.flatMap((m) => [m.token0, m.token1]))], supply = new Map<string, Supply>(prev?.supply);
    const moved = only && new Set(list.filter((m) => only.has(keyOf(m))).flatMap((m) => [m.token0, m.token1]));
    // independent reads, so they share round trips
    const [read, toks, times] = await Promise.all([
      Promise.all(list.map(async (m): Promise<LiveMarket | null> => {
        const key = keyOf(m), had = old.get(key);
        if (had && only && !only.has(key)) return had;
        try { return { key, token0: m.token0, token1: m.token1, m, venue: label(m.venue), ...(await venueOf(m).state(m)) }; }
        catch (e) { unavailable.push({ source: `${label(m.venue)} ${m.token0.split('.').pop()}/${m.token1.split('.').pop()}`, reason: reason(e) }); return null; }
      })),
      Promise.allSettled(paths.map(async (p) => [p, await token(p)] as const)),
      indexer.blockTimes(list.map((m) => m.height).filter((h) => h > 0)).catch(() => new Map<number, number>()),
      Promise.all(paths.filter((p) => p !== WUGNOT && (!supply.has(p) || !moved || moved.has(p))).map(async (p) => {
        const t = `${REGISTRY}.Get("${p}")`; // extra detail: a row without it is still useful
        try { const [s, n, k] = await Promise.all([rpc.evalInt(t + '.TotalSupply()'), rpc.evalInt(t + '.KnownAccounts()'), token(p)]); supply.set(p, { supply: Number(s) / 10 ** k.decimals, accounts: Number(n) }); } catch { /* shown as unknown */ }
      })),
    ]);
    const live = read.filter((x) => x !== null);
    if (!live.length) throw new Error(unavailable[0]?.reason ?? 'no market could be read');
    const created = new Map(live.flatMap((x) => { const t = times.get(x.m.height); return t === undefined ? [] : [[x.key, t] as const]; }));
    return { markets: live, tokens: new Map(toks.flatMap((t) => (t.status === 'fulfilled' ? [t.value] : []))), supply, created, height, at: Date.now(), unavailable };
  }

  /** Trades of the last `span` ms across every market. A venue that fails is left out, so its rows show no change instead of a false zero. */
  async function activity(s: Snapshot, span: number): Promise<Activity> {
    // trades are filtered by time later, so starting a little early is fine and much cheaper
    const from = await indexer.heightAt(Date.now() - span, s.height, span * 0.03), to = s.height + 1, fills: Activity['fills'] = new Map();
    await Promise.all(venues.map(async (v) => {
      const ms = s.markets.filter((x) => x.m.venue === v.id).map((x) => x.m);
      if (!ms.length) return;
      try { for (const [id, f] of await v.recent(ms, from, to)) fills.set(`${v.id}|${id}`, f); }
      catch (e) { s.unavailable.push({ source: `${v.label} trades`, reason: reason(e) }); }
    }));
    return { span, fills, times: await indexer.blockTimes([...fills.values()].flatMap((f) => f.fills.map((x) => x.height))) };
  }

  /** Keys of the markets that traded after a height, and how far that check reached. */
  async function touched(after: number): Promise<{ keys: Set<string>; height: number }> {
    const height = await indexer.latestHeight();
    if (height <= after) return { keys: new Set(), height: after };
    const got = await Promise.all(venues.map(async (v) => (await v.touched(after + 1, height + 1)).map((id) => `${v.id}|${id}`)));
    return { keys: new Set(got.flat()), height };
  }

  /** Every realm on the chain by the address it holds things at. */
  let addresses: Promise<Map<string, string>> | undefined;
  function realms(): Promise<Map<string, string>> {
    addresses ??= rpc.query('vm/qpaths?limit=10000', 'gno.land/r').then(async (t) => {
      const list = t.split('\n').filter((p) => /^gno\.land\/r\/[a-z0-9_/-]+$/.test(p));
      if (!list.length) throw new RpcError('the list of realms came back empty');
      return new Map(await Promise.all(list.map(async (p) => [await realmAddress(p), p] as const)));
    });
    addresses.catch(() => { addresses = undefined; });
    return addresses;
  }

  /** Looks up accounts and returns a way to tell what each one is. */
  async function kinds(accounts: readonly string[], names: Map<string, string> | null): Promise<(a: string) => { kind: Kind; realm?: string }> {
    const seen = new Map<string, boolean>();
    await Promise.all(accounts.map(async (a) => { if (names?.has(a)) return; try { seen.set(a, hasSigned(await rpc.query('auth/accounts/' + a, ''))); } catch (e) { if (e instanceof RpcError && /empty reply/.test(e.message)) seen.set(a, false); } }));
    return (a) => { const realm = names?.get(a), s = seen.get(a); return realm ? { kind: 'contract', realm } : { kind: s === undefined ? 'unread' : s ? 'wallet' : 'quiet' }; };
  }

  /** Who can withdraw the reserves behind a token, across every pool it trades in. */
  async function liquidity(path: string, progress: (part: number) => void = () => {}): Promise<Liquidity> {
    const [{ list }, names, tip] = await Promise.all([markets(), realms().catch(() => null), indexer.latestHeight()]), mine = list.filter((m) => m.token0 === path || m.token1 === path), pools = mine.filter((m) => venueOf(m).providers), parts = new Map<string, Provider['parts']>(), out: Liquidity['pools'] = [], failed: string[] = [], done = new Map<string, number>();
    await mapPool(pools, 2, async (m) => {
      const key = keyOf(m), is0 = m.token0 === path;
      try {
        const r = await venueOf(m).providers!(m, tip + 1, (p) => { done.set(key, p); progress([...done.values()].reduce((s, x) => s + x, 0) / pools.length); });
        let paired = 0;
        for (const s of r.stakes) {
          const t = is0 ? s.amount0 : s.amount1, q = is0 ? s.amount1 : s.amount0, l = parts.get(s.owner) ?? parts.set(s.owner, []).get(s.owner)!, had = l.find((x) => x.key === key && x.staked === s.staked);
          paired += q;
          if (had) { had.token += t; had.paired += q; had.positions++; } else l.push({ key, staked: s.staked, token: t, paired: q, positions: 1 });
        }
        const bal = is0 ? r.balance1 : r.balance0;
        out.push({ key, covered: bal > 0 ? paired / bal : 1 });
      } catch { failed.push(key); }
    });
    const size = (p: Provider['parts']) => p.reduce((s, x) => s + x.paired, 0), accounts = [...parts].sort((a, b) => size(b[1]) - size(a[1])).map(([a]) => a), what = await kinds(accounts.slice(0, 200), names);
    return { pools: out, failed, curve: mine.some((m) => !venueOf(m).providers), named: names !== null, providers: accounts.map((a) => ({ address: a, parts: parts.get(a)!, ...what(a) })) };
  }

  /**
   * Who holds a token. Contracts keep balances but no list of owners, so this adds up every transfer ever made
   * and checks the result against the contract: total supply and the largest balances.
   */
  async function holders(path: string, progress: (part: number) => void = () => {}, wait = 4000): Promise<HolderSet> {
    const t = `${REGISTRY}.Get("${path}")`, { decimals } = await token(path), [id, names] = await Promise.all([rpc.evalString(`${t}.ID()`), realms().catch(() => null)]);
    if (!id.startsWith(`${path}.`)) throw new RpcError(`${path} calls itself ${id}`);
    const read = async (fresh: boolean) => {
      const { ledger, remembered } = await readLedger(indexer, id, await indexer.latestHeight(), fresh, progress), top = ranked(ledger), some = readable(top, 20);
      const [supply, ...bal] = await Promise.all([rpc.evalInt(`${t}.TotalSupply()`), ...some.map((a) => rpc.evalInt(`${t}.BalanceOf("${a}")`))]);
      const ok = totalOf(ledger) === supply && [...ledger.balances.values()].every((v) => v > 0n) && some.every((a, i) => ledger.balances.get(a) === bal[i]);
      return { ledger, top, supply: supply!, ok, remembered };
    };
    let got = await read(false);
    // the indexer runs a block or two behind the node: look again before doubting anything
    for (let i = 0; i < 2 && !got.ok; i++) { await new Promise((r) => setTimeout(r, wait)); got = await read(false); }
    if (!got.ok && got.remembered) got = await read(true);
    const unit = 10 ** decimals, what = await kinds(readable(got.top.filter(([a]) => !names?.has(a)), 100), names);
    const list = got.top.map(([address, v]): Holder => {
      return { address, amount: Number(v) / unit, share: got.supply > 0n ? Number(v) / Number(got.supply) : 0, ...what(address) };
    });
    const state = got.supply === 0n && !list.length ? 'empty' : got.ledger.balances.size === 0 ? 'silent' : got.ok ? 'exact' : 'differs';
    return { holders: list, links: linksOf(got.ledger), supply: Number(got.supply) / unit, height: got.ledger.height, state, named: names !== null };
  }

  /** Source files of a realm, as published on chain. Tests are left out. */
  async function sourceFiles(realm: string): Promise<string[]> {
    const list = await rpc.query('vm/qfile', parseRealm(realm).realm);
    return list.split('\n').filter((f) => /^[A-Za-z0-9_.-]+\.gno$/.test(f) && !/_(test|filetest)\.gno$/.test(f));
  }
  async function sourceFile(realm: string, file: string): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+\.gno$/.test(file)) throw new InputError(`"${file}" is not a source file.`);
    return rpc.query('vm/qfile', `${parseRealm(realm).realm}/${file}`);
  }

  return { liquidity, prices, history, trades, myTrades, peekTrades, holders, sourceFiles, sourceFile, snapshot, activity, touched, token, markets, indexer, rpc };
}
export type Engine = ReturnType<typeof createEngine>;

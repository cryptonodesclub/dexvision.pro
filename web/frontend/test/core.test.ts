import { sortBy } from '../src/app/sort.ts';
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { ALL, indexedDbStore, memoryStore, ranges, type Range, type Store } from '../src/core/cache.ts';
import { checkManifest, decodeHistory, isWorthIt, type Expected } from '../src/core/snapshot.ts';
import { HISTORY } from '../src/core/venues/index.ts';
import golden from '../../../services/history/testdata/small.json';
import { WUGNOT } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine.ts';
import { books, outcome, tierOf, tierRange, TIERS } from '../src/core/traders.ts';
import { BY, Indexer, IndexerError, signer, TAIL, TX, type ChainEvent, type EventFilter } from '../src/core/indexer.ts';
import { mapPool, postJson } from '../src/core/net.ts';
import { assertPoolPath, InputError, parseRealm } from '../src/core/paths.ts';
import { candles, ema, price0in1, priceAll, relevant, sides, type PricedMarket } from '../src/core/price.ts';
import { detail, pick, priceAt, summarize, type Activity, type LiveMarket, type Row, type Snapshot } from '../src/core/overview.ts';
import { age, amount, esc, pct, price as fmtPrice, usd, usdAmount, usdPrice } from '../src/app/format.ts';
import { display, other } from '../src/app/money.ts';
import { pathFromLocation, shortAddress, tokenUrl, txUrl } from '../src/app/links.ts';
import { cast, layout } from '../src/app/constellation.ts';
import { widen } from '../src/app/chart.ts';
import { digest, share } from '../src/app/holders.ts';
import { backers } from '../src/app/liquidity.ts';
import { explorer } from '../src/app/links.ts';
import { realmAddress as addressOf } from '../src/core/address.ts';
import { add, emptyLedger, groupsOf, hasSigned, linksOf, ranked, readLedger, totalOf, type Holder } from '../src/core/holders.ts';
import { gnotUsd } from '../src/core/usd.ts';
import { parseGno, Rpc } from '../src/core/rpc.ts';
import { gnomi, newCurve, parseTradeHistory, reconcile, replay, spotScaled, withSigners } from '../src/core/venues/gnomi.ts';
import { gnoswap, POOL_CREATED } from '../src/core/venues/gnoswap.ts';
import type { Market, Venue, VenueContext, VenueFactory } from '../src/core/venues/venue.ts';
import { decodeResult, encodeTx, type Call } from '../src/core/trade/proto.ts';
import { createHash } from 'node:crypto';
import { GNOMI_GAS, gnomiDesk, PAD, PAD_ADDRESS, parseMarket, parseReserves, planClaim, planGnomi, quoteCurve } from '../src/core/trade/gnomi.ts';
import { approveStyle, costOf, createTrader, explain, formatAmount, isAddress, lockedCoins, minOut, parseAmount, plan, planUnwrap, routeOf, ROUTER_ADDRESS, withUnwrap, type Order } from '../src/core/trade/trade.ts';
import type { Engine } from '../src/core/engine.ts';
import gnova from './fixtures/gnova.json';
import simOk from './fixtures/sim.json';
import txFix from './fixtures/tx.json';

const GNOMIC = 'gno.land/r/nym-thegnomic001/gnomic.GNOMIC', GNS = 'gno.land/r/gnoswap/gns.GNS';
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe('realm input', () => {
  it.each([
    ['gno.land/r/gnoswap/gns', 'gno.land/r/gnoswap/gns', undefined],
    ['/r/gnoswap/gns', 'gno.land/r/gnoswap/gns', undefined],
    [' https://gno.land/r/gnoswap/gns$source&file=gns.gno ', 'gno.land/r/gnoswap/gns', undefined],
    ['gno.land/r/nt/grc20reg/v0:some/args', 'gno.land/r/nt/grc20reg/v0', undefined],
    [GNOMIC, 'gno.land/r/nym-thegnomic001/gnomic', 'GNOMIC'],
    ['https://gnoswap.io/token?path=gno.land%2Fr%2Fgnoswap%2Fgns.GNS', 'gno.land/r/gnoswap/gns', 'GNS'],
  ])('%s', (input, realm, symbol) => expect(parseRealm(input)).toEqual(symbol ? { realm, symbol } : { realm }));
  it.each(['', 'hello', 'gno.land/p/nt/grc20', 'gno.land/r/a").Evil("', 'g1vc883gshu5z7ytk5cdynhc8c2dh67pdp4cszkp', 'gno.land/r/x/y.S")'])('rejects %j', (s) => expect(() => parseRealm(s)).toThrow(InputError));
  it('rejects malformed pool paths', () => {
    expect(assertPoolPath(`${WUGNOT}:${GNS}:3000`)).toBe(`${WUGNOT}:${GNS}:3000`);
    for (const bad of [`${WUGNOT}:${GNS}`, `${WUGNOT}:${GNS}:30x`, `${WUGNOT}:${GNS}:3000")+("`]) expect(() => assertPoolPath(bad)).toThrow(InputError);
  });
});

describe('qeval output', () => {
  it('reads strings, numbers and tuples', () => {
    expect(parseGno('("183212861321984232276593700044" string)\n')).toEqual([{ value: '183212861321984232276593700044', type: 'string' }]);
    expect(parseGno('(33403357 int64)\n(280016578 int64)\n(undefined)')).toEqual([{ value: '33403357', type: 'int64' }, { value: '280016578', type: 'int64' }]);
  });
  it('unescapes multi-line strings', () => expect(parseGno('("a|1\\nb|2" string)')[0]!.value).toBe('a|1\nb|2'));
});

describe('price', () => {
  it('matches the real GNOMIC pool with its on-chain 6 decimals', () => {
    expect(1 / price0in1(183212861321984232276593700044n, 6, 6)).toBeCloseTo(0.18700243, 8);
  });
  it('applies decimals in the right direction', () => {
    expect(price0in1(1n << 96n, 6, 6)).toBe(1);
    expect(price0in1(1n << 96n, 8, 6)).toBe(100); // one whole token0 is 100x more raw units
  });
  it('agrees with exact integer arithmetic at the extremes', () => {
    for (const s of [4295128740n, 34140452875838985561383648067n, 1461446703485210103287273052203988822378723970341n]) {
      const scale = 10n ** 80n, exact = Number((s * s * scale) / (1n << 192n)) / 1e80;
      expect(price0in1(s, 0, 0) / exact).toBeCloseTo(1, 12);
    }
  });
  it('rejects an uninitialised pool', () => expect(() => price0in1(0n, 6, 6)).toThrow(RangeError));
});

describe('routing', () => {
  const mk = (key: string, token0: string, token1: string, price: number, balance0: number, balance1: number, active = true): PricedMarket => ({ key, token0, token1, price, balance0, balance1, active });
  it('prefers the deepest market, not the first', () => {
    expect(priceAll([mk('shallow', 'G', 'A', 5, 33, 1), mk('deep', 'G', 'A', 4, 98, 1)], 'G').get('A')).toMatchObject({ price: 0.25, depth: 98, route: ['deep'] });
  });
  it('goes through another token when that is deeper, and reports the bottleneck', () => {
    expect(priceAll([mk('direct', 'G', 'A', 10, 1, 1), mk('gb', 'G', 'B', 2, 1000, 1), mk('ba', 'B', 'A', 4, 100, 1)], 'G').get('A')).toMatchObject({ price: 0.125, depth: 50, route: ['gb', 'ba'] });
  });
  it('ignores inactive markets and leaves unreachable tokens out', () => {
    expect([...priceAll([mk('dead', 'G', 'A', 1, 1e9, 1e9, false), mk('island', 'X', 'Y', 1, 1, 1)], 'G').keys()]).toEqual(['G']);
  });
  it('is not fooled by a worthless token minting its own depth', () => {
    const q = priceAll([mk('real', 'G', 'A', 4, 50, 1), mk('fake', 'SCAM', 'A', 1e-9, 1e18, 1)], 'G');
    expect(q.get('A')).toMatchObject({ price: 0.25, route: ['real'] });
  });
  it('still prices a fresh curve nobody has bought from', () => {
    expect(priceAll([mk('curve', 'M', 'G', 0.00009, 0, 0)], 'G').get('M')).toMatchObject({ price: 0.00009, depth: 0 });
  });
  it('drops dead ends but keeps the targets', () => {
    const ms = [{ id: 1, token0: 'G', token1: 'A' }, { id: 2, token0: 'A', token1: 'B' }, { id: 3, token0: 'B', token1: 'G' }, { id: 4, token0: 'X', token1: 'G' }, { id: 5, token0: 'Y', token1: 'X' }];
    expect(relevant(ms, ['G']).map((m) => m.id)).toEqual([1, 2, 3]);
    expect(relevant(ms, ['G', 'Y']).map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('candles', () => {
  const M = 60_000, tr = (t: number, price: number, vol = 1) => ({ t, price, vol });
  it('opens at the previous close and repeats it through quiet periods', () => {
    expect(candles([tr(0, 10), tr(1000, 12), tr(2 * M, 9)], 0, 3 * M, M)).toEqual([
      { t: 0, o: 10, h: 12, l: 10, c: 12, vol: 2, swaps: 2 },
      { t: M, o: 12, h: 12, l: 12, c: 12, vol: 0, swaps: 0 },
      { t: 2 * M, o: 12, h: 12, l: 9, c: 9, vol: 1, swaps: 1 },
    ]);
  });
  it('omits periods before any known price, and uses a seed when there is one', () => {
    expect(candles([tr(M, 5)], 0, 2 * M, M)).toHaveLength(1);
    expect(candles([tr(M, 5)], 0, 2 * M, M, 4).map((c) => c.o)).toEqual([4, 4]);
  });
  it('puts boundary trades in the later candle and drops outsiders', () => {
    const cs = candles([tr(M, 1), tr(2 * M, 9), tr(-1, 9)], 0, 2 * M, M, 1);
    expect(cs.map((c) => c.swaps)).toEqual([0, 1]);
  });
  it('refuses absurd ranges', () => { expect(() => candles([], 0, 1e12, M)).toThrow(/too many/); expect(() => candles([], 5, 5, M)).toThrow(RangeError); });
});

describe('indicators', () => {
  it('averages like a charting tool: plain average first, then exponential', () => {
    expect(ema([1, 2, 3, 4, 5, 9], 3)).toEqual([null, null, 2, 3, 4, 6.5]);
    expect(ema([1, 2], 3)).toEqual([null, null]); expect(ema([], 3)).toEqual([]); expect(ema([5, 7], 1)).toEqual([5, 7]);
    expect(ema(Array(50).fill(0.25), 20).slice(19)).toEqual(Array(31).fill(0.25));
    for (const n of [0, -1, 1.5]) expect(() => ema([1], n)).toThrow(RangeError);
  });
  it('counts each side per candle, and ignores trades of unknown side', () => {
    const s = sides([{ t: 0, price: 1, vol: 2, buy: true }, { t: 99, price: 1, vol: 3, buy: false }, { t: 99, price: 1, vol: 4, buy: true }, { t: 100, price: 1, vol: 5, buy: false }, { t: 150, price: 1, vol: 9 }], 100);
    expect([...s]).toEqual([[0, { buys: 2, sells: 1, bought: 6, sold: 3 }], [100, { buys: 0, sells: 1, bought: 0, sold: 5 }]]);
  });
});

describe('network', () => {
  it('retries server errors, not client errors', async () => {
    let n = 0;
    const flaky = (async () => (++n < 2 ? reply({}, 503) : reply({ ok: 1 }))) as typeof fetch;
    expect(await postJson('https://x.test', {}, { fetch: flaky })).toEqual({ ok: 1 }); expect(n).toBe(2);
    n = 0;
    await expect(postJson('https://x.test', {}, { fetch: (async () => (n++, reply({}, 400))) as typeof fetch })).rejects.toThrow('HTTP 400'); expect(n).toBe(1);
  });
  it('stops on abort', async () => {
    const c = new AbortController(); c.abort();
    await expect(postJson('https://x.test', {}, { signal: c.signal, fetch: (async () => reply({})) as typeof fetch })).rejects.toThrow();
  });
  it('keeps order under concurrency', async () => {
    expect(await mapPool([30, 1, 10], 3, async (d) => { await new Promise((r) => setTimeout(r, d)); return d; })).toEqual([30, 1, 10]);
  });
});

/** Fake chain: one swap per block, configurable row and time limits. */
function fakeIndexer(opts: { blocks: number; maxRange?: number; gap?: (h: number) => number }) {
  const log: string[] = [], time = (h: number) => { let t = 1e12; for (let i = 2; i <= h; i++) t += opts.gap?.(i) ?? 3000; return t; };
  const f = (async (_u: unknown, init: RequestInit) => {
    const { query, variables: v } = JSON.parse(String(init.body)); log.push(query);
    if (query.includes('latestBlockHeight')) return reply({ data: { latestBlockHeight: opts.blocks } });
    if (query.includes('getBlocks')) return reply({ data: Object.fromEntries([...query.matchAll(/b(\d+):getBlocks/g)].map((m) => [m[0].split(':')[0], [{ time: new Date(time(+m[1])).toISOString() }]])) });
    const { gt, lt } = v.where.block_height;
    if (opts.maxRange && lt - gt - 1 > opts.maxRange) return reply({ data: null, errors: [{ message: 'cap', extensions: { code: 'MAX_ELEMENTS_REACHED' } }] });
    const ev = (id: string, h: number, pkg = 'r/real', type = 'Swap') => ({ type, pkg_path: pkg, attrs: [{ key: 'id', value: id }, { key: 'h', value: String(h) }] });
    const txs = []; for (let h = gt + 1; h < Math.min(lt, opts.blocks + 1); h++) txs.push({ block_height: h, response: { events: [ev('P', h), ev('OTHER', h), ev('P', h, 'r/realfake'), ev('P', h, 'r/real', 'Mint')] } });
    return reply({ data: { getTransactions: txs } });
  }) as typeof fetch;
  return { ix: new Indexer('https://i.test', { fetch: f, retries: 0 }), log, time };
}
const F: EventFilter = { types: ['Swap'], pkg: (p) => p === 'r/real', pkgLike: 'r/real', attr: { key: 'id', values: ['P'] } };

describe('indexer', () => {
  it('splits ranges that hit the limit and loses nothing', async () => {
    const { ix, log } = fakeIndexer({ blocks: 100, maxRange: 7 });
    expect((await ix.events(F, 1, 101)).map((s) => s.height)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(log.length).toBeGreaterThan(14);
  });
  it('drops other pools, other types and events forged by other realms', async () => {
    const got = await fakeIndexer({ blocks: 5 }).ix.events(F, 1, 6);
    expect(got).toHaveLength(5); expect(new Set(got.map((e) => e.attrs['id']))).toEqual(new Set(['P']));
  });
  it('fails loudly on other errors', async () => {
    const ix = new Indexer('https://i.test', { retries: 0, fetch: (async () => reply({ errors: [{ message: 'boom' }] })) as typeof fetch });
    await expect(ix.events(F, 1, 10)).rejects.toThrow(IndexerError);
  });
  it('looks block times up once', async () => {
    const { ix, log } = fakeIndexer({ blocks: 500 });
    await ix.blockTimes(Array.from({ length: 250 }, (_, i) => i + 1)); expect(log).toHaveLength(3);
    await ix.blockTimes([1, 2, 250]); expect(log).toHaveLength(3);
  });
  it('finds the exact height, even with a long halt, in few lookups', async () => {
    const { ix, log, time } = fakeIndexer({ blocks: 5000, gap: (h) => (h === 3000 ? 9e6 : 2500 + (h % 7) * 200) });
    for (const h of [1, 2, 1234, 2999, 3000, 3001, 5000]) {
      expect(await ix.heightAt(time(h), 5000)).toBe(h);
      expect(await ix.heightAt(time(h) - 1, 5000)).toBe(h);
    }
    expect(await ix.heightAt(time(5000) + 1, 5000)).toBe(5001);
    expect(log.length).toBeLessThan(7 * 2 * 24);
  });
  it('settles for a slightly earlier height when that is enough', async () => {
    const { ix, log, time } = fakeIndexer({ blocks: 5000, gap: (h) => 2500 + (h % 7) * 200 }), t = time(4000), tol = 6e5;
    const h = await ix.heightAt(t, 5000, tol);
    expect(time(h)).toBeLessThan(t); expect(t - time(h)).toBeLessThanOrEqual(tol); expect(log.length).toBeLessThanOrEqual(3);
  });
});

describe('engine', () => {
  it('reads GNOT as 6 decimals although wugnot registers 0', async () => {
    const e = createEngine({ fetch: (async () => { throw new Error('must not ask the chain'); }) as typeof fetch });
    expect((await e.token(WUGNOT)).decimals).toBe(6);
  });
  it('does not cache failures', async () => {
    let n = 0;
    const e = createEngine({ retries: 0, fetch: (async () => (++n === 1 ? reply({}, 400) : reply({ result: { response: { ResponseBase: { Data: btoa('(6 int)') } } } }))) as typeof fetch });
    await expect(e.token(GNS)).rejects.toThrow('HTTP 400');
    expect((await e.token(GNS)).decimals).toBe(6);
  });
});

describe('gnoswap venue', () => {
  it('accepts the proxy and its versions, nothing that merely starts alike', () => {
    expect(['gno.land/r/gnoswap/pool', 'gno.land/r/gnoswap/pool/v1', 'gno.land/r/gnoswap/pool/v9', 'gno.land/r/gnoswap/poolfake', 'gno.land/r/evil/pool'].map(POOL_CREATED.pkg)).toEqual([true, true, true, false, false]);
  });
  it('reads both sides of a real swap', async () => {
    const id = `${WUGNOT}:${GNOMIC}:10000`;
    const e: ChainEvent = { height: 1814734, type: 'Swap', pkg: 'gno.land/r/gnoswap/pool/v1', attrs: { poolPath: id, sqrtPriceX96: '183212861321984232276593700044', token0Amount: '15000000', token1Amount: '-86354873' } };
    const ctx = { token: async (path: string) => ({ path, realm: '', symbol: '', decimals: 6 }), indexer: { events: async () => [e], lastEventBefore: async () => null, latestHeight: async () => 9e9, eventsAfter: async () => [], recall: async () => undefined, note: async () => undefined }, rpc: { evalInt: async () => 1n } } as unknown as VenueContext;
    const v = gnoswap(ctx, { height: 1, pools: [{ path: id, token0: WUGNOT, token1: GNOMIC, fee: 10000, height: 5, sqrtPriceX96: 1n << 96n }] });
    const [m] = await v.markets(), { fills, seed } = await v.fills(m!, 1_800_000, 1_900_000);
    expect(seed).toBe(1); // never traded before: creation price
    expect(1 / fills[0]!.price).toBeCloseTo(0.18700243, 8);
    expect(fills[0]).toMatchObject({ amount0: 15, amount1: 86.354873, buy: false }); // GNOT went in, GNOMIC came out
  });
});

describe('gnomi venue', () => {
  const ev = gnova.ev as unknown as ChainEvent[], history = parseTradeHistory(gnova.h);
  it('replays a real launch to the exact on-chain reserves', () => {
    const c = newCurve(); ev.forEach((e) => replay(c, e));
    expect([String(c.u), String(c.t)]).toEqual(gnova.info);
    expect(spotScaled(c)).toBe(history.at(-1)!.scaled);
  });
  it('trusts the replay only if every remembered price agrees', () => {
    expect(reconcile(ev, history, 1e9)).toMatchObject({ trusted: true, partial: false });
    const off = history.map((h, i) => (i === history.length - 1 ? { ...h, scaled: h.scaled + 1n } : h));
    const bad = reconcile(ev, off, 1e9);
    expect(bad.trusted).toBe(false); expect(bad.points.at(-1)!.scaled).toBe(off.at(-1)!.scaled);
  });
  it('tolerates the RPC being ahead of the indexer', () => {
    const last = ev.at(-1)!.height;
    expect(reconcile(ev.slice(0, -1), history, last - 1).trusted).toBe(true);
    expect(reconcile(ev.slice(0, -1), history, last).trusted).toBe(false);
  });
  it('says so when only the ring buffer is left', () => {
    const full = Array.from({ length: 128 }, (_, i) => ({ height: i, side: 0, ugnot: 1n, tokens: 1n, scaled: 5n }));
    expect(reconcile([], full, 1e9)).toMatchObject({ trusted: false, partial: true });
  });
  it('follows graduation into the constant-product pool', () => {
    const c = newCurve(), e = (type: string, a: Record<string, string>): ChainEvent => ({ height: 1, type, pkg: 'p', attrs: a });
    replay(c, e('Graduated', { poolUgnot: '1000000000', poolToken: '1000000' }));
    expect(spotScaled(c)).toBe(1_000_000_000n);
    replay(c, e('SwapBuy', { ugnot: '1000000', tokens: '987' }));
    expect(c).toMatchObject({ u: 1_000_990_400n, t: 999_013n }); // 1.2% fee, a fifth of it stays in the pool
    replay(c, e('SwapSell', { ugnot: '1', tokens: '987' }));
    expect(c.t).toBe(1_000_000n); expect(c.u).toBe(1_000_990_400n - 987_977n + 11_855n);
  });
  it('rejects anything but the contract format', () => expect(() => parseTradeHistory('1|0|5|5|9\nX|SCAM|1')).toThrow());
  it('skips launches whose symbol is not a plain token of that pad', async () => {
    const pad = 'gno.land/r/x/pad', paths: Record<string, string> = { a1: `${pad}.OK`, a2: `${pad}.A")+Evil("`, a3: 'gno.land/r/gnoswap/gns.GNS' };
    const ctx = { rpc: { evalString: async (x: string) => (x.endsWith('ListIDs()') ? 'a1\na2\na3\n")+Evil("' : x.includes('TradeHistory') ? Promise.reject(new Error('unreadable')) : paths[/"(.*)"/.exec(x)![1]!]) } } as unknown as VenueContext;
    expect((await gnomi(ctx, [pad]).markets()).map((m) => m.token0)).toEqual([`${pad}.OK`]);
  });
});

describe('gnomi polling', () => {
  it('names the launches that traded, across pads, in one query', async () => {
    let n = 0;
    const OWN = 'gno.land/r/g1n4pl5uc4yt5r96m9w6fmdznx3x0jyg8l6arhmt/gnomi/';
    const ctx = { indexer: { events: async (f: EventFilter) => { n++; return [['padv3', '1'], ['padv2', '1'], ['padv3', '1'], ['padv9', '1']].map(([p, id]) => ({ height: 1, type: 'Buy', pkg: OWN + p, attrs: { id: id! } })).filter((e) => f.pkg(e.pkg)); } } } as unknown as VenueContext;
    expect(await gnomi(ctx).touched(1, 2)).toEqual([OWN + 'padv3:1', OWN + 'padv2:1']); expect(n).toBe(1);
  });
});

describe('venues together', () => {
  const A = 'gno.land/r/t/a.A';
  const fake = (id: string, o: Partial<Venue> & { price?: number; depth?: number } = {}): VenueFactory => () => ({
    id, label: id, markets: async () => [{ venue: id, id: 'm', token0: A, token1: WUGNOT, feePct: 1, height: 1 } satisfies Market],
    state: async () => ({ price: o.price ?? 1, balance0: 0, balance1: o.depth ?? 1, active: true }), fills: async () => ({ fills: [] }), recent: async () => new Map(), peek: async () => null, mine: async () => [], touched: async () => [], ...o,
  });
  const registry = (async () => reply({ result: { response: { ResponseBase: { Data: btoa('(6 int)') } } } })) as typeof fetch;
  it('compares the same token across venues and prices it at the deepest', async () => {
    const p = await createEngine({ fetch: registry, venues: [fake('dex', { price: 2, depth: 5 }), fake('pad', { price: 3, depth: 50 })] }).prices('gno.land/r/t/a');
    expect(p.tokens[0]).toMatchObject({ priceGnot: 3, depthGnot: 50, route: ['pad|m'] });
    expect(p.tokens[0]!.markets.map((m) => m.venue)).toEqual(['pad', 'dex']); expect(p.unavailable).toEqual([]);
  });
  it('keeps working when a venue is down, and says which one', async () => {
    const p = await createEngine({ fetch: registry, venues: [fake('ok'), fake('down', { markets: async () => { throw new Error('offline'); } })] }).prices('gno.land/r/t/a');
    expect(p.tokens).toHaveLength(1); expect(p.unavailable).toEqual([{ source: 'down', reason: 'offline' }]);
  });
  it('reports a single unreadable market', async () => {
    const p = await createEngine({ fetch: registry, venues: [fake('ok'), fake('bad', { state: async () => { throw new Error('boom'); } })] }).prices('gno.land/r/t/a');
    expect(p.tokens[0]!.markets).toHaveLength(1); expect(p.unavailable[0]).toMatchObject({ source: 'bad A/wugnot', reason: 'boom' });
  });
  it('does not claim a token is untraded when a venue could not be checked', async () => {
    await expect(createEngine({ fetch: registry, venues: [fake('ok'), fake('down', { markets: async () => { throw new Error('x'); } })] }).prices('gno.land/r/t/zzz')).rejects.toThrow('Could not check down');
  });
  it('fails when every venue is down', async () => {
    await expect(createEngine({ venues: [fake('d', { markets: async () => { throw new Error('offline'); } })] }).prices('gno.land/r/t/a')).rejects.toThrow('offline');
  });
});

describe('rpc batching', () => {
  const server = (handle: (path: string) => unknown, log: number[] = []) => (async (_u: unknown, init: RequestInit) => {
    const b = JSON.parse(String(init.body)), list = Array.isArray(b) ? b : [b]; log.push(list.length);
    const out = list.map((r: { id: number; params: { data: string } }) => ({ id: r.id, result: { response: { ResponseBase: handle(atob(r.params.data)) } } })).reverse(); // order is not guaranteed
    return reply(Array.isArray(b) ? out : out[0]);
  }) as typeof fetch;
  it('shares requests and matches replies by id', async () => {
    const log: number[] = [], r = new Rpc('https://r.test', { fetch: server((x) => ({ Data: btoa(`(${x} int)`) }), log) });
    const got = await Promise.all(Array.from({ length: 90 }, (_, i) => r.evalInt(String(i))));
    expect(got).toEqual(Array.from({ length: 90 }, (_, i) => BigInt(i))); expect(log).toEqual([40, 40, 10]);
  });
  it('fails only the call that failed', async () => {
    const r = new Rpc('https://r.test', { fetch: server((x) => (x === 'bad' ? { Error: 'no' } : { Data: btoa('(1 int)') })) });
    const got = await Promise.allSettled([r.evalInt('a'), r.evalInt('bad'), r.evalInt('c')]);
    expect(got.map((g) => g.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('overview', () => {
  const A = 'gno.land/r/t/a.A', B = 'gno.land/r/t/b.B', H = 36e5, now = 100 * H;
  const live = (key: string, token0: string, token1: string, price: number, balance0: number, balance1: number): LiveMarket => ({ key, token0, token1, price, balance0, balance1, active: true, venue: 'V', m: { venue: 'v', id: key, token0, token1, feePct: 1, height: 1 } });
  const tok = (path: string) => ({ path, realm: path.slice(0, -2), symbol: path.slice(-1), decimals: 6 });
  const snap = (markets: LiveMarket[]): Snapshot => ({ markets, tokens: new Map([A, B, WUGNOT].map((p) => [p, tok(p)])), supply: new Map([[A, { supply: 1000, accounts: 7 }]]), created: new Map([['ag', 5]]), height: 9, at: now, unavailable: [] });
  const act = (fills: Activity['fills'], times: [number, number][], span = 24 * H): Activity => ({ span, fills, times: new Map(times) });
  const AG = live('ag', A, WUGNOT, 2, 10, 50), BA = live('ba', B, A, 3, 10, 20);

  it('follows a price back through its trades', () => {
    const a = act(new Map([['ag', { seed: 1, fills: [{ height: 1, price: 1.5, amount0: 0, amount1: 0, buy: true }, { height: 2, price: 2, amount0: 0, amount1: 0, buy: true }] }]]), [[1, 10], [2, 20]]);
    expect([5, 15, 25].map((t) => priceAt(AG, a, t))).toEqual([1, 1.5, 2]);
    expect(priceAt(BA, a, 5)).toBeNull(); // never read
    expect(priceAt(BA, act(new Map([['ba', { fills: [] }]]), []), 5)).toBe(3); // read, did not trade
  });
  it('computes change and volume along the route', () => {
    const a = act(new Map([['ag', { seed: 1, fills: [{ height: 1, price: 2, amount0: 4, amount1: 6, buy: true }] }], ['ba', { seed: 3, fills: [] }]]), [[1, now - H]]);
    const o = summarize(snap([AG, BA]), a, 24 * H, now), row = (p: string) => o.rows.find((r) => r.token.path === p)!;
    expect(row(A)).toMatchObject({ price: 2, change: 100, volume: 6, trades: 1, marketCap: 2000, accounts: 7, created: 5 });
    expect(row(B)).toMatchObject({ price: 6, change: 100, volume: 0, trades: 0, marketCap: null }); // moved because A did
    expect(o).toMatchObject({ volume: 6, trades: 1, locked: 50 });
  });
  it('tells one token\'s story from its own side', () => {
    const a = act(new Map([['ag', { seed: 1, fills: [{ height: 1, price: 2, amount0: 4, amount1: 6, buy: true }] }], ['ba', { seed: 3, fills: [{ height: 2, price: 3, amount0: 5, amount1: 15, buy: true }] }]]), [[1, now - H], [2, now - 30 * H]]);
    const d = detail(snap([AG, BA]), a, A, 24 * H, now)!;
    expect(d.markets.map((m) => [m.key, m.main, m.pairedWith])).toEqual([['ag', true, WUGNOT], ['ba', false, B]]);
    expect(d.markets[0]).toMatchObject({ price: 2, priceGnot: 2, depthGnot: 50, gap: 0, volume: 6, trades: 1 });
    expect(d.markets[1]!.trades).toBe(0); // its only trade is older than the window, but still listed
    expect(d.trades).toEqual([
      expect.objectContaining({ market: 'ba', buy: false, amount: 15, price: 1 / 3 }), // buying B sells A
      expect.objectContaining({ market: 'ag', buy: true, amount: 4, priceGnot: 2, valueGnot: 6 }),
    ]);
    expect(detail(snap([AG]), a, 'gno.land/r/t/z.Z', H, now)).toBeNull();
  });
  it('leaves trades outside the window out', () => {
    const a = act(new Map([['ag', { seed: 1, fills: [{ height: 1, price: 2, amount0: 4, amount1: 6, buy: true }] }]]), [[1, now - 5 * H]]);
    expect(summarize(snap([AG]), a, H, now).rows[0]).toMatchObject({ change: 0, volume: 0, trades: 0 });
  });
  it('shows unknown, never zero, when activity was not read', () => {
    for (const a of [null, act(new Map(), []), act(new Map([['ag', { fills: [] }]]), [], H)]) expect(summarize(snap([AG]), a, 24 * H, now).rows[0]).toMatchObject({ price: 2, change: null, volume: null, trades: null });
  });
  it('gives no change to a market younger than the window', () => {
    const a = act(new Map([['ag', { fills: [{ height: 1, price: 2, amount0: 1, amount1: 2, buy: true }] }]]), [[1, now - H]]);
    expect(summarize(snap([AG]), a, 24 * H, now).rows[0]).toMatchObject({ change: null, volume: 2 });
  });
  it('sorts and filters the tabs', () => {
    const r = (s: string, o: Partial<Row>): Row => ({ token: tok(`gno.land/r/t/${s}.${s.toUpperCase()}`), price: 1, depth: 1, venue: '', feePct: 1, quote: WUGNOT, marketCap: null, accounts: null, created: null, change: null, volume: null, trades: null, partial: false, markets: [], venues: ['Gnoswap'], ...o });
    const rows = [r('a', { change: 5, volume: 10, trades: 1, created: 1 }), r('b', { change: -3, volume: 90, trades: 2, created: 3 }), r('c', { change: 0.001, volume: 0, trades: 0, depth: 99 }), r('d', {})];
    const ids = (...x: Parameters<typeof pick>) => pick(...x).map((y) => y.token.symbol).join('');
    expect([ids(rows, 'trending'), ids(rows, 'gainers'), ids(rows, 'losers'), ids(rows, 'new').slice(0, 2), ids(rows, 'volume')]).toEqual(['BACD', 'A', 'B', 'BA', 'BACD']);
    expect(ids(rows, 'trending', ' https://gno.land/r/t/C ')).toBe('C');
    rows[1]!.venues = ['Gnoswap', 'Gnomi']; rows[3]!.venues = ['Gnomi'];
    expect([ids(rows, 'trending', '', 'Gnomi'), ids(rows, 'trending', '', 'Gnoswap'), ids(rows, 'trending', '', '')]).toEqual(['BD', 'BAC', 'BACD']);
  });
});

describe('format', () => {
  it('prices', () => expect([1234.5, 10.11796, 0.18700243, 0.00013007, 0.0000956192, 0.00000999996, 0, null].map(fmtPrice)).toEqual(['1,235', '10.118', '0.18700', '0.0₃1301', '0.0₄9562', '0.0₄1000', '0', 'n/a']));
  it('amounts', () => expect([0, 0.01, 0.5, 99.9, 1234, 99_960, 999_600, 34_945_640, null].map(amount)).toEqual(['0', '<0.1', '0.5', '99.9', '1.2K', '100K', '1.00M', '34.95M', 'n/a']));
  it('changes and ages', () => {
    expect([10.327, -0.044, 0.001, -1500, null].map(pct)).toEqual(['+10.3%', '−0.04%', '0.00%', '−1,500%', 'n/a']);
    expect([age(null, 0), age(0, 9e5), age(0, 36e5 * 30), age(0, 864e5 * 5)]).toEqual(['n/a', '15m', '30h', '5d']);
  });
  it('escapes markup', () => expect(esc('<b onx="1">&\'')).not.toMatch(/[<>"']/));
});

describe('transaction encoding', () => {
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64'), un = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
  it('matches the official client byte for byte', () => {
    expect(b64(encodeTx(txFix.msgs as Call[], 230_000_000, 230_000, un(txFix.pub)))).toBe(txFix.tx);
  });
  it('reads results', () => {
    expect(decodeResult(un(txFix.ok))).toMatchObject({ ok: true, gasUsed: 180013348, data: '("1" string)' });
    expect(decodeResult(un(txFix.bad))).toMatchObject({ ok: false, error: 'insufficient allowance', gasUsed: 7 });
  });
  it('reads a real mainnet dry run and nets its storage deposit', () => {
    const r = decodeResult(un(simOk.raw));
    expect(r).toMatchObject({ ok: true, deposit: 216800 - 217500 - 209100 - 700 + 1457300 + 206700 });
    expect(r.gasUsed).toBeGreaterThan(160_000_000); expect(r.data).toContain('5273410');
  });
  it('refuses truncated bytes', () => expect(() => decodeResult(un(txFix.ok).subarray(0, 9))).toThrow());
});

describe('trading', () => {
  const me = 'g1vc883gshu5z7ytk5cdynhc8c2dh67pdp4cszkp', id = `${WUGNOT}:${GNOMIC}:10000`, pool = { id, token0: WUGNOT, token1: GNOMIC };
  const buy: Order = { pool, input: WUGNOT, output: GNOMIC, amountIn: 15_000_000n }, sell: Order = { pool, input: GNOMIC, output: WUGNOT, amountIn: 7n };
  const base = { caller: me, min: 5n, deadline: 123, style: 'plain' as const, wrapped: 0n };

  it('parses amounts exactly and refuses anything lossy', () => {
    expect(['1', '0.000001', '1,5', '.5', '5.', '1.0000000', '9007199254.740993'].map((x) => parseAmount(x, 6))).toEqual([1000000n, 1n, 1500000n, 500000n, 5000000n, 1000000n, 9007199254740993n]);
    expect(['', '.', '-1', '1e5', '0x1', '1.0000001', 'abc', '1 2', '99999999999999999999'].map((x) => parseAmount(x, 6))).toEqual(Array(9).fill(null));
    expect([parseAmount('12', 0), parseAmount('1.5', 0)]).toEqual([12n, null]);
  });
  it('prints amounts', () => expect([formatAmount(1234567890n, 6), formatAmount(1n, 6), formatAmount(0n, 6), formatAmount(1234567n, 0), formatAmount(1999999n, 6, 2)]).toEqual(['1,234.56789', '0.000001', '0', '1,234,567', '1.99']));
  it('rounds the minimum down, never to zero', () => expect([minOut(1000n, 100), minOut(999n, 50), minOut(1n, 300), minOut(5273410n, 100)]).toEqual([990n, 994n, 1n, 5220675n]));

  it('routes only through the chosen pool, in the right direction', () => {
    expect(routeOf(buy)).toBe(`${WUGNOT}:${GNOMIC}:10000`); expect(routeOf(sell)).toBe(`${GNOMIC}:${WUGNOT}:10000`);
    expect(() => routeOf({ ...buy, output: GNS })).toThrow(InputError);
    expect(() => routeOf({ ...buy, input: GNOMIC })).toThrow(InputError);
  });
  it('builds the sequence real swaps use', () => {
    const p = plan(buy, base);
    expect(p.wrap).toBe(15_000_000n);
    expect(p.calls.map((c) => [c.pkg_path, c.func, c.send, c.args])).toEqual([
      ['gno.land/r/gnoland/wugnot', 'Approve', '', [ROUTER_ADDRESS, '15000000']],
      ['gno.land/r/gnoland/wugnot', 'Deposit', '15000000ugnot', []],
      ['gno.land/r/gnoswap/router', 'ExactInSwapRoute', '', [WUGNOT, GNOMIC, '15000000', `${WUGNOT}:${GNOMIC}:10000`, '100', '5', '123', '']],
    ]);
    expect(p.calls.every((c) => c.caller === me && c.max_deposit === '5000000ugnot')).toBe(true);
  });
  it('wraps only what is missing', () => {
    expect(plan(buy, { ...base, wrapped: 15_000_000n }).calls.map((c) => c.func)).toEqual(['Approve', 'ExactInSwapRoute']);
    expect(plan(buy, { ...base, wrapped: 5_000_000n }).wrap).toBe(10_000_000n);
    expect(plan(buy, { ...base, wrapped: 14_999_999n }).wrap).toBe(1000n); // the contract's minimum
    expect(plan(sell, base).calls.map((c) => [c.pkg_path, c.func])).toEqual([['gno.land/r/nym-thegnomic001/gnomic', 'Approve'], ['gno.land/r/gnoswap/router', 'ExactInSwapRoute']]);
  });
  it('approves factory tokens by symbol', () => {
    const P = 'gno.land/r/demo/defi/grc20factory.PERUN', o: Order = { pool: { id: `${P}:${WUGNOT}:10000`, token0: P, token1: WUGNOT }, input: P, output: WUGNOT, amountIn: 9n };
    expect(plan(o, { ...base, style: 'symbol' }).calls[0]).toMatchObject({ pkg_path: 'gno.land/r/demo/defi/grc20factory', func: 'Approve', args: ['PERUN', ROUTER_ADDRESS, '9'] });
  });
  it('refuses bad callers and amounts', () => {
    for (const x of [{ ...base, caller: 'g1evil' }, { ...base, min: 0n }]) expect(() => plan(buy, x)).toThrow(InputError);
    for (const amountIn of [0n, -1n, 2n ** 63n]) expect(() => plan({ ...buy, amountIn }, base)).toThrow(InputError);
    expect([isAddress(me), isAddress(me + 'a'), isAddress('g1")'), isAddress('cosmos1abc')]).toEqual([true, false, false, false]);
  });
  it('recognises only the approve signatures it knows', () => {
    const f = (...p: [string, string][]) => [{ FuncName: 'Approve', Params: [['cur', 'realm'], ...p].map(([Name, Type]) => ({ Name: Name!, Type: Type! })) }];
    expect(approveStyle(f(['spender', 'string'], ['amount', 'int64']))).toBe('plain');
    expect(approveStyle(f(['symbol', 'string'], ['spender', 'string'], ['amount', 'int64']))).toBe('symbol');
    expect(approveStyle(f(['amount', 'int64'], ['spender', 'string']))).toBeNull();
    expect(approveStyle(f(['id', 'string'], ['spender', 'string'], ['amount', 'int64']))).toBeNull();
    expect(approveStyle(f(['spender', 'string'], ['amount', 'uint64']))).toBeNull();
    expect(approveStyle([])).toBeNull();
  });
  it('knows what vesting still locks', () => {
    const v = { original_vesting: '47272388974ugnot', start_time: '1789225200', end_time: '1852383600' };
    expect([0, 1789225200, 1852383600, 9e9].map((t) => lockedCoins(v, t))).toEqual([47272388974n, 47272388974n, 0n, 0n]);
    expect(Number(lockedCoins(v, (1789225200 + 1852383600) / 2))).toBeCloseTo(47272388974 / 2, -1);
    expect([lockedCoins(undefined, 1), lockedCoins({ original_vesting: 'x' }, 1)]).toEqual([0n, 0n]);
  });
  it('measures the real cost of a trade against spot', () => {
    expect(costOf({ amountIn: 500_000000n, amountOut: 621_040004n }, 1 / 0.18700243, 6, 6)).toBeCloseTo(0.7677, 3);
    expect(costOf({ amountIn: 1_000000n, amountOut: 5_273410n }, 1 / 0.18700243, 6, 6)).toBeCloseTo(0.0139, 3);
  });
  it('explains failures seen on mainnet', () => {
    expect(explain('storage deposit processing encountered one or more errors: lockStorageDeposit failed for realm x: vesting locked coins error')).toMatch(/vesting/);
    expect(explain('[GNOSWAP-ROUTER-001] slippage check failed || ExactIn: too few received')).toMatch(/slippage limit/);
    expect(explain('[GNOSWAP-ROUTER-018] insufficient balance for swap')).toMatch(/balance is too low/);
    expect(explain('[GNOSWAP-ROUTER-003] transaction expired')).toMatch(/expired/);
    expect(explain('odd')).toContain('odd');
  });
  it('accepts a quote only when the whole amount would be filled', async () => {
    const t = (reply: string) => createTrader({ rpc: { query: async () => reply }, indexer: {} } as unknown as Engine).quote(buy);
    expect(await t('("15000000" string)\n("79000000" string)\n(undefined)')).toEqual({ amountIn: 15_000_000n, amountOut: 79_000_000n });
    for (const bad of ['("14000000" string)\n("79000000" string)\n(undefined)', '("15000000" string)\n("0" string)\n(undefined)', '("0" string)\n("0" string)\n(&(struct{...}))', '']) await expect(t(bad)).rejects.toThrow('cannot fill');
  });
});

describe('ranges', () => {
  it('merges, and finds what is missing', () => {
    let r: Range[] = [];
    for (const x of [[10, 20], [30, 40], [20, 25], [5, 6], [39, 50], [7, 7]] as Range[]) r = ranges.add(r, x);
    expect(r).toEqual([[5, 6], [10, 25], [30, 50]]);
    expect(ranges.gaps(r, 0, 60)).toEqual([[0, 5], [6, 10], [25, 30], [50, 60]]);
    expect([ranges.gaps(r, 12, 20), ranges.gaps(r, 22, 32), ranges.gaps([], 1, 3), ranges.gaps(r, 50, 50)]).toEqual([[], [[25, 30]], [[1, 3]], []]);
    expect(ranges.coalesce([[0, 5], [6, 10], [25, 30], [500, 600]], 20)).toEqual([[0, 30], [500, 600]]);
    expect(ranges.union([[1, 3]], [[3, 5], [9, 10]])).toEqual([[1, 5], [9, 10]]);
  });
  it('agrees with a brute-force model', () => {
    let seed = 7; const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let round = 0; round < 60; round++) {
      let r: Range[] = []; const model = new Set<number>();
      for (let i = 0; i < 8; i++) { const a = rnd(60), b = a + rnd(15); r = ranges.add(r, [a, b]); for (let x = a; x < b; x++) model.add(x); }
      const covered = (x: number) => r.some(([p, q]) => x >= p && x < q), gap = ranges.gaps(r, 5, 70), inGap = (x: number) => gap.some(([p, q]) => x >= p && x < q);
      for (let x = 0; x < 80; x++) { expect(covered(x)).toBe(model.has(x)); expect(inGap(x)).toBe(x >= 5 && x < 70 && !model.has(x)); }
    }
  });
});

describe('history cache', () => {
  /** Chain where pool P trades every 3rd block (twice) and Q every 5th. */
  function chain(o: { latest?: number } = {}) {
    const asked: [string, number, number][] = [], st = { latest: o.latest ?? 1000, lie: false };
    const at = (h: number) => [...(h % 3 === 0 ? ['P', 'P'] : []), ...(h % 5 === 0 ? ['Q'] : [])];
    const f = (async (_u: unknown, init: RequestInit) => {
      const { query, variables: v } = JSON.parse(String(init.body));
      if (query.includes('latestBlockHeight')) return reply({ data: { latestBlockHeight: st.latest } });
      if (query.includes('getBlocks')) { asked.push(['times', 0, (query.match(/getBlocks/g) ?? []).length]); return reply({ data: Object.fromEntries([...query.matchAll(/b(\d+):/g)].map((m: RegExpMatchArray) => ['b' + m[1], [{ time: new Date(1e12 + +m[1]! * 3000).toISOString() }]])) }); }
      const w = v.where, gt = w.block_height.gt ?? 0, lt = Math.min(w.block_height.lt ?? Infinity, st.latest + 1), only = w.response.events.GnoEvent.attrs?._and[1]._or[0].value.eq;
      asked.push([only ?? ALL, gt + 1, lt]);
      const txs = [];
      for (let h = gt + 1; h < lt; h++) { const ev = at(h).map((p, i) => ({ type: 'Swap', pkg_path: 'r/real', attrs: [{ key: 'id', value: p }, { key: 'x', value: `${h}.${i}` }, { key: 'junk', value: 'z' }] })); if (ev.length && (!only || at(h).includes(only))) txs.push({ block_height: h, response: { events: ev } }); }
      if (v.order.heightAndIndex === 'DESC') txs.reverse();
      return reply({ data: { getTransactions: v.limit ? txs.slice(0, v.limit) : txs } });
    }) as typeof fetch;
    return { f, asked, st };
  }
  const groupOf = (e: ChainEvent) => e.attrs['id'] ?? '', base = { types: ['Swap'], pkg: (p: string) => p === 'r/real', pkgLike: 'r/real' };
  const one = (g: string): EventFilter => ({ ...base, attr: { key: 'id', values: [g] }, cache: { stream: 's', group: g, groupOf, keep: ['id', 'x'] } });
  const all: EventFilter = { ...base, cache: { stream: 's', group: null, groupOf, keep: ['id', 'x'] } };
  const db = () => new IDBFactory(), make = (c: ReturnType<typeof chain>, factory: IDBFactory) => new Indexer('https://i.test', { fetch: c.f, retries: 0 }, indexedDbStore('test', factory));
  const sig = (l: ChainEvent[]) => l.map((e) => `${e.height}:${e.attrs['id']}:${e.attrs['x']}`), plain = (c: ReturnType<typeof chain>) => new Indexer('https://i.test', { fetch: c.f, retries: 0 });

  it('never asks twice for the same blocks, even on another visit', async () => {
    const c = chain(), d = db(), first = await make(c, d).events(one('P'), 100, 400);
    c.asked.length = 0;
    const again = await make(c, d).events(one('P'), 100, 400);
    expect(c.asked).toEqual([]); expect(sig(again)).toEqual(sig(first)); expect(first.length).toBeGreaterThan(100);
    expect(again[0]!.attrs).toEqual({ id: 'P', x: '102.0' }); // only what is needed is kept
  });
  it('asks only for the gap when the range grows', async () => {
    const c = chain(), ix = make(c, db());
    await ix.events(one('P'), 200, 300); c.asked.length = 0;
    const got = await ix.events(one('P'), 100, 300);
    expect(c.asked).toEqual([['P', 100, 200]]); expect(sig(got)).toEqual(sig(await plain(chain()).events(one('P'), 100, 300)));
  });
  it('lets a whole-stream read serve every pool, and not the other way round', async () => {
    const c = chain(), ix = make(c, db());
    await ix.events(all, 100, 300); c.asked.length = 0;
    expect(sig(await ix.events(one('Q'), 120, 280))).toEqual(sig(await plain(chain()).events(one('Q'), 120, 280)));
    expect(c.asked.filter((a) => a[0] !== 'times')).toEqual([]);
    await ix.events(one('P'), 300, 400); c.asked.length = 0;
    await ix.events(one('Q'), 300, 400); expect(c.asked).toEqual([['Q', 300, 400]]);
    c.asked.length = 0; await ix.events(all, 300, 400); expect(c.asked).toEqual([[ALL, 300, 400]]);
  });
  it('gives exactly what the chain gives, whatever the order of reads', async () => {
    let seed = 3; const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const c = chain(), d = db(), truth = plain(chain());
    for (let i = 0; i < 40; i++) {
      const ix = make(c, d), a = 1 + rnd(900), b = a + rnd(300), g = rnd(3), f = g === 0 ? all : one(g === 1 ? 'P' : 'Q');
      expect(sig(await ix.events(f, a, b)).sort()).toEqual(sig(await truth.events(f, a, b)).sort());
    }
  });
  it('keeps the order of trades inside a block', async () => {
    const c = chain(), d = db();
    await make(c, d).events(one('P'), 1, 50);
    expect(sig(await make(c, d).events(one('P'), 3, 4))).toEqual(['3:P:3.0', '3:P:3.1']);
  });
  it('does not vouch for the newest blocks', async () => {
    const c = chain({ latest: 500 }), d = db();
    await make(c, d).events(one('P'), 400, 501);
    c.st.latest = 520; c.asked.length = 0;
    const got = await make(c, d).events(one('P'), 400, 521);
    expect(c.asked).toEqual([['P', 500 - TAIL, 521]]); expect(sig(got)).toEqual(sig(await plain(chain({ latest: 520 })).events(one('P'), 400, 521)));
  });
  it('reads a stream once when two parts of the page ask together', async () => {
    const c = chain(), ix = make(c, db());
    const [x, y] = await Promise.all([ix.events(one('P'), 100, 300), ix.events(one('P'), 150, 300)]);
    expect(c.asked.filter((a) => a[0] === 'P')).toEqual([['P', 100, 300]]); expect(y.length).toBeLessThan(x.length);
  });
  it('finds the previous trade without asking, once the silence is known', async () => {
    const c = chain(), d = db(), want = await plain(chain()).lastEventBefore(one('P'), 305);
    expect(sig([(await make(c, d).lastEventBefore(one('P'), 305))!])).toEqual(sig([want!])); expect(sig([want!])).toEqual(['303:P:303.1']);
    c.asked.length = 0;
    expect(sig([(await make(c, d).lastEventBefore(one('P'), 305))!])).toEqual(['303:P:303.1']); expect(c.asked).toEqual([]);
  });
  it('remembers block times, and uses them to place a date', async () => {
    const c = chain(), d = db(), t = 1e12 + 600 * 3000;
    expect(await make(c, d).heightAt(t, 1000)).toBe(600); c.asked.length = 0;
    expect(await make(c, d).heightAt(t, 1000)).toBe(600); expect(c.asked).toEqual([]);
  });
  it('forgets one pool without trusting the whole-stream record for it', async () => {
    const c = chain(), ix = make(c, db());
    await ix.events(all, 100, 200); await ix.forget('s', 'P'); c.asked.length = 0;
    expect(sig(await ix.events(one('P'), 100, 200))).toEqual(sig(await plain(chain()).events(one('P'), 100, 200)));
    expect(c.asked).toEqual([['P', 100, 200]]);
  });
  it('commits events and their coverage together or not at all', async () => {
    const d = db(), s = indexedDbStore('test', d);
    await expect(s.commit('s', 'P', [1, 9], [{ group: 'P', seq: 0, event: { height: 1, type: 't', pkg: 'p', attrs: { f: (() => 1) as unknown as string } } }])).rejects.toThrow();
    expect(await s.coverage('s', 'P')).toEqual([]); expect(await s.events('s', 'P', 0, 99)).toEqual([]);
  });
  it('carries on without storage when it breaks', async () => {
    const broken = new Proxy({}, { get: () => async () => { throw new Error('quota'); } }) as Store, c = chain();
    const ix = new Indexer('https://i.test', { fetch: c.f, retries: 0 }, broken);
    expect(sig(await ix.events(one('P'), 10, 40))).toEqual(sig(await plain(chain()).events(one('P'), 10, 40)));
    expect((await ix.blockTimes([5])).get(5)).toBe(1e12 + 15000);
  });
  it('keeps chains apart, and clears', async () => {
    const d = db(), a = indexedDbStore('one', d), b = indexedDbStore('two', d);
    await a.put('k', { n: 1n }); expect(await b.get('k')).toBeUndefined(); expect(await a.get('k')).toEqual({ n: 1n });
    await a.commit('s', 'P', [1, 5], []); await a.clear(); expect([await a.get('k'), await a.coverage('s', 'P')]).toEqual([undefined, []]);
  });
  it('does not remember a failed read as covered', async () => {
    const c = chain(), d = db(); let fail = true;
    const ix = new Indexer('https://i.test', { retries: 0, fetch: (async (u: RequestInfo, i?: RequestInit) => (fail && String(i?.body).includes('getTransactions') ? reply({ errors: [{ message: 'boom' }] }) : c.f(u, i))) as typeof fetch }, indexedDbStore('test', d));
    await expect(ix.events(one('P'), 10, 40)).rejects.toThrow('boom');
    fail = false; expect((await ix.events(one('P'), 10, 40)).length).toBeGreaterThan(0);
  });
});

describe('published history', () => {
  const POOL_A = 'gno.land/r/a/a.A:gno.land/r/gnoland/wugnot.wugnot:3000', copy = () => JSON.parse(JSON.stringify(golden));
  it('reads the file the Go service writes', () => {
    const d = decodeHistory(golden, 'gnoland-1', HISTORY), sw = d.streams.get('gnoswap:swap')!, tr = d.streams.get('gnomi:trade')!;
    expect([d.height, sw.length, tr.length]).toEqual([120, 11, 4]);
    expect(sw[0]).toEqual({ group: POOL_A, seq: 0, event: { height: 10, type: 'Swap', pkg: 'gno.land/r/gnoswap/pool/v1', attrs: { poolPath: POOL_A, sqrtPriceX96: '1000010', token0Amount: '7', token1Amount: '-3', '@tx': 'tx10=', '@by': 'g1caller' } } });
    expect(tr.at(-1)).toMatchObject({ event: { height: 100, type: 'Buy', attrs: { id: '1', ugnot: '9', tokens: '8', '@tx': 'tx100=', '@by': 'g1caller' } } });
    expect(new Map(d.times).get(10)).toBe(1e12 + 30_000);
  });
  it('refuses damage instead of believing it', () => {
    const bad: [string, (f: any) => void][] = [
      ['version', (f) => { f.v = 2; }], ['chain', (f) => { f.chain = 'onyx-1'; }], ['height', (f) => { f.height = 1.5; }],
      ['index', (f) => { f.streams['gnoswap:swap'].rows[0][1] = 9; }], ['negative', (f) => { f.streams['gnoswap:swap'].rows[0][0] = -1; }],
      ['beyond', (f) => { f.streams['gnoswap:swap'].rows[0][0] = 500; }], ['value', (f) => { f.streams['gnoswap:swap'].rows[0][5] = 7; }],
      ['long', (f) => { f.streams['gnoswap:swap'].rows[0].push('x', 'y'); }], ['time', (f) => { f.times[0][0] = 'x'; }],
    ];
    for (const [name, spoil] of bad) { const f = copy(); spoil(f); expect(() => decodeHistory(f, 'gnoland-1', HISTORY), name).toThrow('history file'); }
    for (const m of [null, {}, { v: 1, chain: 'gnoland-1', height: 5, file: '../x.json' }, { v: 1, chain: 'x', height: 5, file: 'history-5.json' }]) expect(() => checkManifest(m, 'gnoland-1')).toThrow();
    expect(checkManifest({ v: 1, chain: 'gnoland-1', height: 5, file: 'history-5.json', bytes: 1 }, 'gnoland-1').height).toBe(5);
  });
  it('does not let a file vouch for realms or fields it never read', () => {
    const f = copy(); f.streams['gnomi:trade'].realms.pop(); f.streams['gnoswap:swap'].keep[3] = 'other';
    expect(decodeHistory(f, 'gnoland-1', HISTORY).streams.size).toBe(0);
  });
  it('is downloaded only when much is missing', async () => {
    const s = memoryStore(), e: Expected[] = [{ stream: 's', keep: [], realms: [] }];
    expect(await isWorthIt(s, 1_000_000, e)).toBe(true);
    await s.commit('s', ALL, [1, 985_000], []); expect(await isWorthIt(s, 1_000_000, e)).toBe(false);
    expect(await isWorthIt(s, 1_010_000, e)).toBe(true);
    await s.put('trimmed:s', 5); expect(await isWorthIt(s, 1_010_000, e)).toBe(false);
  });
  it('serves reads and dates without asking, and leaves the rest to the indexer', async () => {
    for (const store of [memoryStore(), indexedDbStore('test', new IDBFactory())]) {
      const asked: string[] = [];
      const ix = new Indexer('https://i.test', { retries: 0, fetch: (async (_u: unknown, i: RequestInit) => { const { query, variables } = JSON.parse(String(i.body)); asked.push(query.includes('latest') ? 'tip' : `${variables.where?.block_height?.gt}`); return reply({ data: query.includes('latest') ? { latestBlockHeight: 1000 } : { getTransactions: [] } }); }) as typeof fetch }, store);
      ix.prime(async () => { await new Promise((r) => setTimeout(r, 20)); return decodeHistory(golden, 'gnoland-1', HISTORY); }, HISTORY.map((h) => h.stream));
      const f: EventFilter = { types: ['Swap'], pkg: () => true, pkgLike: 'x', attr: { key: 'poolPath', values: [POOL_A] }, cache: { stream: 'gnoswap:swap', group: POOL_A, groupOf: (e) => e.attrs['poolPath']!, keep: ['poolPath'] } };
      expect((await ix.events(f, 20, 100)).map((e) => e.height)).toEqual([20, 30, 40, 50, 60, 70, 80, 90]); expect(asked).toEqual([]);
      expect((await ix.blockTimes([10, 50])).get(50)).toBe(1e12 + 150_000); expect(asked).toEqual([]);
      expect((await ix.events(f, 100, 200)).map((e) => e.height)).toEqual([100, 110]); expect(asked).toEqual(['tip', '119']);
      expect((await ix.peek(f))!.events).toHaveLength(11);
    }
  });
  it('is optional: a missing or broken file changes nothing', async () => {
    const ix = new Indexer('https://i.test', { retries: 0, fetch: (async (_u: unknown, i: RequestInit) => reply({ data: String(i.body).includes('latest') ? { latestBlockHeight: 1000 } : { getTransactions: [] } })) as typeof fetch }, memoryStore());
    ix.prime(async () => { throw new Error('HTTP 404'); }, ['s']);
    expect(await ix.whole).toBe(false);
    expect(await ix.events({ types: ['Swap'], pkg: () => true, pkgLike: 'x', cache: { stream: 's', group: null, groupOf: () => '', keep: [] } }, 1, 9)).toEqual([]);
  });
});

describe('storage limits', () => {
  it('drops the oldest trades of a stream and stops vouching for them', async () => {
    const s = indexedDbStore('test', new IDBFactory()), put = (group: string, h: number) => ({ group, seq: 0, event: { height: h, type: 't', pkg: 'p', attrs: {} } });
    await s.commit('s', ALL, [1, 101], Array.from({ length: 100 }, (_, i) => put(i % 2 ? 'P' : 'Q', i + 1)));
    await s.commit('s', 'P', [101, 120], []); await s.commit('other', ALL, [1, 101], [put('X', 5)]);
    expect(await s.trim('s', 500)).toBe(0);
    expect(await s.trim('s', 30)).toBe(71);
    expect((await s.events('s', null, 0, 999)).map((e) => e.event.height)).toEqual(Array.from({ length: 30 }, (_, i) => 71 + i));
    expect([await s.coverage('s', ALL), await s.coverage('s', 'P'), await s.coverage('other', ALL)]).toEqual([[[71, 101]], [[101, 120]], [[1, 101]]]);
    expect(await s.events('other', null, 0, 999)).toHaveLength(1);
  });
  it('behaves the same in memory', async () => {
    const run = async (s: Store) => {
      const put = (group: string, h: number, seq = 0) => ({ group, seq, event: { height: h, type: 't', pkg: 'p', attrs: { h: String(h) } } });
      await s.commit('s', ALL, [1, 10], [put('P', 3), put('P', 3, 1), put('Q', 2)]); await s.commit('s', 'P', [10, 12], [put('P', 11)]); await s.putTimes([[3, 9]]); await s.put('k', 1);
      const a = [await s.events('s', null, 0, 99), await s.events('s', 'P', 3, 11), await s.coverage('s', ALL), await s.coverage('s', 'P'), await s.times(), await s.get('k')];
      await s.forget('s', 'P');
      return [...a, await s.events('s', null, 0, 99), await s.coverage('s', ALL)];
    };
    expect(await run(memoryStore())).toEqual(await run(indexedDbStore('test', new IDBFactory())));
  });
});

describe('trading a Gnomi curve', () => {
  const me = 'g1vc883gshu5z7ytk5cdynhc8c2dh67pdp4cszkp', T = `${PAD}.GNOVA`, id = `${PAD}:0000008`, pool = { id, token0: T, token1: WUGNOT };
  const buy: Order = { pool, input: WUGNOT, output: T, amountIn: 2_000_000n }, sell: Order = { pool, input: T, output: WUGNOT, amountIn: 100_000n };
  const p = { caller: me, min: 5n, wrapped: 0n, credit: 0n }, fns = (o: Order, q: Partial<typeof p> = {}) => planGnomi(o, { ...p, ...q }).calls.map((c) => [c.func, c.send, ...c.args]);
  /** gno.land: address = first 20 bytes of sha256("pkgPath:" + path), in bech32. */
  function realmAddress(path: string): string {
    const abc = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', b = createHash('sha256').update('pkgPath:' + path).digest().subarray(0, 20), d: number[] = [];
    let acc = 0, n = 0;
    for (const x of b) { acc = ((acc << 8) | x) & 0xfff; n += 8; while (n >= 5) { n -= 5; d.push((acc >> n) & 31); } }
    let c = 1;
    for (const v of [3, 0, 7, ...d, 0, 0, 0, 0, 0, 0]) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ v; [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3].forEach((g, i) => { if ((t >>> i) & 1) c ^= g; }); }
    c = (c ^ 1) >>> 0;
    return 'g1' + [...d, ...[0, 1, 2, 3, 4, 5].map((i) => (c >>> (5 * (5 - i))) & 31)].map((i) => abc[i]).join('');
  }

  it('sends money only to the address its own realm path gives', () => {
    expect(realmAddress(PAD)).toBe(PAD_ADDRESS);
    expect(realmAddress('gno.land/r/gnoswap/router')).toBe(ROUTER_ADDRESS); // same rule, independent case
  });
  it('pays and buys in one transaction', () => {
    expect(fns(buy)).toEqual([['Deposit', '2000000ugnot'], ['Transfer', '', PAD_ADDRESS, '2000000'], ['Buy', '', '0000008', '2000000', '5']]);
    const calls = planGnomi(buy, p).calls;
    expect(calls.map((c) => c.pkg_path)).toEqual(['gno.land/r/gnoland/wugnot', 'gno.land/r/gnoland/wugnot', PAD]);
    expect(calls.every((c) => c.caller === me && c.max_deposit === '5000000ugnot')).toBe(true);
  });
  it('never leaves ownerless money in the pad: sends exactly what credit does not cover', () => {
    for (const credit of [0n, 1n, 500_000n, 1_999_999n, 2_000_000n, 9_000_000n]) for (const wrapped of [0n, 700_000n, 5_000_000n]) {
      const calls = planGnomi(buy, { ...p, credit, wrapped }).calls, sent = BigInt(calls.find((c) => c.func === 'Transfer')?.args[1] ?? 0);
      expect(sent + (credit < buy.amountIn ? credit : buy.amountIn)).toBe(buy.amountIn);
      const wrap = BigInt(calls.find((c) => c.func === 'Deposit')?.send.replace('ugnot', '') ?? 0);
      expect(wrap + wrapped >= sent).toBe(true); expect(calls.at(-1)!.func).toBe('Buy');
    }
    expect(fns(buy, { credit: 2_000_000n })).toEqual([['Buy', '', '0000008', '2000000', '5']]);
  });
  it('wraps only what is missing', () => {
    expect(fns(buy, { wrapped: 2_000_000n }).map((x) => x[0])).toEqual(['Transfer', 'Buy']);
    expect(planGnomi(buy, { ...p, wrapped: 1_500_000n }).wrap).toBe(500_000n);
    expect(planGnomi(buy, { ...p, wrapped: 1_999_999n }).wrap).toBe(1000n);
  });
  it('sells in a single call, without any approval', () => expect(fns(sell)).toEqual([['Sell', '', '0000008', '100000', '5']]));
  it('claims', () => { expect(planClaim(me)).toMatchObject([{ caller: me, pkg_path: PAD, func: 'ClaimWugnot', args: [], send: '' }]); expect(() => planClaim('g1x')).toThrow(InputError); });
  it('refuses other pads, other tokens and bad numbers', () => {
    const old = PAD.replace('padv3', 'padv2');
    for (const bad of [`${old}:0000001`, `${PAD}:`, `${PAD}:1")+("`, `${PAD}/x:1`, 'x']) expect(() => parseMarket(bad)).toThrow(InputError);
    for (const o of [{ ...buy, output: GNS }, { ...sell, input: GNS }, { ...buy, input: T, output: GNS }, { ...buy, input: GNS, output: T }]) expect(() => planGnomi(o, p)).toThrow(InputError);
    for (const q of [{ caller: 'g1evil' }, { min: 0n }, { credit: -1n }]) expect(() => planGnomi(buy, { ...p, ...q })).toThrow(InputError);
    for (const amountIn of [0n, -1n, 2n ** 63n]) expect(() => planGnomi({ ...buy, amountIn }, p)).toThrow(InputError);
  });

  const state = { ...newCurve(), remaining: 300_000_000_000n };
  it('quotes what the contract does: every real trade of a launch', () => {
    const c = newCurve(); let n = 0;
    for (const e of gnova.ev as unknown as ChainEvent[]) {
      const isBuy = e.type === 'Buy', q = quoteCurve({ ...c, remaining: 300_000_000_000n }, isBuy, BigInt(isBuy ? e.attrs['ugnot']! : e.attrs['tokens']!));
      expect(q.amountOut).toBe(BigInt(isBuy ? e.attrs['tokens']! : e.attrs['ugnot']!)); n++;
      replay(c, e);
    }
    expect(n).toBeGreaterThan(10);
  });
  it('charges the fee both ways (the contract rounds under one token in favour of the buyer)', () => {
    for (const x of [100_000n, 2_000_000n, 777_777_777n, 50_000_000_000n]) {
      const got = quoteCurve(state, true, x).amountOut, c = newCurve();
      replay(c, { height: 1, type: 'Buy', pkg: PAD, attrs: { ugnot: String(x), tokens: String(got) } });
      expect(quoteCurve({ ...c, remaining: 1n }, false, got).amountOut < x).toBe(true);
    }
  });
  it('leaves the order that completes a launch alone', () => {
    expect(() => quoteCurve({ ...state, remaining: 1_000_000n }, true, 2_000_000n)).toThrow('complete the launch');
    expect(() => quoteCurve({ ...state, remaining: 10n ** 15n }, true, 400_000_000_000n)).toThrow('complete the launch');
    expect(() => quoteCurve(state, false, 0n)).toThrow(/too small/); expect(() => quoteCurve(state, true, 0n)).toThrow(/too small/);
    expect(quoteCurve(state, true, 1n).amountOut).toBe(1n);
  });

  const line = (name: string, uri: string, u = '102375071625', t = '1073000191') => ['0000008', name, 'GNOVA', '0', '0', '0', '0', '0', '0', '0', uri, me, u, t, '5', `${T}.8`, '0', '0', '', '', ''].join('|');
  const hist = `5|2|0|0|${spotScaled(newCurve())}`;
  it('is not fooled by a creator who writes separators in the name or address', () => {
    expect(parseReserves(line('ok', ''), hist)).toMatchObject({ u: 102375071625n, t: 1073000191n });
    expect(parseReserves(line('a|b|1|2|3', 'x|9|9|9|9|9|9'), hist)).toMatchObject({ u: 102375071625n });
    expect(() => parseReserves(line('ok', '', '1', '1073000191'), hist)).toThrow('do not match');
    for (const bad of ['', '1|2|3', line('ok', '', '-5'), line('ok', '', '0', '0')]) expect(() => parseReserves(bad, hist)).toThrow();
  });
  const rpc = (o: Partial<Record<string, string | bigint>> = {}) => {
    const get = (x: string) => { const f = /padv3\.(\w+)\(/.exec(x)![1]!; return o[f] ?? { AdenaPathOf: T, GetStatus: 0n, LaunchInfo: line('ok', ''), TradeHistory: hist, RemainingRaiseUgnot: 300_000_000_000n, PrepaidOf: 7n }[f]; };
    return { evalString: async (x: string) => get(x), evalInt: async (x: string) => get(x) } as unknown as Rpc;
  };
  it('quotes only the launch on the page, and only while it is on its curve', async () => {
    expect((await gnomiDesk(rpc()).quote(buy)).amountOut).toBe(quoteCurve(state, true, 2_000_000n).amountOut);
    await expect(gnomiDesk(rpc({ AdenaPathOf: `${PAD}.OTHER` })).quote(buy)).rejects.toThrow('does not match');
    await expect(gnomiDesk(rpc({ GetStatus: 1n })).quote(buy)).rejects.toThrow('graduated');
    await expect(gnomiDesk(rpc({ LaunchInfo: line('ok', '', '9') })).quote(buy)).rejects.toThrow('do not match');
    expect(await gnomiDesk(rpc()).credit(me)).toBe(7n); expect(() => gnomiDesk(rpc()).credit('x")')).toThrow(InputError);
  });
  it('reads the credit again when building, because it decides how much is sent', async () => {
    let asked = 0;
    const t = createTrader({ rpc: { evalInt: async (x: string) => (x.includes('PrepaidOf') ? (asked++, 1_500_000n) : 0n) }, indexer: {} } as unknown as Engine);
    const made = await t.desks.gnomi.build(buy, { caller: me, min: 1n, wrapped: 0n });
    expect([asked, made.calls.find((c) => c.func === 'Transfer')!.args[1]]).toEqual([1, '500000']); expect(t.desks.gnomi.gas).toBe(GNOMI_GAS);
  });
  it('explains the pad errors', () => {
    expect(explain('pad: tokens out below minOut (slippage)')).toMatch(/slippage limit/);
    expect(explain('pad: anti-snipe cumulative max buy exceeded')).toMatch(/minutes old/);
    expect(explain('pad: not on curve (use SwapBuy)')).toMatch(/completed/);
    expect(explain('pad: insufficient token balance')).toMatch(/balance is too low/);
    expect(explain('ammmath: zero tokens out')).toMatch(/too small/);
  });
});

describe('GNOT in dollars', () => {
  const now = 1.8e12, kr = (c: unknown) => ({ error: [], result: { GNOTUSD: { c: [c, '1'] } } }), cg = (usd: unknown, ageS = 60) => ({ 'gno-land': { usd, last_updated_at: now / 1000 - ageS } });
  const from = (k: unknown, g: unknown, asked: string[] = []) => (async (u: string) => { asked.push(new URL(u).host); const x = u.includes('kraken') ? k : g; if (x instanceof Error) throw x; return x instanceof Response ? x : reply(x); }) as unknown as typeof fetch;
  it('reads Kraken and leaves CoinGecko alone', async () => {
    const asked: string[] = [];
    expect(await gnotUsd(from(kr('0.049640000'), cg(9), asked), now)).toEqual({ price: 0.04964, source: 'Kraken', at: now }); expect(asked).toEqual(['api.kraken.com']);
  });
  it('falls back when Kraken fails or makes no sense', async () => {
    for (const bad of [new Error('down'), reply({}, 500), { error: ['EQuery:Unknown asset pair'] }, {}, kr('0'), kr('-1'), kr('abc'), kr(null), kr('1e9')]) expect(await gnotUsd(from(bad, cg(0.05)), now)).toEqual({ price: 0.05, source: 'CoinGecko', at: now - 60_000 });
  });
  it('gives nothing rather than an old or odd price', async () => {
    for (const bad of [cg(0.05, 7200), cg(null), cg(0), {}, new Error('down')]) await expect(gnotUsd(from(new Error('x'), bad), now)).rejects.toThrow();
  });
  it('prints', () => expect([0.04964, 0.5, 1.2345, 12345.6, 0.000012345].map(usd)).toEqual(['$0.04964', '$0.5000', '$1.23', '$12,346', '$0.00001234']));
});

describe('GNOT and dollars', () => {
  it('prints dollars', () => {
    expect([0.00928, 0.00000645, 12.3456, null].map(usdPrice)).toEqual(['$0.00928', '$0.0₅6450', '$12.346', 'n/a']);
    expect([0, 0.004, 1.5, 999.4, 23_100, 1_734_000, null].map(usdAmount)).toEqual(['$0', '<$0.01', '$1.50', '$999.40', '$23.1K', '$1.73M', 'n/a']);
  });
  it('shows the chosen unit, and the other one in the tooltip', () => {
    expect([display(0.187, 'price', 'GNOT', 0.05), other(0.187, 'price', 'GNOT', 0.05, false)]).toEqual(['0.18700', '$0.00935']);
    expect([display(0.187, 'price', 'USD', 0.05), other(0.187, 'price', 'USD', 0.05, false)]).toEqual(['$0.00935', '0.18700 GNOT']);
    expect([display(34_960_000, 'amount', 'USD', 0.05), other(34_960_000, 'amount', 'USD', 0.05, false)]).toEqual(['$1.75M', '34.96M GNOT']);
  });
  it('says that an old trade is converted at today’s price', () => expect([other(2, 'amount', 'GNOT', 0.05, true), other(2, 'amount', 'USD', 0.05, true)]).toEqual(['$0.10 at today’s GNOT price', '2.0 GNOT']));
  it('stays in GNOT without a rate', () => { expect(display(2, 'amount', 'USD', null)).toBe('2.0'); expect(other(2, 'amount', 'USD', null, false)).toBe(''); expect(display(null, 'price', 'USD', 0.05)).toBe('n/a'); });
});

describe('ending in GNOT', () => {
  const me = 'g1vc883gshu5z7ytk5cdynhc8c2dh67pdp4cszkp', pool = { id: `${WUGNOT}:${GNOMIC}:10000`, token0: WUGNOT, token1: GNOMIC };
  const sell: Order = { pool, input: GNOMIC, output: WUGNOT, amountIn: 1_500_000n }, buy: Order = { pool, input: WUGNOT, output: GNOMIC, amountIn: 1_500_000n };
  const base = { caller: me, min: 274_324n, deadline: 1, style: 'plain' as const, wrapped: 0n };
  it('converts exactly the minimum the sale guarantees, after the sale', () => {
    const p = withUnwrap(plan(sell, base), sell, me, base.min), swap = p.calls.find((c) => c.func === 'ExactInSwapRoute')!;
    expect(p.calls.map((c) => c.func)).toEqual(['Approve', 'ExactInSwapRoute', 'Withdraw']);
    expect(p.calls.at(-1)).toEqual({ caller: me, send: '', max_deposit: '5000000ugnot', pkg_path: 'gno.land/r/gnoland/wugnot', func: 'Withdraw', args: ['274324'] });
    expect(p.calls.at(-1)!.args[0]).toBe(swap.args[5]); // the same number the router is held to
  });
  it('does the same for a curve', () => {
    const T = `${PAD}.GNOVA`, o: Order = { pool: { id: `${PAD}:0000008`, token0: T, token1: WUGNOT }, input: T, output: WUGNOT, amountIn: 9n };
    const p = withUnwrap(planGnomi(o, { caller: me, min: 77n, wrapped: 0n, credit: 0n }), o, me, 77n);
    expect(p.calls.map((c) => [c.func, c.args.at(-1)])).toEqual([['Sell', '77'], ['Withdraw', '77']]);
  });
  it('leaves everything else alone', () => {
    const p = plan(buy, base);
    expect(withUnwrap(p, buy, me, 5n)).toBe(p);
    const gns: Order = { ...sell, output: GNS }; expect(withUnwrap(p, gns, me, 5n)).toBe(p);
  });
  it('refuses nothing, too much, or a bad address', () => {
    for (const a of [0n, -1n, 2n ** 63n]) expect(() => planUnwrap(me, a)).toThrow(InputError);
    expect(() => planUnwrap('g1x', 5n)).toThrow(InputError);
    expect(planUnwrap(me, 16_934_472n)[0]!.args).toEqual(['16934472']);
  });
});

describe('token addresses', () => {
  const at = (u: string) => { const x = new URL('https://dexvision.pro' + u); return pathFromLocation(x); };
  it('round-trips every kind of token path', () => {
    for (const p of [GNS, GNOMIC, 'gno.land/r/demo/defi/grc20factory.PERUN', `${PAD}.GNOMI`]) { const r = parseRealm(at(tokenUrl(p))!); expect(`${r.realm}.${r.symbol}`).toBe(p); }
    expect(tokenUrl(GNS)).toBe('/token/r/gnoswap/gns.GNS');
  });
  it('accepts a bare realm, a trailing slash, and older links', () => {
    expect(parseRealm(at('/token/r/gnoswap/gns')!)).toEqual({ realm: 'gno.land/r/gnoswap/gns' });
    expect(parseRealm(at('/token/r/gnoswap/gns.GNS/?m=x')!)).toEqual({ realm: 'gno.land/r/gnoswap/gns', symbol: 'GNS' });
    expect(at('/token/?t=/r/gnoswap/gns.GNS')).toBe('/r/gnoswap/gns.GNS'); expect(at('/token/')).toBeNull();
  });
  it('never lets an odd address through', () => {
    for (const u of ['/token/r/a%22)%2BEvil(%22', '/token/r/%3Cimg%20src=x%3E.Y', '/token/r/a/../../x.Y%22', '/token/r/%E0%A4%A']) { const p = at(u); expect(() => parseRealm(p ?? '')).toThrow(InputError); }
  });
});

describe('own trades', () => {
  const me = 'g1vc883gshu5z7ytk5cdynhc8c2dh67pdp4cszkp', other2 = 'g1n4pl5uc4yt5r96m9w6fmdznx3x0jyg8l6arhmt', id = `${WUGNOT}:${GNOMIC}:10000`;
  it('asks only for what the account signed, and keeps it apart', async () => {
    let seen: EventFilter | null = null;
    const ctx = { token: async (path: string) => ({ path, realm: '', symbol: '', decimals: 6 }), indexer: { events: async (f: EventFilter) => { seen = f; return [{ height: 9, type: 'Swap', pkg: 'gno.land/r/gnoswap/pool/v1', attrs: { poolPath: id, sqrtPriceX96: '183212861321984232276593700044', token0Amount: '15000000', token1Amount: '-86354873' } }]; } } } as unknown as VenueContext;
    const v = gnoswap(ctx, { height: 1, pools: [{ path: id, token0: WUGNOT, token1: GNOMIC, fee: 10000, height: 5, sqrtPriceX96: 1n << 96n }] });
    const got = await v.mine({ venue: 'gnoswap', id, token0: WUGNOT, token1: GNOMIC, feePct: 1, height: 5 }, me, 99);
    expect(got).toEqual([{ height: 9, buy: false, amount0: 15, amount1: 86.354873, price: 86.354873 / 15 }]); // the price paid, not the price left behind
    expect(seen!.caller).toBe(me); expect(seen!.cache!.stream).toContain(me); expect(seen!.cache!.group).toBe(id);
  });
  it('checks the buyer or seller on a curve', async () => {
    const ev = (type: string, a: Record<string, string>) => ({ height: 3, type, pkg: PAD, attrs: { id: '1', ...a } });
    const ctx = { token: async (path: string) => ({ path, realm: '', symbol: '', decimals: 0 }), indexer: { events: async () => [ev('Buy', { buyer: me, ugnot: '2000000', tokens: '10000' }), ev('Buy', { buyer: other2, ugnot: '9', tokens: '9' }), ev('Sell', { seller: me, ugnot: '500000', tokens: '4000' }), ev('Graduated', { poolUgnot: '1', poolToken: '1' })] } } as unknown as VenueContext;
    expect(await gnomi(ctx, [PAD]).mine({ venue: 'gnomi', id: `${PAD}:1`, token0: `${PAD}.X`, token1: WUGNOT, feePct: 1.2, height: 1 }, me, 9)).toEqual([
      { height: 3, buy: true, price: 0.0002, amount0: 10000, amount1: 2 }, { height: 3, buy: false, price: 0.000125, amount0: 4000, amount1: 0.5 }]);
  });
  it('puts the signer in the query', async () => {
    let body = '';
    const ix = new Indexer('https://i.test', { retries: 0, fetch: (async (_u: unknown, i: RequestInit) => { body = String(i.body); return reply({ data: { getTransactions: [] } }); }) as typeof fetch });
    await ix.events({ types: ['Swap'], pkg: () => true, pkgLike: 'x', caller: me }, 1, 9);
    expect(JSON.parse(body).variables.where.messages).toEqual({ value: { MsgCall: { caller: { eq: me } } } });
  });
  it('refuses something that is not an address', async () => { await expect(createEngine({ fetch: (async () => reply({})) as typeof fetch }).myTrades(GNS, {} as Market, 'x")')).rejects.toThrow(InputError); });
});

describe('holders', () => {
  const ID = 'gno.land/r/x/t.T.0000000', ev = (from: string, to: string, value: string | number, height = 1): ChainEvent => ({ height, type: 'Transfer', pkg: 'gno.land/p/nt/grc20/v0', attrs: { token: ID, from, to, value: String(value) } });
  const story = [ev('', 'a', 100), ev('a', 'b', 40), ev('b', 'c', 15), ev('c', 'b', 5), ev('b', '', 10), ev('a', 'a', 7)];
  it('adds up mints, transfers and burns, in any order', () => {
    for (const list of [story, [...story].reverse()]) {
      const l = emptyLedger(); add(l, list);
      expect(ranked(l)).toEqual([['a', 60n], ['b', 20n], ['c', 10n]]); expect(totalOf(l)).toBe(90n);
    }
    const l = emptyLedger(); add(l, [ev('', 'a', 5), ev('a', 'b', 5)]); expect([...l.balances.keys()]).toEqual(['b']); // emptied accounts are gone
  });
  it('keeps amounts beyond what a float can hold', () => { const l = emptyLedger(); add(l, [ev('', 'a', '9007199254740993'), ev('', 'a', '1')]); expect(l.balances.get('a')).toBe(9007199254740994n); });
  it('joins pairs both ways and finds groups', () => {
    const l = emptyLedger(); add(l, [...story, ev('', 'x', 9), ev('x', 'y', 1)]);
    expect(linksOf(l).find((k) => k.a === 'b' && k.b === 'c')).toEqual({ a: 'b', b: 'c', times: 2, value: 20n });
    expect(groupsOf(['a', 'b', 'c', 'x', 'y', 'z'], linksOf(l)).map((s) => [...s].sort())).toEqual([['a', 'b', 'c'], ['x', 'y']]);
    expect(groupsOf(['a', 'c'], linksOf(l))).toEqual([]); // b is not among them
  });
  it('remembers a summary, reads only what is new, and leaves the newest blocks out of it', async () => {
    const all = [ev('', 'a', 100, 5), ev('a', 'b', 30, 998), ev('a', 'c', 1, 1200)], asked: [number, number][] = [], notes = new Map<string, unknown>();
    const ix = { recall: async (k: string) => notes.get(k), note: async (k: string, v: unknown) => { notes.set(k, v); }, events: async (f: EventFilter, a: number, b: number) => { asked.push([a, b]); expect(f.attr).toEqual({ key: 'token', values: [ID] }); return all.filter((e) => e.height >= a && e.height < b); } } as unknown as Indexer;
    const one = await readLedger(ix, ID, 1000, false, () => {});
    expect([...one.ledger.balances]).toEqual([['a', 70n], ['b', 30n]]); expect(asked).toEqual([[1, 996], [996, 1001]]);
    expect([...(notes.values().next().value as { balances: Map<string, bigint> }).balances]).toEqual([['a', 100n]]); // block 998 may still be filling in
    asked.length = 0;
    const two = await readLedger(ix, ID, 1300, false, () => {});
    expect([...two.ledger.balances]).toEqual([['a', 69n], ['b', 30n], ['c', 1n]]); expect(asked).toEqual([[996, 1296], [1296, 1301]]); expect(two.remembered).toBe(true);
    const three = await readLedger(ix, ID, 1300, true, () => {}); expect(ranked(three.ledger)).toEqual(ranked(two.ledger)); expect(asked.at(-2)).toEqual([1, 1296]);
  });
  it('tells a token apart from one whose name starts the same', async () => {
    const ix = new Indexer('https://i.test', { retries: 0, fetch: (async () => reply({ data: { getTransactions: [{ block_height: 4, response: { events: [ID, 'gno.land/r/x/t.TO.0000001'].map((token) => ({ type: 'Transfer', pkg_path: 'gno.land/p/nt/grc20/v0', attrs: Object.entries({ token, from: '', to: 'a', value: '5' }).map(([key, value]) => ({ key, value })) })) } }] } })) as typeof fetch });
    expect((await readLedger(ix, ID, 9, true, () => {})).ledger.balances.get('a')! % 5n).toBe(0n);
    expect(totalOf((await readLedger({ ...ix, recall: async () => undefined, note: async () => undefined, events: (f: EventFilter, a: number, b: number) => (a > 1 ? Promise.resolve([]) : ix.events(f, a, b)) } as unknown as Indexer, ID, 9, true, () => {})).ledger)).toBe(5n);
  });
  it('knows where realms keep things, and who has signed', async () => {
    expect(await addressOf(PAD)).toBe(PAD_ADDRESS); expect(await addressOf('gno.land/r/gnoswap/router')).toBe(ROUTER_ADDRESS);
    expect([hasSigned('{"BaseAccount":{"sequence":"12","public_key":{"@type":"x"}}}'), hasSigned('{"BaseAccount":{"sequence":"0","public_key":null}}'), hasSigned('null'), hasSigned('')]).toEqual([true, false, false, false]);
  });
  const H = (address: string, s: number, kind: Holder['kind'] = 'wallet'): Holder => ({ address, share: s, amount: s * 100, kind });
  it('sums up without counting contracts as people', () => { expect(digest([H('p', 0.7, 'contract'), H('a', 0.2), H('b', 0.099995, 'quiet'), H('c', 0.000005)])).toEqual({ contracts: 0.7, top10: expect.closeTo(0.3, 9), dust: 1 }); });
  it('prints shares', () => expect([0, 0.000001, 0.0005, 0.349, 1].map(share)).toEqual(['0%', '<0.001%', '0.050%', '34.9%', '100.0%']));
  it('draws contracts unlinked, inside the frame, the same every time', () => {
    const hs = [H('p', 0.7, 'contract'), ...Array.from({ length: 120 }, (_, i) => H(`w${i}`, 0.3 / 2 ** (i + 1)))], ls = [{ a: 'p', b: 'w0', times: 1, value: 1n }, { a: 'w0', b: 'w1', times: 1, value: 1n }, { a: 'w0', b: 'w110', times: 1, value: 1n }];
    const { shown, pairs } = cast(hs, ls); expect([shown.length, pairs]).toEqual([80, [[1, 2]]]);
    for (const [w, h] of [[1300, 600], [340, 340]] as const) {
      const s = layout(shown, pairs, w, h);
      for (const x of s) { expect(x.x - x.r).toBeGreaterThanOrEqual(0); expect(x.x + x.r).toBeLessThanOrEqual(w); expect(x.y - x.r).toBeGreaterThanOrEqual(0); expect(x.y + x.r).toBeLessThanOrEqual(h); }
      expect(layout(shown, pairs, w, h)).toEqual(s);
    }
    expect(layout([H('only', 1)], [], 800, 500)[0]!.r).toBeLessThanOrEqual(125); expect(layout([], [], 800, 500)).toEqual([]);
  });
});

describe('who can withdraw', () => {
  const pool = `${WUGNOT}:${GNOMIC}:10000`, A = 'g1vc883gshu5z7ytk5cdynhc8c2dh67pdp4cszkp', B2 = 'g1n4pl5uc4yt5r96m9w6fmdznx3x0jyg8l6arhmt';
  it('reads only open positions and looks behind the staker', async () => {
    const home = await addressOf('gno.land/r/gnoswap/staker'), asked: string[] = [], ev = (type: string, id: number, left: number, height: number) => ({ height, type, pkg: 'gno.land/r/gnoswap/position/v1', attrs: { poolPath: pool, lpPositionId: String(id), positionLiquidity: String(left) } });
    const vals = (...v: string[]) => v.map((value) => ({ value, type: '' }));
    const ctx = {
      token: async (path: string) => ({ path, realm: '', symbol: '', decimals: 6 }),
      indexer: { events: async () => [ev('Mint', 1, 5, 2), ev('Mint', 2, 5, 3), ev('Mint', 3, 5, 4), ev('DecreaseLiquidity', 1, 0, 5), ev('DecreaseLiquidity', 2, 0, 6), ev('Reposition', 2, 8, 7)] },
      rpc: { eval: async (x: string) => { asked.push(x); if (x.includes('GetBalances')) return vals('10000000', '20000000'); if (x.includes('GetPositionTokenBalances')) return vals('4000000', '9000000'); return vals(x.includes('GetPositionOwner(2)') ? home : x.includes('GetDepositOwner(2)') ? A : B2); } },
    } as unknown as VenueContext;
    const v = gnoswap(ctx, { height: 1, pools: [{ path: pool, token0: WUGNOT, token1: GNOMIC, fee: 10000, height: 1, sqrtPriceX96: 1n << 96n }] });
    const r = await v.providers!({ venue: 'gnoswap', id: pool, token0: WUGNOT, token1: GNOMIC, feePct: 1, height: 1 }, 99, () => {});
    expect({ ...r, stakes: [...r.stakes].sort((x, y) => Number(y.staked) - Number(x.staked)) }).toEqual({ stakes: [{ owner: A, staked: true, amount0: 4, amount1: 9 }, { owner: B2, staked: false, amount0: 4, amount1: 9 }], balance0: 10, balance1: 20 });
    expect(asked.some((x) => /\(1\)/.test(x))).toBe(false); // emptied
    expect(asked.some((x) => x.includes('GetDepositOwner(3)'))).toBe(false);
  });
  it('values what each could take, and leaves out what has no price', () => {
    const part = (key: string, paired: number, staked = false) => ({ key, staked, token: 10, paired, positions: 1 }), l = { pools: [], failed: [], curve: false, named: true, providers: [{ address: A, kind: 'wallet' as const, parts: [part('k', 10), part('x', 999)] }, { address: B2, kind: 'wallet' as const, parts: [part('k', 30, true)] }] };
    const r = backers(l, (k) => (k === 'k' ? 2 : null));
    expect(r.list.map((b) => [b.p.address, b.depth, b.share, b.staked, b.amount, b.positions])).toEqual([[B2, 60, 0.75, 60, 10, 1], [A, 20, 0.25, 0, 20, 2]]); expect([r.total, r.unpriced]).toEqual([80, true]);
    expect(backers({ ...l, providers: [] }, () => 1).total).toBe(0);
  });
  it('links to the explorer', () => { expect(explorer({ address: A })).toBe(`https://gnoscan.io/account/${A}`); expect(explorer({ address: A, realm: 'gno.land/r/gnoswap/pool' })).toBe('https://gnoscan.io/realms/details?path=gno.land/r/gnoswap/pool'); expect(explorer({ address: 'a"><b' })).not.toContain('"'); });
});

describe('price axis', () => {
  it('keeps a tiny move from filling the chart, and leaves real moves alone', () => {
    const r = widen(0.2439039899, 0.243903991); expect(r.maxValue - r.minValue).toBeCloseTo(0.0002439, 7); expect((r.maxValue + r.minValue) / 2).toBeCloseTo(0.24390399, 8);
    { const w = widen(0.1, 0.3); expect(w.minValue).toBeCloseTo(0.1, 12); expect(w.maxValue).toBeCloseTo(0.3, 12); } expect(widen(5, 5).maxValue).toBeCloseTo(5.0025, 9);
  });
});

describe('table sorting', () => {
  const rows = [{ n: 'b', v: 2 }, { n: 'A', v: null }, { n: 'c', v: 10 }, { n: 'a2', v: 2 }];
  const keys = { n: (r: { n: string }) => r.n, v: (r: { v: number | null }) => r.v };
  const ids = (key: string | null, desc: boolean) => sortBy(rows, { key, desc }, keys).map((r) => r.n).join(' ');
  it('sorts numbers both ways, keeps ties in order and unknowns last', () => {
    expect(ids('v', true)).toBe('c b a2 A');
    expect(ids('v', false)).toBe('b a2 c A');
  });
  it('sorts text without case, numbers inside it as numbers', () => expect(ids('n', false)).toBe('A a2 b c'));
  it('leaves the order alone with no column', () => expect(ids(null, true)).toBe('b A c a2'));
});

describe('who traded', () => {
  const SWAP: EventFilter = { types: ['Swap'], pkg: (p) => p === 'gno.land/r/gnoswap/pool', pkgLike: 'gno.land/r/gnoswap/pool' };
  it('names the transaction and its signer on every event', async () => {
    let query = '';
    const ix = new Indexer('https://i.test', { retries: 0, fetch: (async (_u: unknown, i: RequestInit) => { query = JSON.parse(String(i.body)).query; return reply({ data: { getTransactions: [
      { block_height: 7, hash: 'abc+/=', messages: [{ value: {} }, { value: { caller: 'g1me' } }], response: { events: [{ type: 'Swap', pkg_path: 'gno.land/r/gnoswap/pool', attrs: [{ key: 'poolPath', value: 'p' }] }] } },
      { block_height: 8, response: { events: [{ type: 'Swap', pkg_path: 'gno.land/r/gnoswap/pool', attrs: [] }] } },
    ] } }); }) as typeof fetch });
    const [a, b] = await ix.events(SWAP, 1, 10);
    expect(query).toContain('hash'); expect(query).toContain('caller');
    expect(a!.attrs).toEqual({ poolPath: 'p', [TX]: 'abc+/=', [BY]: 'g1me' }); expect(signer(a!)).toEqual({ tx: 'abc+/=', by: 'g1me' });
    expect(signer(b!)).toEqual({}); // an older indexer: the row shows n/a
  });
  it('gives contract-kept trades the transaction of their block, in order', () => {
    const ev = (height: number, type: string, tx: string): ChainEvent => ({ height, type, pkg: 'p', attrs: { [TX]: tx, [BY]: 'g1' + tx } });
    const f = (height: number) => ({ height, price: 1, amount0: 1, amount1: 1, buy: true });
    expect(withSigners([f(5), f(5), f(6), f(9)], [ev(5, 'Buy', 'a'), ev(5, 'Sell', 'b'), ev(6, 'Graduated', 'g'), ev(6, 'Buy', 'c')]).map((x) => x.tx ?? '-')).toEqual(['a', 'b', 'c', '-']);
  });
  it('links to gnoscan and keeps addresses short', () => {
    expect(txUrl('ab+/=')).toBe('https://gnoscan.io/transactions/details?txhash=ab%2B%2F%3D');
    expect(shortAddress('g1uzqhpyuus8zwvuaszwfv38f3actnz9ar5tg5ms')).toBe('g1uzqhpy…g5ms');
  });
});

describe('trader books', () => {
  // token0 is the token; amount1 is GNOT
  const f = (height: number, buy: boolean, amount0: number, amount1: number, by?: string) => ({ height, price: amount1 / amount0, amount0, amount1, buy, ...(by ? { by, tx: `t${height}` } : {}) });
  const fills = [f(1, true, 100, 10, 'a'), f(2, true, 50, 10, 'b'), f(3, false, 40, 8, 'a'), f(4, true, 10, 2, 'a'), f(5, false, 5, 1)];
  it('groups trades by signer, newest first, from either side of the pair', () => {
    const a = books(fills, true).get('a')!;
    expect([a.buys, a.sells, a.bought, a.sold, a.spent, a.got]).toEqual([2, 1, 110, 40, 12, 8]);
    expect(a.trades.map((t) => [t.height, t.buy, t.tx])).toEqual([[4, true, 't4'], [3, false, 't3'], [1, true, 't1']]);
    expect([...books(fills, true).keys()]).toEqual(['a', 'b']); // no signer, no book
    const flipped = books(fills.map((x) => ({ ...x, amount0: x.amount1, amount1: x.amount0, buy: !x.buy })), false).get('a')!;
    expect([flipped.bought, flipped.sold, flipped.spent, flipped.got]).toEqual([110, 40, 12, 8]);
  });
  it('adds up what went in, what came back and what is still held', () => {
    const o = outcome(books(fills, true).get('a')!, 1, 0.3);
    expect([o.spentGnot, o.gotGnot, o.volumeGnot, o.net, o.left]).toEqual([12, 8, 20, -4, 70]);
    expect(o.leftGnot).toBeCloseTo(21); expect(o.total).toBeCloseTo(17); expect(o.tier.name).toBe('Shrimp');
    expect(outcome(books(fills, true).get('a')!, 2, null)).toMatchObject({ spentGnot: 24, gotGnot: 16, leftGnot: null, total: null });
  });
  it('names sizes by decades of GNOT', () => {
    expect([0, 99, 100, 999, 1_000, 10_000, 99_999, 100_000, 5e6].map((v) => tierOf(v).name)).toEqual(['Shrimp', 'Shrimp', 'Fish', 'Fish', 'Dolphin', 'Shark', 'Shark', 'Whale', 'Whale']);
    expect(TIERS.map(tierRange)).toEqual(['under 100 GNOT', '100–1K GNOT', '1K–10K GNOT', '10K–100K GNOT', '100K+ GNOT']);
  });
});

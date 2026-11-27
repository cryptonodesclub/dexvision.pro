import { WUGNOT } from './config.ts';
import { priceAll, type PricedMarket, type Quote } from './price.ts';
import type { Fills, Market, MarketState, Token } from './venues/venue.ts';

export type LiveMarket = PricedMarket & MarketState & { m: Market; venue: string };
export interface Supply { supply: number; accounts: number }
export interface Snapshot { markets: LiveMarket[]; tokens: Map<string, Token>; supply: Map<string, Supply>; created: Map<string, number>; height: number; at: number; unavailable: { source: string; reason: string }[] }
/** Trades of the last `span` ms, per market key, with their block time. */
export interface Activity { span: number; fills: Map<string, Fills>; times: Map<number, number> }

export interface Row {
  token: Token; price: number | null; depth: number | null;
  venue: string; stage?: string; feePct: number; quote: string; // the market that sets the price
  marketCap: number | null; accounts: number | null; created: number | null; // ms
  change: number | null; // percent over the window; null when the price then is unknown
  volume: number | null; // GNOT
  trades: number | null; partial: boolean;
  markets: string[];
  venues: string[]; // every market this token trades in, by label
}
/** `locked` counts only GNOT: valuing thin tokens at their own price would inflate it. */
export interface Overview { rows: Row[]; volume: number | null; trades: number | null; locked: number }

/** Price of a market at time t, from its trades: the last one before t, else what preceded them, else it has not moved. */
export function priceAt(x: LiveMarket, a: Activity, t: number): number | null {
  const f = a.fills.get(x.key);
  if (!f) return null;
  let p = f.fills.length ? (f.seed ?? null) : x.price;
  for (const s of f.fills) { const at = a.times.get(s.height); if (at !== undefined && at < t) p = s.price; }
  return p;
}
function along(route: readonly string[], target: string, get: (key: string) => { token0: string; token1: string; price: number | null } | undefined): number | null {
  let token = WUGNOT, gnot = 1;
  for (const k of route) {
    const m = get(k);
    if (!m || m.price === null || !(m.price > 0)) return null;
    const is0 = m.token0 === token;
    gnot = is0 ? gnot / m.price : gnot * m.price;
    token = is0 ? m.token1 : m.token0;
  }
  return token === target ? gnot : null;
}

/** Everything the list shows, for one time window. Pure, so it can be recomputed at will. */
export function summarize(s: Snapshot, a: Activity | null, window: number, now: number): Overview {
  const quotes = priceAll(s.markets, WUGNOT), byKey = new Map(s.markets.map((m) => [m.key, m])), since = now - window;
  const usable = a && a.span >= window ? a : null;
  const gnotOf = (t: string) => quotes.get(t)?.price ?? null;
  const inWindow = (m: LiveMarket) => (usable?.fills.get(m.key)?.fills ?? []).filter((f) => (usable!.times.get(f.height) ?? 0) >= since);
  const value = (m: LiveMarket): number => {
    const q1 = gnotOf(m.token1), q0 = gnotOf(m.token0);
    return inWindow(m).reduce((sum, f) => sum + (q1 !== null ? f.amount1 * q1 : q0 !== null ? f.amount0 * q0 : 0), 0);
  };
  const paths = [...new Set(s.markets.flatMap((m) => [m.token0, m.token1]))].filter((p) => p !== WUGNOT && s.tokens.has(p));
  const rows = paths.map((path): Row => {
    const token = s.tokens.get(path)!, q: Quote | undefined = quotes.get(path), mine = s.markets.filter((m) => m.token0 === path || m.token1 === path);
    const main = byKey.get(q?.route.at(-1) ?? '') ?? mine[0]!, known = usable && mine.every((m) => usable.fills.has(m.key));
    const then = q && usable ? along(q.route, path, (k) => { const m = byKey.get(k); return m && { token0: m.token0, token1: m.token1, price: priceAt(m, usable, since) }; }) : null;
    const sup = s.supply.get(path), born = mine.map((m) => s.created.get(m.key)).filter((x) => x !== undefined);
    const row: Row = {
      token, price: q?.price ?? null, depth: q && Number.isFinite(q.depth) ? q.depth : null, venue: main.venue, feePct: main.m.feePct, quote: main.token0 === path ? main.token1 : main.token0,
      marketCap: q && sup ? sup.supply * q.price : null, accounts: sup?.accounts ?? null, created: born.length ? Math.min(...born) : null,
      change: q && then ? (q.price / then - 1) * 100 : null,
      volume: known ? mine.reduce((n, m) => n + value(m), 0) : null, trades: known ? mine.reduce((n, m) => n + inWindow(m).length, 0) : null,
      partial: mine.some((m) => usable?.fills.get(m.key)?.partial), markets: mine.map((m) => m.key),
      venues: [...new Set(mine.map((m) => m.venue))],
    };
    if (main.stage !== undefined) row.stage = main.stage;
    return row;
  });
  const locked = s.markets.reduce((n, m) => n + (m.token0 === WUGNOT ? m.balance0 : m.token1 === WUGNOT ? m.balance1 : 0), 0);
  return { rows, locked, volume: usable ? s.markets.reduce((n, m) => n + value(m), 0) : null, trades: usable ? s.markets.reduce((n, m) => n + inWindow(m).length, 0) : null };
}

export interface MarketRow {
  key: string; venue: string; feePct: number; pairedWith: string; stage?: string; active: boolean; main: boolean;
  price: number;               // token in the paired token
  priceGnot: number | null; depthGnot: number | null;
  gap: number | null;          // percent away from the token's price
  volume: number | null; trades: number | null;
}
export interface TradeRow { market: string; venue: string; pairedWith: string; time: number; height: number; buy: boolean; price: number; priceGnot: number | null; amount: number; valueGnot: number | null; tx?: string; by?: string }
export interface Detail { row: Row; markets: MarketRow[]; trades: TradeRow[] }

/** One token seen from its own side: every market it trades in, and who traded lately. */
export function detail(s: Snapshot, a: Activity | null, path: string, window: number, now: number): Detail | null {
  const row = summarize(s, a, window, now).rows.find((r) => r.token.path === path);
  if (!row) return null;
  const quotes = priceAll(s.markets, WUGNOT), main = quotes.get(path)?.route.at(-1), usable = a && a.span >= window ? a : null, since = now - window;
  const mine = s.markets.filter((m) => m.token0 === path || m.token1 === path);
  const trades: TradeRow[] = [], markets = mine.map((m): MarketRow => {
    const is0 = m.token0 === path, pairedWith = is0 ? m.token1 : m.token0, q = quotes.get(pairedWith)?.price ?? null;
    const price = is0 ? m.price : 1 / m.price, priceGnot = q === null ? null : price * q, f = usable?.fills.get(m.key);
    const recent = (a?.fills.get(m.key)?.fills ?? []).flatMap((x): TradeRow[] => {
      const time = a!.times.get(x.height);
      if (time === undefined) return [];
      const p = is0 ? x.price : 1 / x.price, paid = is0 ? x.amount1 : x.amount0;
      const row: TradeRow = { market: m.key, venue: m.venue, pairedWith, time, height: x.height, buy: is0 === x.buy, price: p, priceGnot: q === null ? null : p * q, amount: is0 ? x.amount0 : x.amount1, valueGnot: q === null ? null : paid * q };
      if (x.tx) row.tx = x.tx;
      if (x.by) row.by = x.by;
      return [row];
    });
    trades.push(...recent);
    const inside = recent.filter((t) => t.time >= since);
    const out: MarketRow = {
      key: m.key, venue: m.venue, feePct: m.m.feePct, pairedWith, active: m.active, main: m.key === main, price, priceGnot,
      depthGnot: q === null ? null : (is0 ? m.balance1 : m.balance0) * q, gap: priceGnot !== null && row.price ? (priceGnot / row.price - 1) * 100 : null,
      volume: f ? inside.reduce((n, t) => n + (t.valueGnot ?? 0), 0) : null, trades: f ? inside.length : null,
    };
    if (m.stage !== undefined) out.stage = m.stage;
    return out;
  });
  markets.sort((x, y) => Number(y.main) - Number(x.main) || Number(y.active) - Number(x.active) || (y.depthGnot ?? 0) - (x.depthGnot ?? 0));
  trades.sort((x, y) => y.height - x.height || y.time - x.time);
  return { row, markets, trades };
}

export type Tab = 'trending' | 'gainers' | 'losers' | 'new' | 'volume';
const desc = (f: (r: Row) => number | null) => (a: Row, b: Row) => (f(b) ?? -Infinity) - (f(a) ?? -Infinity) || (b.depth ?? 0) - (a.depth ?? 0);
/** Changes under this are noise at the precision shown. */
export const FLAT = 0.005;
/** `venue`: only tokens that trade there, by label; empty for every market. */
export function pick(rows: readonly Row[], tab: Tab, query = '', venue = ''): Row[] {
  const q = query.trim().toLowerCase().replace(/^https?:\/\//, ''), list = rows.filter((r) => (!q || r.token.path.toLowerCase().includes(q)) && (!venue || r.venues.includes(venue)));
  switch (tab) {
    case 'gainers': return list.filter((r) => (r.change ?? 0) >= FLAT).sort(desc((r) => r.change));
    case 'losers': return list.filter((r) => (r.change ?? 0) <= -FLAT).sort(desc((r) => -r.change!));
    case 'new': return list.sort(desc((r) => r.created));
    case 'volume': return list.sort(desc((r) => r.volume));
    default: return list.sort(desc((r) => (r.trades ? (r.volume ?? 0) * (1 + Math.abs(r.change ?? 0) / 10) : 0)));
  }
}

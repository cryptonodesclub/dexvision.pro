const Q96 = 2 ** 96;

/**
 * Human price of token0 in token1. Dividing before squaring keeps the result within
 * 1 ulp of exact big-integer arithmetic (checked against every mainnet swap).
 */
export function price0in1(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  if (sqrtPriceX96 <= 0n) throw new RangeError('sqrtPriceX96 must be positive');
  const s = Number(sqrtPriceX96) / Q96;
  return s * s * 10 ** (dec0 - dec1);
}
export const toUnits = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

export interface PricedMarket {
  key: string; token0: string; token1: string;
  price: number;                      // token0 in token1
  balance0: number; balance1: number; // human units
  active: boolean;
}
export interface Quote { price: number; depth: number; route: string[] }

/**
 * Prices every reachable token in `base`, always through the deepest chain of markets:
 * a route is as deep as its shallowest market, measured in base units on the side already
 * priced, so a worthless token cannot inflate its own depth. Inactive markets are ignored.
 */
export function priceAll(markets: readonly PricedMarket[], base: string): Map<string, Quote> {
  const best = new Map<string, Quote>([[base, { price: 1, depth: Infinity, route: [] }]]);
  const done = new Set<string>();
  for (;;) {
    let token: string | undefined;
    for (const [t, q] of best) if (!done.has(t) && (token === undefined || q.depth > best.get(token)!.depth)) token = t;
    if (token === undefined) return best;
    done.add(token);
    const q = best.get(token)!;
    for (const m of markets) {
      if (!m.active || !(m.price > 0) || (m.token0 !== token && m.token1 !== token)) continue;
      const is0 = m.token0 === token, other = is0 ? m.token1 : m.token0;
      if (done.has(other)) continue;
      const depth = Math.min(q.depth, (is0 ? m.balance0 : m.balance1) * q.price), cur = best.get(other);
      // a market with no reserves yet still has a price (a fresh curve), but loses to any other
      if (cur && depth <= cur.depth) continue;
      best.set(other, { price: is0 ? q.price / m.price : q.price * m.price, depth, route: [...q.route, m.key] });
    }
  }
}

/** Markets that can matter for a target: drops dead-end tokens, such as other people's launches. */
export function relevant<M extends { token0: string; token1: string }>(markets: readonly M[], keep: readonly string[]): M[] {
  let list = [...markets];
  for (;;) {
    const degree = new Map<string, number>();
    for (const m of list) for (const t of [m.token0, m.token1]) degree.set(t, (degree.get(t) ?? 0) + 1);
    const next = list.filter((m) => [m.token0, m.token1].every((t) => keep.includes(t) || degree.get(t)! > 1));
    if (next.length === list.length) return list;
    list = next;
  }
}

export interface Candle { t: number; o: number; h: number; l: number; c: number; vol: number; swaps: number }
/** `buy`: the token was bought, when the source says which side it was. */
export interface Trade { t: number; price: number; vol: number; buy?: boolean }

/** Exponential moving average, seeded with the plain average of the first n. Null until there are n values. */
export function ema(values: readonly number[], n: number): (number | null)[] {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('period must be a positive whole number');
  const k = 2 / (n + 1), out: (number | null)[] = [];
  let sum = 0, e = 0;
  values.forEach((v, i) => {
    if (i < n) { sum += v; e = sum / n; out.push(i === n - 1 ? e : null); }
    else { e = v * k + e * (1 - k); out.push(e); }
  });
  return out;
}

export interface Sides { buys: number; sells: number; bought: number; sold: number }
/** How many trades of each side fall in each interval, and their volume. Keyed by interval start. */
export function sides(trades: readonly Trade[], interval: number): Map<number, Sides> {
  const out = new Map<number, Sides>();
  for (const t of trades) {
    if (t.buy === undefined) continue;
    const k = Math.floor(t.t / interval) * interval, s = out.get(k) ?? { buys: 0, sells: 0, bought: 0, sold: 0 };
    if (t.buy) { s.buys++; s.bought += t.vol; } else { s.sells++; s.sold += t.vol; }
    out.set(k, s);
  }
  return out;
}

/**
 * Candles for [from, to). Each opens at the previous close; periods without swaps repeat it.
 * Periods before any known price are omitted rather than drawn at zero.
 */
export function candles(trades: readonly Trade[], from: number, to: number, interval: number, seed?: number): Candle[] {
  if (!(interval > 0) || to <= from) throw new RangeError('empty range');
  const start = Math.floor(from / interval) * interval, n = Math.ceil((to - start) / interval);
  if (n > 20_000) throw new RangeError(`too many candles (${n}); use a longer interval`);
  const buckets = Array.from({ length: n }, (): Trade[] => []);
  for (const tr of trades) { const i = Math.floor((tr.t - start) / interval); if (i >= 0 && i < n) buckets[i]!.push(tr); }
  const out: Candle[] = [];
  let last = seed;
  buckets.forEach((b, i) => {
    const t = start + i * interval;
    if (!b.length) { if (last !== undefined) out.push({ t, o: last, h: last, l: last, c: last, vol: 0, swaps: 0 }); return; }
    const o = last ?? b[0]!.price, ps = b.map((x) => x.price), c = ps.at(-1)!;
    out.push({ t, o, h: Math.max(o, ...ps), l: Math.min(o, ...ps), c, vol: b.reduce((s, x) => s + x.vol, 0), swaps: b.length });
    last = c;
  });
  return out;
}

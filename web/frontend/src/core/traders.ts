import type { Fill } from './venues/venue.ts';

/** How much an account has moved through one market, in GNOT bought plus sold. */
export interface Tier { icon: string; name: string; min: number }
export const TIERS: readonly Tier[] = [
  { icon: '🦐', name: 'Shrimp', min: 0 },
  { icon: '🐟', name: 'Fish', min: 100 },
  { icon: '🐬', name: 'Dolphin', min: 1_000 },
  { icon: '🦈', name: 'Shark', min: 10_000 },
  { icon: '🐋', name: 'Whale', min: 100_000 },
];
export const tierOf = (volumeGnot: number): Tier => TIERS.findLast((t) => volumeGnot >= t.min) ?? TIERS[0]!;
const short = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}K` : String(n));
/** "1K–10K GNOT", "100K+ GNOT", "under 100 GNOT". */
export function tierRange(t: Tier): string {
  const next = TIERS[TIERS.indexOf(t) + 1];
  return t.min === 0 ? `under ${short(next!.min)} GNOT` : next ? `${short(t.min)}–${short(next.min)} GNOT` : `${short(t.min)}+ GNOT`;
}

/** One trade seen from the token's side. `paid`: the other token, in its own units. */
export interface BookTrade { height: number; buy: boolean; amount: number; paid: number; tx?: string }
/** Everything one account did in one market. Trades newest first. */
export interface Book { address: string; buys: number; sells: number; bought: number; sold: number; spent: number; got: number; trades: BookTrade[] }

/** Groups a market's trades by the account that signed them. Trades with no known signer are left out. */
export function books(fills: readonly Fill[], is0: boolean): Map<string, Book> {
  const out = new Map<string, Book>();
  for (const f of fills) {
    if (!f.by) continue;
    const buy = is0 === f.buy, amount = is0 ? f.amount0 : f.amount1, paid = is0 ? f.amount1 : f.amount0;
    let b = out.get(f.by);
    if (!b) out.set(f.by, b = { address: f.by, buys: 0, sells: 0, bought: 0, sold: 0, spent: 0, got: 0, trades: [] });
    if (buy) { b.buys++; b.bought += amount; b.spent += paid; } else { b.sells++; b.sold += amount; b.got += paid; }
    const t: BookTrade = { height: f.height, buy, amount, paid };
    if (f.tx) t.tx = f.tx;
    b.trades.push(t);
  }
  for (const b of out.values()) b.trades.reverse();
  return out;
}

/**
 * What an account's trades add up to, in GNOT. `toGnot` turns the paired token into GNOT (1 for GNOT
 * itself), at today's rate. `net` is what came back minus what went in; `left` is the tokens bought
 * here and not sold here, valued at `priceGnot`.
 */
export interface Outcome { spentGnot: number; gotGnot: number; volumeGnot: number; net: number; left: number; leftGnot: number | null; total: number | null; tier: Tier }
export function outcome(b: Book, toGnot: number, priceGnot: number | null): Outcome {
  const spentGnot = b.spent * toGnot, gotGnot = b.got * toGnot, volumeGnot = spentGnot + gotGnot, net = gotGnot - spentGnot;
  const left = Math.max(0, b.bought - b.sold), leftGnot = priceGnot === null ? null : left * priceGnot;
  return { spentGnot, gotGnot, volumeGnot, net, left, leftGnot, total: leftGnot === null ? null : net + leftGnot, tier: tierOf(volumeGnot) };
}

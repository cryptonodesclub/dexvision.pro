import { WUGNOT } from '../config.ts';
import { attrInt, TAIL, type ChainEvent, type EventFilter } from '../indexer.ts';
import { mapPool } from '../net.ts';
import { splitTokenPath } from '../paths.ts';
import { toUnits } from '../price.ts';
import { RpcError } from '../rpc.ts';
import { LAUNCHES } from '../seed.ts';
import type { Fill, Fills, Market, MarketState, Venue, VenueContext } from './venue.ts';

/**
 * Gnomi pads: memecoin launchpads. A token starts on a bonding curve with virtual reserves and,
 * once it raises enough, "graduates" to a constant-product pool inside the pad until it is listed
 * on a DEX. Quote is always wugnot.
 *
 * LaunchInfo() is deliberately not used: it joins fields with "|" and the creator chooses the name
 * and URI without that character being filtered, so a token could forge its own price.
 */
const OWNER = 'gno.land/r/g1n4pl5uc4yt5r96m9w6fmdznx3x0jyg8l6arhmt/gnomi/';
/** Realm and the block it was initialised at: nothing can have traded before. */
const SINCE: Record<string, number> = { [OWNER + 'padv3']: 205613, [OWNER + 'padv2']: 126611, [OWNER + 'pad']: 81668 };
export const PADS: readonly string[] = Object.keys(SINCE);

// constants of the deployed code, identical in the three versions
const VU0 = 102_375_071_625n;
export const VT0 = 1_073_000_191n;
const FEE_BPS = 120n, CREATOR_BPS = 4000n, PROTOCOL_BPS = 4000n, BPS = 10_000n;
const RING = 128;        // trades the contract keeps
const PRICE_SCALE = 1e6; // TradeHistory prices are ugnot per token x 1e6
const GNOT = 1e6;        // ugnot per GNOT
const TYPES = ['Buy', 'Sell', 'SwapBuy', 'SwapSell', 'Graduated'] as const;

const STREAM = 'gnomi:trade', KEEP = ['id', 'ugnot', 'tokens', 'poolUgnot', 'poolToken'] as const;
const groupOf = (e: ChainEvent) => `${e.pkg}:${e.attrs['id'] ?? ''}`;
const ID = /^[0-9a-z]{1,16}$/;
const ref = (m: { id: string }) => { const i = m.id.lastIndexOf(':'); return { pad: m.id.slice(0, i), launch: m.id.slice(i + 1) }; };

export interface Curve { u: bigint; t: bigint; graduated: boolean }
export const newCurve = (): Curve => ({ u: VU0, t: VT0, graduated: false });

export function fee(gross: bigint) {
  const total = (gross * FEE_BPS) / BPS, creator = (total * CREATOR_BPS) / BPS, protocol = (total * PROTOCOL_BPS) / BPS;
  return { total, net: gross - total, remainder: total - creator - protocol };
}
/** Replays one event with the contract's own integer arithmetic. Returns null for unrelated events. */
export function replay(c: Curve, e: ChainEvent): { ugnot: bigint; tokens: bigint; buy: boolean } | null {
  if (e.type === 'Graduated') {
    c.u = attrInt(e, 'poolUgnot'); c.t = attrInt(e, 'poolToken'); c.graduated = true;
    return { ugnot: 0n, tokens: 0n, buy: false };
  }
  const buy = e.type === 'Buy' || e.type === 'SwapBuy';
  if (!buy && e.type !== 'Sell' && e.type !== 'SwapSell') return null;
  const ugnot = attrInt(e, 'ugnot'), tokens = attrInt(e, 'tokens');
  if (buy) {
    const f = fee(ugnot);
    c.u += f.net + f.remainder; c.t -= tokens;
  } else if (c.graduated) {
    const t = c.t + tokens, gross = (c.u * tokens) / t;
    c.u += fee(gross).total - gross; c.t = t;
  } else {
    const t = c.t + tokens, u = (c.u * c.t) / t;
    c.u = u + fee(c.u - u).total; c.t = t;
  }
  return { ugnot, tokens, buy };
}
/** Same rounding as the contract's spotPriceScaled. */
export const spotScaled = (c: Curve): bigint => (c.t > 0n ? (c.u * 1_000_000n) / c.t : 0n);

export interface Sample { height: number; side: number; ugnot: bigint; tokens: bigint; scaled: bigint }
/** `height|side|ugnot|tokens|price` per line, all written by the contract. Keeps the last 128. */
export function parseTradeHistory(text: string): Sample[] {
  return text.split('\n').filter(Boolean).map((line) => {
    const m = /^(\d+)\|([012])\|(\d+)\|(\d+)\|(\d+)$/.exec(line);
    if (!m) throw new RpcError(`unexpected trade history line: ${line.slice(0, 80)}`);
    return { height: +m[1]!, side: +m[2]!, ugnot: BigInt(m[3]!), tokens: BigInt(m[4]!), scaled: BigInt(m[5]!) };
  });
}

interface Point { height: number; scaled: bigint; ugnot: bigint; tokens: bigint; buy: boolean }
/**
 * Full event history when its replay agrees with every price the contract still remembers;
 * otherwise the contract's own trades, which are partial once its ring buffer is full.
 */
export function reconcile(events: readonly ChainEvent[], history: readonly Sample[], indexedTo: number): { trusted: boolean; partial: boolean; points: Point[] } {
  const c = newCurve(), points = events.flatMap((e): Point[] => {
    const r = replay(c, e);
    return r ? [{ height: e.height, scaled: spotScaled(c), ...r }] : [];
  });
  // the RPC can be ahead of the indexer, and the opening mark is not a trade
  const tail = history.filter((h) => h.height <= indexedTo && (h.ugnot > 0n || h.tokens > 0n));
  const mine = tail.length ? points.slice(-tail.length) : [];
  const trusted = points.length >= tail.length && tail.every((h, i) => mine[i]!.height === h.height && mine[i]!.scaled === h.scaled);
  if (trusted) return { trusted, partial: false, points };
  return { trusted, partial: history.length >= RING, points: tail.map(({ height, side, scaled, ugnot, tokens }) => ({ height, scaled, buy: side === 0, ugnot: side === 2 ? 0n : ugnot, tokens: side === 2 ? 0n : tokens })) };
}

export const GNOMI_HISTORY = { stream: STREAM, keep: KEEP, realms: PADS };

export const LAUNCH_CREATED = (pad: string): EventFilter => ({ types: ['Created'], pkg: (p) => p === pad, pkgLike: pad });

export function gnomi(ctx: VenueContext, pads: readonly string[] = PADS): Venue {
  const known = new Map<string, Market | null>(); // a launch never changes token; null = unusable symbol
  const eval1 = (pad: string, fn: string, id: string) => `${pad}.${fn}("${id}")`;

  /** The contract's own trades. Shared by reads made together, never kept for long. */
  const reads = new Map<string, { at: number; list: Promise<Sample[]> }>();
  function past(m: { id: string }): Promise<Sample[]> {
    const hit = reads.get(m.id);
    if (hit && Date.now() - hit.at < 3000) return hit.list;
    const { pad, launch: id } = ref(m), list = ctx.rpc.evalString(eval1(pad, 'TradeHistory', id)).then(parseTradeHistory);
    reads.set(m.id, { at: Date.now(), list });
    list.catch(() => reads.delete(m.id));
    return list;
  }
  const unitOf = (t: { decimals: number }) => 10 ** t.decimals / PRICE_SCALE / GNOT;

  async function launch(pad: string, id: string): Promise<Market | null> {
    const key = `${pad}:${id}`, hit = known.get(key);
    if (hit !== undefined) return hit;
    const path = await ctx.rpc.evalString(eval1(pad, 'AdenaPathOf', id));
    let m: Market | null = null;
    try {
      // the creator picks the symbol, so make sure it is a plain one that belongs to this pad
      if (splitTokenPath(path).realm === pad) m = { venue: 'gnomi', id: key, token0: path, token1: WUGNOT, feePct: Number(FEE_BPS) / 100, height: LAUNCHES[key] ?? 0 };
    } catch { /* not a path we can safely use */ }
    if (m && !m.height) {
      const first = (await past(m).catch(() => []))[0]; // newer than the seed: its opening mark is still in the ring
      m.height = first?.side === 2 && first.ugnot === 0n ? first.height : (SINCE[pad] ?? 0);
    }
    known.set(key, m);
    return m;
  }
  const filter = (pad: string, id: string): EventFilter => ({ types: TYPES, pkg: (p) => p === pad, pkgLike: pad, attr: { key: 'id', values: [id] }, cache: { stream: STREAM, group: `${pad}:${id}`, groupOf, keep: KEEP } });

  return {
    id: 'gnomi', label: 'Gnomi pad',

    async markets() {
      const ids = (await Promise.all(pads.map(async (pad) => (await ctx.rpc.evalString(`${pad}.ListIDs()`)).split('\n').filter((id) => ID.test(id)).map((id) => [pad, id] as const)))).flat();
      return (await mapPool(ids, 6, ([pad, id]) => launch(pad, id))).filter((m) => m !== null);
    },

    async state(m): Promise<MarketState> {
      const { pad, launch: id } = ref(m);
      const [t, status, raised, pool, listed, released, history] = await Promise.all([
        ctx.token(m.token0), ctx.rpc.evalInt(eval1(pad, 'GetStatus', id)), ctx.rpc.evalInt(eval1(pad, 'GetRaised', id)), ctx.rpc.eval(eval1(pad, 'GetPool', id)),
        ctx.rpc.evalBool(eval1(pad, 'ListedOf', id)), ctx.rpc.evalBool(eval1(pad, 'ListSeedReleasedOf', id)), past(m),
      ]);
      const last = history.at(-1);
      if (!last) throw new RpcError(`${m.id} has no price yet`);
      const graduated = status === 1n;
      return {
        price: Number(last.scaled) * unitOf(t),
        // on the curve only the raised GNOT is real; the virtual reserve cannot be withdrawn
        balance1: toUnits(graduated ? BigInt(pool[0]?.value ?? 0) : raised, 6),
        balance0: graduated ? toUnits(BigInt(pool[1]?.value ?? 0), t.decimals) : 0,
        active: last.scaled > 0n && !listed && !released,
        stage: listed ? 'listed on a DEX' : graduated ? 'graduated' : 'curve',
      };
    },

    async fills(m, from, to): Promise<Fills> {
      const { pad, launch: id } = ref(m);
      // a curve has to be replayed from its start; history is read last so it can only be ahead
      const [t, latest] = await Promise.all([ctx.token(m.token0), ctx.indexer.latestHeight()]);
      const read = async () => {
        const events = await ctx.indexer.events(filter(pad, id), Math.max(1, m.height), latest + 1);
        return { events, history: parseTradeHistory(await ctx.rpc.evalString(eval1(pad, 'TradeHistory', id))) };
      };
      let { events, history } = await read(), checked = reconcile(events, history, latest);
      // what was remembered disagrees with the contract: forget it and read it all once more
      if (!checked.trusted) { await ctx.indexer.forget(STREAM, m.id); ({ events, history } = await read()); checked = reconcile(events, history, latest); }
      const { trusted, partial, points } = checked;
      const unit = unitOf(t);
      const all = points.map((p) => ({ height: p.height, buy: p.buy, price: Number(p.scaled) * unit, amount0: toUnits(p.tokens, t.decimals), amount1: toUnits(p.ugnot, 6) }));
      // a launch opens at a fixed price; the opening mark dates it while the ring still holds it
      const open = history[0]?.side === 2 && history[0].ugnot === 0n ? history[0] : undefined;
      const seed = all.filter((p) => p.height < from).at(-1)?.price ?? (trusted && open && open.height < from ? Number(open.scaled) * unit : undefined);
      const out: Fills = { fills: all.filter((p) => p.height >= from && p.height < to && p.amount0 > 0), partial }; // graduating is not a trade
      return seed === undefined ? out : { ...out, seed };
    },

    async peek(m) {
      const { pad, launch: id } = ref(m), got = await ctx.indexer.peek(filter(pad, id));
      // a curve can only be replayed from its very start
      if (!got || !got.covered.some(([a, b]) => a <= Math.max(1, m.height) && b > got.events.at(-1)!.height)) return null;
      const t = await ctx.token(m.token0), unit = unitOf(t), { points } = reconcile(got.events, [], 0);
      return { fills: points.map((p) => ({ height: p.height, buy: p.buy, price: Number(p.scaled) * unit, amount0: toUnits(p.tokens, t.decimals), amount1: toUnits(p.ugnot, 6) })).filter((p) => p.amount0 > 0) };
    },

    async mine(m, account, to) {
      const { pad, launch: id } = ref(m), f = filter(pad, id), [t, events] = await Promise.all([ctx.token(m.token0),
        ctx.indexer.events({ ...f, caller: account, cache: { ...f.cache!, stream: `gnomi:mine:${account}`, keep: [...KEEP, 'buyer', 'seller'] } }, Math.max(1, m.height), to)]);
      return events.flatMap((e): Fill[] => {
        if ((e.attrs['buyer'] ?? e.attrs['seller']) !== account) return [];
        const amount0 = toUnits(attrInt(e, 'tokens'), t.decimals), amount1 = toUnits(attrInt(e, 'ugnot'), 6);
        return amount0 > 0 ? [{ height: e.height, buy: e.type === 'Buy' || e.type === 'SwapBuy', price: amount1 / amount0, amount0, amount1 }] : [];
      });
    },

    async recent(ms, from, to) {
      const got = await Promise.allSettled(ms.map(async (m): Promise<[string, Fills]> => {
        const [t, h] = await Promise.all([ctx.token(m.token0), past(m)]), unit = unitOf(t);
        const fills = h.filter((x) => x.height >= from && x.height < to && x.side !== 2).map((x) => ({ height: x.height, buy: x.side === 0, price: Number(x.scaled) * unit, amount0: toUnits(x.tokens, t.decimals), amount1: toUnits(x.ugnot, 6) }));
        const before = h.filter((x) => x.height < from).at(-1), out: Fills = { fills, partial: !before && h.length >= RING };
        if (before) out.seed = Number(before.scaled) * unit;
        return [m.id, out];
      }));
      if (got.length && got.every((g) => g.status === 'rejected')) throw (got[0] as PromiseRejectedResult).reason;
      return new Map(got.flatMap((g) => (g.status === 'fulfilled' ? [g.value] : []))); // a missing market shows as unknown
    },

    async touched(from, to) {
      // one query for every pad: they share an owner prefix
      const all = await ctx.indexer.events({ types: TYPES, pkg: (p) => pads.includes(p), pkgLike: OWNER, cache: { stream: STREAM, group: null, groupOf, keep: KEEP } }, Math.max(1, from - TAIL), to);
      return [...new Set(all.filter((e) => e.height >= from).map(groupOf))];
    },
  };
}

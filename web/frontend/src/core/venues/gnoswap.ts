import { isAccount, realmAddress } from '../address.ts';
import { attrInt, BY, signer, TAIL, TX, attr, type ChainEvent, type EventFilter } from '../indexer.ts';
import { mapPool } from '../net.ts';
import { assertPoolPath } from '../paths.ts';
import { price0in1, toUnits } from '../price.ts';
import { RpcError } from '../rpc.ts';
import { SEED, type PoolSeed } from '../seed.ts';
import type { Fill, Fills, Market, MarketState, Stake, Venue, VenueContext } from './venue.ts';

const POOL = 'gno.land/r/gnoswap/pool';
/** Proxy realm or one of its versioned implementations (pool/v1, pool/v2…), nothing else. */
const isPool = (p: string) => p === POOL || p.startsWith(POOL + '/');
const POSITION = 'gno.land/r/gnoswap/position', STAKER = 'gno.land/r/gnoswap/staker';
const CHUNK = 40; // positions per round of reads
const positionsOf = (path: string): EventFilter => ({ types: ['Mint', 'IncreaseLiquidity', 'DecreaseLiquidity', 'Reposition'], pkg: (p) => p === POSITION || p.startsWith(POSITION + '/'), pkgLike: POSITION, attr: { key: 'poolPath', values: [path] },
  cache: { stream: 'gnoswap:lp', group: path, groupOf: (e) => e.attrs['poolPath'] ?? '', keep: ['poolPath', 'lpPositionId', 'positionLiquidity'] } });
const abs = (n: bigint) => (n < 0n ? -n : n);

export interface PoolInfo { path: string; token0: string; token1: string; fee: number; height: number; sqrtPriceX96: bigint }

export const POOL_CREATED: EventFilter = { types: ['CreatePool'], pkg: isPool, pkgLike: POOL };
const STREAM = 'gnoswap:swap', KEEP = ['poolPath', 'sqrtPriceX96', 'token0Amount', 'token1Amount', TX, BY] as const;
export const GNOSWAP_HISTORY = { stream: STREAM, keep: KEEP, realms: [POOL] } as const;
const poolOf = (e: ChainEvent) => e.attrs['poolPath'] ?? '';
const ALL_SWAPS: EventFilter = { types: ['Swap'], pkg: isPool, pkgLike: POOL, cache: { stream: STREAM, group: null, groupOf: poolOf, keep: KEEP } };
const swapsOf = (path: string): EventFilter => ({ types: ['Swap'], pkg: isPool, pkgLike: POOL, attr: { key: 'poolPath', values: [path] }, cache: { stream: STREAM, group: path, groupOf: poolOf, keep: KEEP } });

export function decodePool(e: ChainEvent): PoolInfo {
  const path = assertPoolPath(attr(e, 'poolPath')), [token0, token1, fee] = path.split(':') as [string, string, string];
  return { path, token0, token1, fee: Number(fee), height: e.height, sqrtPriceX96: attrInt(e, 'sqrtPriceX96') };
}

/** Concentrated liquidity AMM. The price is the pool's square-root price. */
export function gnoswap(ctx: VenueContext, seed: PoolSeed = SEED): Venue {
  let cursor = seed, recalled = false; // pools are permanent, so only newer blocks need scanning
  const checked = new Set<string>();
  const info = (m: Market): PoolInfo => {
    const p = cursor.pools.find((x) => x.path === m.id);
    if (!p) throw new Error(`unknown Gnoswap pool ${m.id}`);
    return p;
  };
  const decimals = async (m: Market): Promise<[number, number]> => {
    const [a, b] = await Promise.all([ctx.token(m.token0), ctx.token(m.token1)]);
    return [a.decimals, b.decimals];
  };

  const decode = (e: ChainEvent, [d0, d1]: [number, number]): Fill => ({ height: e.height, buy: attrInt(e, 'token0Amount') < 0n, price: price0in1(attrInt(e, 'sqrtPriceX96'), d0, d1), amount0: toUnits(abs(attrInt(e, 'token0Amount')), d0), amount1: toUnits(abs(attrInt(e, 'token1Amount')), d1), ...signer(e) });
  /** Price just before a height: the last swap, or the creation price once the pool exists. */
  async function seedAt(p: PoolInfo, at: number, [d0, d1]: [number, number]): Promise<number | undefined> {
    if (p.height >= at) return undefined;
    const prev = await ctx.indexer.lastEventBefore(swapsOf(p.path), at);
    return price0in1(prev ? attrInt(prev, 'sqrtPriceX96') : p.sqrtPriceX96, d0, d1);
  }

  return {
    id: 'gnoswap', label: 'Gnoswap',

    async markets() {
      // the height is asked first, so a pool created in between is simply found again next time
      if (!recalled) { recalled = true; const was = await ctx.indexer.recall<PoolSeed>('gnoswap:pools'); if (was && was.height > cursor.height && was.pools.length >= cursor.pools.length) cursor = was; }
      const from = cursor, latest = await ctx.indexer.latestHeight();
      const fresh = (await ctx.indexer.eventsAfter(POOL_CREATED, from.height)).map(decodePool).filter((p) => !from.pools.some((k) => k.path === p.path));
      cursor = { height: Math.max(from.height, latest - TAIL), pools: [...from.pools, ...fresh] };
      void ctx.indexer.note('gnoswap:pools', cursor);
      return cursor.pools.map((p) => ({ venue: 'gnoswap', id: p.path, token0: p.token0, token1: p.token1, feePct: p.fee / 1e4, height: p.height }));
    },

    async state(m): Promise<MarketState> {
      const q = `("${assertPoolPath(m.id)}")`;
      const [[d0, d1], sqrt, liquidity, bal] = await Promise.all([
        decimals(m), ctx.rpc.evalInt(`${POOL}.GetSlot0SqrtPriceX96${q}`), ctx.rpc.evalInt(`${POOL}.GetLiquidity${q}`), ctx.rpc.eval(`${POOL}.GetBalances${q}`),
      ]);
      const [b0, b1] = bal;
      if (!b0 || !b1) throw new RpcError(`unexpected balances for ${m.id}`);
      // with no liquidity in range the price is stale, so the pool is not active
      return { price: price0in1(sqrt, d0, d1), balance0: toUnits(BigInt(b0.value), d0), balance1: toUnits(BigInt(b1.value), d1), active: liquidity > 0n };
    },

    async fills(m, from, to): Promise<Fills> {
      const p = info(m), d = await decimals(m);
      const read = () => Promise.all([ctx.indexer.events(swapsOf(p.path), Math.max(from, p.height), to), seedAt(p, from, d)]);
      let [events, seed] = await read();
      // once per visit, check what was remembered against the pool itself, and start over if they disagree
      const last = events.at(-1);
      if (last && !checked.has(p.path)) {
        const [now, tip] = await Promise.all([ctx.rpc.evalInt(`${POOL}.GetSlot0SqrtPriceX96("${p.path}")`), ctx.indexer.latestHeight()]).catch(() => [null, 0] as const);
        if (now !== null && to > tip - TAIL) { // only the newest range can be compared with the present
          checked.add(p.path);
          const agrees = (e: ChainEvent | undefined) => e !== undefined && attrInt(e, 'sqrtPriceX96') === now;
          // a trade may have landed while reading, so look at the tail before doubting the rest
          if (!agrees(last) && !agrees((await ctx.indexer.events(swapsOf(p.path), last.height, tip + 1)).at(-1))) { await ctx.indexer.forget(STREAM, p.path); [events, seed] = await read(); }
        }
      }
      const fills = events.map((e) => decode(e, d));
      return seed === undefined ? { fills } : { seed, fills };
    },

    async peek(m) {
      const got = await ctx.indexer.peek(swapsOf(m.id));
      if (!got) return null;
      const d = await decimals(m);
      return { fills: got.events.map((e) => decode(e, d)) };
    },

    async mine(m, account, to) {
      const p = info(m), d = await decimals(m), f = swapsOf(p.path);
      const events = await ctx.indexer.events({ ...f, caller: account, cache: { ...f.cache!, stream: `gnoswap:mine:${account}` } }, p.height, to);
      return events.map((e) => { const x = decode(e, d); return { ...x, price: x.amount0 > 0 ? x.amount1 / x.amount0 : x.price }; });
    },

    async providers(m, to, progress) {
      const p = info(m), q = `("${assertPoolPath(m.id)}")`, [d0, d1] = await decimals(m), open = new Set<string>();
      // each event carries what the position was left with, so emptied ones need no reading
      for (const e of await ctx.indexer.events(positionsOf(p.path), p.height, to)) { const id = String(attrInt(e, 'lpPositionId')); if (attrInt(e, 'positionLiquidity') > 0n) open.add(id); else open.delete(id); }
      const ids = [...open], chunks: string[][] = [], home = await realmAddress(STAKER);
      for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
      let done = 0;
      const ownerIn = async (expr: string): Promise<string> => { const a = (await ctx.rpc.eval(expr))[0]!.value; if (!isAccount(a)) throw new RpcError(`no owner from ${expr}`); return a; };
      const stakes = (await mapPool(chunks, 8, async (c) => {
        const got = await Promise.all(c.map(async (id): Promise<Stake> => {
          const [holder, [b0, b1]] = await Promise.all([ownerIn(`${POSITION}.GetPositionOwner(${id})`), ctx.rpc.eval(`${POSITION}.GetPositionTokenBalances(${id})`)]);
          if (!b0 || !b1) throw new RpcError(`unexpected balances for position ${id}`);
          const staked = holder === home; // the staker keeps the position and remembers whose it is
          return { owner: staked ? await ownerIn(`${STAKER}.GetDepositOwner(${id})`) : holder, staked, amount0: toUnits(BigInt(b0.value), d0), amount1: toUnits(BigInt(b1.value), d1) };
        }));
        progress(++done / chunks.length);
        return got;
      })).flat();
      const [b0, b1] = await ctx.rpc.eval(`${POOL}.GetBalances${q}`);
      if (!b0 || !b1) throw new RpcError(`unexpected balances for ${m.id}`);
      return { stakes, balance0: toUnits(BigInt(b0.value), d0), balance1: toUnits(BigInt(b1.value), d1) };
    },

    async recent(ms, from, to) {
      const out = new Map<string, Fills>(ms.map((m) => [m.id, { fills: [] }]));
      const all = await ctx.indexer.events(ALL_SWAPS, from, to), dec = new Map(await Promise.all(ms.map(async (m) => [m.id, await decimals(m)] as const)));
      for (const e of all) { const id = e.attrs['poolPath'] ?? '', d = dec.get(id); if (d) out.get(id)!.fills.push(decode(e, d)); }
      // only pools that traded need their earlier price; the rest have not moved
      await Promise.all(ms.filter((m) => out.get(m.id)!.fills.length).map(async (m) => { const s = await seedAt(info(m), from, dec.get(m.id)!).catch(() => undefined); if (s !== undefined) out.get(m.id)!.seed = s; }));
      return out;
    },

    async touched(from, to) { return [...new Set((await ctx.indexer.events(ALL_SWAPS, Math.max(1, from - TAIL), to)).filter((e) => e.height >= from).map(poolOf))]; },
  };
}

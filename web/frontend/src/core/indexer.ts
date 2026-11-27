import { ALL, memoryStore, ranges, type Put, type Range, type Store } from './cache.ts';
import { mapPool, postJson, type NetOptions } from './net.ts';
import type { Decoded } from './snapshot.ts';

const PAGE = 10_000;       // hard cap of rows per query
const TIME_BATCH = 100;    // aliased point lookups; 200 exceeds the 4000-token limit
const CONCURRENCY = 4;
/** The newest blocks are read again next time: the indexer may announce a block just before its events. */
export const TAIL = 5;
/** Gaps closer than this are fetched together. */
const NEAR = 3000;
/** About 60 MB in a browser. Far above today's 7,000 events. */
const MAX_EVENTS = 40_000;

export class IndexerError extends Error {
  override name = 'IndexerError';
  code: string | undefined;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}

/** What a venue wants from the chain. Filters run on the server and again here. */
export interface EventFilter {
  types: readonly string[];
  pkg: (path: string) => boolean;      // authoritative check on the emitting realm
  pkgLike: string;                     // server-side narrowing
  attr?: { key: string; values: readonly string[] };
  /** Only transactions signed by this account. A swap event names the router, not the person. */
  caller?: string;
  /** Where to remember these events. `group` is null when the filter reads the whole stream. */
  cache?: { stream: string; group: string | null; groupOf: (e: ChainEvent) => string; keep: readonly string[] };
}
export interface ChainEvent { height: number; type: string; pkg: string; attrs: Record<string, string> }

interface RawEvent { type?: string; pkg_path?: string; attrs?: { key: string; value: string }[] }
interface Tx { block_height: number; response: { events: RawEvent[] | null } }

const TXS = `query($where: FilterTransaction!, $order: TransactionOrder, $limit: Int) {
  getTransactions(where: $where, order: $order, limit: $limit) {
    block_height response { events { ... on GnoEvent { type pkg_path attrs { key value } } } }
  }
}`;

function where(f: EventFilter, height: Record<string, number>) {
  const ev: Record<string, unknown> = { pkg_path: { like: f.pkgLike } };
  if (f.types.length === 1) ev['type'] = { eq: f.types[0] };
  if (f.attr) ev['attrs'] = { _and: [{ key: { eq: f.attr.key } }, { _or: f.attr.values.map((v) => ({ value: { eq: v } })) }] };
  return { ...(Object.keys(height).length ? { block_height: height } : {}), success: { eq: true }, ...(f.caller ? { messages: { value: { MsgCall: { caller: { eq: f.caller } } } } } : {}), response: { events: { GnoEvent: ev } } };
}
/** A transaction carries every event it emitted, including other pools' and other realms'. */
function pick(txs: Tx[] | null, f: EventFilter): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const tx of txs ?? []) for (const e of tx.response.events ?? []) {
    if (!e.type || !f.types.includes(e.type) || !f.pkg(e.pkg_path ?? '')) continue;
    const attrs = Object.fromEntries((e.attrs ?? []).map((a) => [a.key, a.value]));
    if (f.attr && !f.attr.values.includes(attrs[f.attr.key] ?? '')) continue;
    out.push({ height: tx.block_height, type: e.type, pkg: e.pkg_path ?? '', attrs });
  }
  return out;
}

/** Numbers events within their block and group, which is the same however they were fetched. */
function numbered(list: readonly ChainEvent[], c: NonNullable<EventFilter['cache']>): Put[] {
  const n = new Map<string, number>();
  return list.map((e) => {
    const group = c.groupOf(e), k = `${e.height}|${group}`, seq = n.get(k) ?? 0;
    n.set(k, seq + 1);
    return { group, seq, event: { ...e, attrs: Object.fromEntries(c.keep.flatMap((a) => (a in e.attrs ? [[a, e.attrs[a]!]] : []))) } };
  });
}

export function attr(e: ChainEvent, key: string): string {
  const v = e.attrs[key];
  if (v === undefined) throw new IndexerError(`${e.type} event at block ${e.height} has no "${key}": the contract may have changed its events`);
  return v;
}
export function attrInt(e: ChainEvent, key: string): bigint {
  const v = attr(e, key);
  if (!/^-?\d+$/.test(v)) throw new IndexerError(`${e.type} event at block ${e.height}: "${key}" is not a number (${v})`);
  return BigInt(v);
}

export class Indexer {
  url: string; net: NetOptions;
  private store: Store | undefined;
  private locks = new Map<string, Promise<unknown>>();
  constructor(url: string, net: NetOptions = {}, store?: Store) { this.url = url; this.net = net; this.store = store; }

  /** Storage is a convenience. The first time it fails, carry on without it. */
  private async remembered<T>(fn: (s: Store) => Promise<T>): Promise<T | undefined> {
    if (!this.store) return undefined;
    try { return await fn(this.store); } catch (e) { console.warn('History is not being kept between visits:', e); this.store = memoryStore(); return undefined; }
  }
  /** Resolves to true when the full history was loaded, so long ranges cost nothing. Reads wait for it. */
  whole: Promise<boolean> = Promise.resolve(false);
  private known: Promise<unknown> = Promise.resolve();
  /** Fills the cache from the published history, if this device is missing much of it. */
  prime(load: () => Promise<Decoded | null>, streams: readonly string[]): void {
    let seen: () => void = () => undefined;
    this.known = new Promise<void>((ok) => { seen = ok; });
    this.whole = (async () => {
      try {
        const d = await load();
        if (d) {
          for (const [h, ms] of d.times) this.times.set(h, ms);
          seen(); // dates can be placed already; saving the trades takes a little longer
          for (const [stream, puts] of d.streams) await this.remembered((s) => s.commit(stream, ALL, [1, d.height], puts));
          await this.remembered((s) => s.putTimes(d.times));
        }
        for (const stream of streams) { const cut = await this.remembered((s) => s.trim(stream, MAX_EVENTS)); if (cut) await this.note(`trimmed:${stream}`, cut); }
        const cov = await Promise.all(streams.map((x) => this.remembered((s) => s.coverage(x, ALL))));
        return cov.every((c) => c?.some(([a, b]) => a <= 1 && b > 100_000));
      } catch (e) { console.warn('The published history could not be used:', e); return false; } finally { seen(); }
    })();
  }
  /** What is remembered about a group, without asking anyone. Null when a trade has no known time. */
  async peek(f: EventFilter): Promise<{ events: ChainEvent[]; covered: readonly Range[] } | null> {
    const c = f.cache;
    if (!c || c.group === null || !this.store) return null;
    const g = c.group, got = await this.remembered(async (s) => ({ covered: ranges.union(...(await Promise.all([s.coverage(c.stream, ALL), s.coverage(c.stream, g)]))), rows: await s.events(c.stream, g, 0, Number.MAX_SAFE_INTEGER) }));
    await this.ready();
    return got?.rows.length && got.rows.every((x) => this.times.has(x.event.height)) ? { events: got.rows.map((x) => x.event), covered: got.covered } : null;
  }

  /** Reads of the same stream wait for each other, so the second finds the first one's work. */
  private exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = (await postJson(this.url, { query, variables }, this.net)) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    const e = r.errors?.[0];
    if (e) throw new IndexerError(e.message, e.extensions?.code);
    if (!r.data) throw new IndexerError('empty reply');
    return r.data;
  }

  private tip: { at: number; height: Promise<number> } | undefined;
  /** Asked from many places at once, so an answer is shared for a moment (less than a block). */
  latestHeight(): Promise<number> {
    if (!this.tip || Date.now() - this.tip.at > 2000) {
      const height = this.gql<{ latestBlockHeight: number }>('{ latestBlockHeight }').then((d) => d.latestBlockHeight);
      this.tip = { at: Date.now(), height };
      height.catch(() => { this.tip = undefined; });
    }
    return this.tip.height;
  }

  /** Events after a height, in one open-ended query. For rare events only. */
  async eventsAfter(f: EventFilter, after: number): Promise<ChainEvent[]> {
    const d = await this.gql<{ getTransactions: Tx[] | null }>(TXS, { where: where(f, { gt: after }), order: { heightAndIndex: 'ASC' } });
    if ((d.getTransactions?.length ?? 0) >= PAGE) throw new IndexerError('too many rows for an open query', 'MAX_ELEMENTS_REACHED');
    return pick(d.getTransactions, f);
  }

  /** Events in [from, to), in chain order. Anything already read comes from the device; only the gaps are asked for. */
  async events(f: EventFilter, from: number, to: number, window = 400_000): Promise<ChainEvent[]> {
    const c = f.cache;
    if (!c || !this.store || to <= from) return this.fetchEvents(f, from, to, window);
    await this.whole;
    const group = c.group ?? ALL;
    return this.exclusive(`${c.stream}|${group}`, async () => {
      const known = await this.remembered(async (s) => (c.group === null ? s.coverage(c.stream, ALL) : ranges.union(...(await Promise.all([s.coverage(c.stream, ALL), s.coverage(c.stream, c.group)])))));
      if (!known) return this.fetchEvents(f, from, to, window);
      const missing = ranges.coalesce(ranges.gaps(known, from, to), NEAR);
      const old = missing.length === 1 && missing[0]![0] === from && missing[0]![1] === to ? [] : await this.remembered((s) => s.events(c.stream, c.group, from, to));
      if (!old) return this.fetchEvents(f, from, to, window);
      // never vouch for blocks the indexer may still be filling in
      const safe = missing.length && missing.at(-1)![1] > this.settled ? Math.min(to, (await this.latestHeight()) - TAIL) : Infinity;
      if (Number.isFinite(safe)) this.settled = Math.max(this.settled, safe);
      const fresh: ChainEvent[] = [];
      for (const [a, b] of missing) {
        const got = await this.fetchEvents(f, a, b, window);
        fresh.push(...got);
        const until = Math.min(b, safe);
        if (until > a) await this.remembered((s) => s.commit(c.stream, group, [a, until], numbered(got.filter((e) => e.height < until), c)));
      }
      const inGap = (h: number) => missing.some(([a, b]) => h >= a && h < b);
      return [...old.map((x) => x.event).filter((e) => !inGap(e.height)), ...fresh].sort((x, y) => x.height - y.height); // stable: keeps order within a block
    });
  }
  private settled = 0;

  /** Drops what is remembered about one group, to read it again. */
  async forget(stream: string, group: string): Promise<void> { await this.remembered((s) => s.forget(stream, group)); }
  recall<T>(key: string): Promise<T | undefined> { return this.remembered((s) => s.get<T>(key)); }
  async note(key: string, v: unknown): Promise<void> { await this.remembered((s) => s.put(key, v)); }
  async clearCache(): Promise<void> { this.settled = 0; this.times.clear(); await this.remembered((s) => s.clear()); }

  /** Splits the range when the indexer hits a limit. */
  private async fetchEvents(f: EventFilter, from: number, to: number, window: number): Promise<ChainEvent[]> {
    if (to <= from) return [];
    const fetchRange = async (a: number, b: number): Promise<ChainEvent[]> => {
      try {
        const d = await this.gql<{ getTransactions: Tx[] | null }>(TXS, { where: where(f, { gt: a - 1, lt: b }), order: { heightAndIndex: 'ASC' } });
        if ((d.getTransactions?.length ?? 0) < PAGE) return pick(d.getTransactions, f);
        if (b - a <= 1) throw new IndexerError(`block ${a} alone exceeds the row limit`);
      } catch (e) {
        const limit = e instanceof IndexerError && (e.code === 'MAX_ELEMENTS_REACHED' || e.code === 'QUERY_DEADLINE_EXCEEDED');
        if (!limit || b - a <= 1) throw e;
      }
      const mid = a + Math.floor((b - a) / 2);
      return [...(await fetchRange(a, mid)), ...(await fetchRange(mid, b))];
    };
    const ranges: [number, number][] = [];
    for (let a = from; a < to; a += window) ranges.push([a, Math.min(a + window, to)]);
    return (await mapPool(ranges, CONCURRENCY, ([a, b]) => fetchRange(a, b))).flat();
  }

  /** Last matching event before `height`, or null. */
  async lastEventBefore(f: EventFilter, height: number): Promise<ChainEvent | null> {
    const c = f.cache;
    if (c && c.group !== null && this.store) {
      await this.whole;
      const g = c.group, hit = await this.remembered(async (s) => {
        const known = ranges.union(...(await Promise.all([s.coverage(c.stream, ALL), s.coverage(c.stream, g)]))), run = known.find(([x, y]) => x < height && y >= height);
        return run ? ((await s.events(c.stream, g, run[0], height)).at(-1)?.event ?? null) : null;
      });
      if (hit) return hit;
    }
    const d = await this.gql<{ getTransactions: Tx[] | null }>(TXS, { where: where(f, { lt: height }), order: { heightAndIndex: 'DESC' }, limit: 1 });
    const found = pick(d.getTransactions, f).at(-1) ?? null;
    // reading from there up remembers both the event and the silence after it
    if (found && c && c.group !== null && this.store) return (await this.events(f, found.height, height)).at(-1) ?? found;
    return found;
  }

  private times = new Map<number, number>(); // block times never change
  private loaded: Promise<void> | undefined;
  private ready(): Promise<void> {
    return this.loaded ??= this.remembered((s) => s.times()).then((t) => { for (const [h, ms] of t ?? []) this.times.set(h, ms); });
  }
  /** Block times in ms. One aliased point lookup per block: ~100 blocks per 250 ms. */
  async blockTimes(heights: Iterable<number>): Promise<Map<number, number>> {
    await Promise.all([this.ready(), this.known]);
    const all = [...new Set(heights)], todo = all.filter((h) => !this.times.has(h)), batches: number[][] = [];
    for (let i = 0; i < todo.length; i += TIME_BATCH) batches.push(todo.slice(i, i + TIME_BATCH));
    await mapPool(batches, CONCURRENCY, async (hs) => {
      const q = `{${hs.map((h) => `b${h}:getBlocks(where:{height:{eq:${h}}}){time}`).join(' ')}}`;
      const d = await this.gql<Record<string, { time: string }[] | null>>(q), fresh: [number, number][] = [];
      for (const h of hs) {
        const t = Date.parse(d['b' + h]?.[0]?.time ?? '');
        if (Number.isNaN(t)) throw new IndexerError(`the indexer has no block ${h}`);
        this.times.set(h, t); fresh.push([h, t]);
      }
      await this.remembered((s) => s.putTimes(fresh));
    });
    return new Map(all.map((h) => [h, this.times.get(h)!]));
  }

  /**
   * First height whose block time is >= t, or latest + 1. Interpolates on the near-constant
   * block interval and falls back to halving, so it takes a handful of lookups instead of ~20.
   * With a tolerance it may return an earlier height, at most that many ms before t.
   */
  async heightAt(t: number, latest: number, tolerance = 0): Promise<number> {
    const at = async (h: number) => (await this.blockTimes([h])).get(h)!;
    const ends = await this.blockTimes([1, latest]);
    let lo = 1, hi = latest, tLo = ends.get(1)!, tHi = ends.get(latest)!; // invariant: time(lo) < t <= time(hi)
    for (const [h, ms] of this.times) { // any block seen before narrows the search for free
      if (h > latest) continue;
      if (ms < t && h > lo) { lo = h; tLo = ms; } else if (ms >= t && h < hi) { hi = h; tHi = ms; }
    }
    if (tHi < t) return latest + 1;
    if (tLo >= t) return lo;
    for (let i = 0; hi - lo > 1; i++) {
      if (tolerance && t - tLo <= tolerance) return lo;
      const aim = t - tolerance / 2; // land just before t when there is room to
      const guess = i % 3 === 2 ? lo + (hi - lo) / 2 : lo + ((aim - tLo) / (tHi - tLo)) * (hi - lo);
      const mid = Math.min(hi - 1, Math.max(lo + 1, Math.round(guess))), tm = await at(mid);
      if (tm < t) { lo = mid; tLo = tm; } else { hi = mid; tHi = tm; }
    }
    return hi;
  }
}

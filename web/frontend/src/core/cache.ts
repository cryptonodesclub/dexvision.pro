/**
 * What the chain has already said and will never change: events, block times, pools, decimals.
 * The unit is a covered range of blocks per stream, not a response, so any screen can reuse what
 * another one read and only the gaps are ever asked for again.
 */
export type Range = readonly [from: number, to: number]; // [from, to)

export const ranges = {
  /** Sorted, merged list with `r` included. */
  add(list: readonly Range[], r: Range): Range[] {
    if (r[1] <= r[0]) return [...list];
    const out: Range[] = [];
    let [a, b] = r;
    for (const [x, y] of list) {
      if (y < a || x > b) out.push([x, y]);
      else { a = Math.min(a, x); b = Math.max(b, y); }
    }
    return [...out, [a, b] as const].sort((p, q) => p[0] - q[0]);
  },
  union: (...lists: readonly (readonly Range[])[]): Range[] => lists.flat().reduce<Range[]>((acc, r) => ranges.add(acc, r), []),
  /** Parts of [from, to) that `list` does not cover. */
  gaps(list: readonly Range[], from: number, to: number): Range[] {
    const out: Range[] = [];
    let at = from;
    for (const [x, y] of list) {
      if (y <= at) continue;
      if (x >= to) break;
      if (x > at) out.push([at, x]);
      at = Math.max(at, y);
    }
    if (at < to) out.push([at, to]);
    return out;
  },
  /** Joins gaps separated by little: one slightly larger query beats many tiny ones. */
  coalesce(list: readonly Range[], near: number): Range[] {
    const out: [number, number][] = [];
    for (const [x, y] of list) { const l = out.at(-1); if (l && x - l[1] <= near) l[1] = y; else out.push([x, y]); }
    return out;
  },
};

export interface CachedEvent { height: number; type: string; pkg: string; attrs: Record<string, string> }
export interface Put { group: string; seq: number; event: CachedEvent }

export interface Store {
  coverage(stream: string, group: string): Promise<Range[]>;
  events(stream: string, group: string | null, from: number, to: number): Promise<{ group: string; event: CachedEvent }[]>;
  /** Saves events and the range they complete, atomically: never one without the other. */
  commit(stream: string, group: string, range: Range, puts: readonly Put[]): Promise<void>;
  forget(stream: string, group: string): Promise<void>;
  times(): Promise<[number, number][]>;
  putTimes(t: readonly [number, number][]): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, v: unknown): Promise<void>;
  /** Drops the oldest events of a stream so that at most `keep` remain, and stops vouching for them. Returns the cut, or 0. */
  trim(stream: string, keep: number): Promise<number>;
  clear(): Promise<void>;
}
/** Group under which a read of the whole stream is recorded. It covers every group. */
export const ALL = '*';

const VERSION = 1;
const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const done = (t: IDBTransaction) => new Promise<void>((ok, no) => { t.oncomplete = () => ok(); t.onerror = t.onabort = () => no(t.error ?? new Error('transaction aborted')); });

/** One database per chain, so a testnet can never leak into mainnet. */
export function indexedDbStore(chainId: string, factory: IDBFactory = indexedDB): Store {
  const name = `dexvision:${chainId}`;
  let opening: Promise<IDBDatabase> | undefined;
  const open = () => opening ??= new Promise<IDBDatabase>((ok, no) => {
    const r = factory.open(name, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of [...db.objectStoreNames]) db.deleteObjectStore(s); // everything here can be read again
      db.createObjectStore('events', { keyPath: ['s', 'g', 'h', 'n'] }).createIndex('byHeight', ['s', 'h']);
      db.createObjectStore('coverage', { keyPath: ['s', 'g'] });
      db.createObjectStore('times'); db.createObjectStore('meta');
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); opening = undefined; }; // another tab is upgrading or clearing
      ok(db);
    };
    r.onerror = () => no(r.error); r.onblocked = () => no(new Error('database blocked'));
  }).catch((e: unknown) => { opening = undefined; throw e; });

  interface Row { s: string; g: string; h: number; n: number; e: CachedEvent }
  const span = (stream: string, group: string) => IDBKeyRange.bound([stream, group], [stream, group, []]);
  return {
    async coverage(stream, group) {
      const row = await req<{ r: Range[] } | undefined>((await open()).transaction('coverage').objectStore('coverage').get([stream, group]));
      return row?.r ?? [];
    },
    async events(stream, group, from, to) {
      const s = (await open()).transaction('events').objectStore('events');
      const rows = await req<Row[]>(group === null ? s.index('byHeight').getAll(IDBKeyRange.bound([stream, from], [stream, to], false, true)) : s.getAll(IDBKeyRange.bound([stream, group, from], [stream, group, to], false, true)));
      return rows.sort((a, b) => a.h - b.h || (a.g < b.g ? -1 : a.g > b.g ? 1 : a.n - b.n)).map((x) => ({ group: x.g, event: x.e }));
    },
    async commit(stream, group, range, puts) {
      const t = (await open()).transaction(['events', 'coverage'], 'readwrite'), c = t.objectStore('coverage'), ev = t.objectStore('events'), end = done(t);
      for (const p of puts) ev.put({ s: stream, g: p.group, h: p.event.height, n: p.seq, e: p.event } satisfies Row);
      const row = await req<{ r: Range[] } | undefined>(c.get([stream, group])); // read inside the write, so tabs do not overwrite each other
      c.put({ s: stream, g: group, r: ranges.add(row?.r ?? [], range) });
      await end;
    },
    async forget(stream, group) {
      const t = (await open()).transaction(['events', 'coverage'], 'readwrite'), end = done(t);
      t.objectStore('events').delete(span(stream, group));
      // the whole-stream record also vouches for this group, so it has to go too
      t.objectStore('coverage').delete([stream, group]); t.objectStore('coverage').delete([stream, ALL]);
      await end;
    },
    async times() {
      const s = (await open()).transaction('times').objectStore('times'), [k, v] = await Promise.all([req(s.getAllKeys()), req<number[]>(s.getAll())]);
      return k.map((h, i) => [h as number, v[i]!]);
    },
    async putTimes(list) { const t = (await open()).transaction('times', 'readwrite'), end = done(t), s = t.objectStore('times'); for (const [h, ms] of list) s.put(ms, h); await end; },
    async get(key) { return req((await open()).transaction('meta').objectStore('meta').get(key)); },
    async put(key, v) { const t = (await open()).transaction('meta', 'readwrite'), end = done(t); t.objectStore('meta').put(v, key); await end; },
    async trim(stream, keep) {
      const t = (await open()).transaction(['events', 'coverage'], 'readwrite'), end = done(t), s = t.objectStore('events'), c = t.objectStore('coverage');
      const all = IDBKeyRange.bound([stream], [stream, []]), n = await req(s.count(all));
      if (n <= keep) return 0;
      const keys = (await req(s.getAllKeys(all))) as unknown as [string, string, number, number][], cut = keys.map((k) => k[2]).sort((a, b) => a - b)[n - keep]!;
      for (const k of keys) if (k[2] < cut) s.delete(k as unknown as IDBValidKey);
      for (const row of await req<{ s: string; g: string; r: Range[] }[]>(c.getAll(all))) c.put({ ...row, r: row.r.flatMap(([a, b]): Range[] => (b <= cut ? [] : [[Math.max(a, cut), b]])) });
      await end;
      return cut;
    },
    async clear() { const t = (await open()).transaction(['events', 'coverage', 'times', 'meta'], 'readwrite'), end = done(t); for (const s of ['events', 'coverage', 'times', 'meta']) t.objectStore(s).clear(); await end; },
  };
}

/** Same contract, for this visit only: used when the browser has no storage, and by the command line. */
export function memoryStore(): Store {
  const ev = new Map<string, Map<string, { g: string; h: number; n: number; e: CachedEvent }>>(), cov = new Map<string, Range[]>(), time = new Map<number, number>(), meta = new Map<string, unknown>();
  const of = (s: string) => ev.get(s) ?? ev.set(s, new Map()).get(s)!, key = (s: string, g: string) => `${s}\n${g}`;
  return {
    async coverage(s, g) { return cov.get(key(s, g)) ?? []; },
    async events(s, g, from, to) { return [...of(s).values()].filter((x) => (g === null || x.g === g) && x.h >= from && x.h < to).sort((a, b) => a.h - b.h || (a.g < b.g ? -1 : a.g > b.g ? 1 : a.n - b.n)).map((x) => ({ group: x.g, event: x.e })); },
    async commit(s, g, r, puts) { for (const p of puts) of(s).set(`${p.group}\n${p.event.height}\n${p.seq}`, { g: p.group, h: p.event.height, n: p.seq, e: p.event }); cov.set(key(s, g), ranges.add(cov.get(key(s, g)) ?? [], r)); },
    async forget(s, g) { for (const [k, x] of of(s)) if (x.g === g) of(s).delete(k); cov.delete(key(s, g)); cov.delete(key(s, ALL)); },
    async times() { return [...time]; },
    async putTimes(t) { for (const [h, ms] of t) time.set(h, ms); },
    async get<T>(k: string) { return meta.get(k) as T | undefined; },
    async put(k, v) { meta.set(k, v); },
    async trim() { return 0; },
    async clear() { ev.clear(); cov.clear(); time.clear(); meta.clear(); },
  };
}

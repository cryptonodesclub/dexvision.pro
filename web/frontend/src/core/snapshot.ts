import { ALL, ranges, type Put, type Store } from './cache.ts';

/** The whole history in one file, written by services/history. Only used to fill the local cache. */
export interface Expected { stream: string; keep: readonly string[]; realms: readonly string[] }
interface FileStream { realms: string[]; keep: string[]; types: string[]; pkgs: string[]; groups: string[]; rows: [number, number, number, number, ...string[]][] }
interface HistoryFile { v: number; chain: string; height: number; streams: Record<string, FileStream>; times: [number, number][] }
export interface Manifest { v: number; chain: string; height: number; file: string; bytes: number }
export interface Decoded { height: number; streams: Map<string, Put[]>; times: [number, number][] }

const fail = (why: string): never => { throw new Error(`history file: ${why}`); };
const whole = (n: unknown): number => (Number.isSafeInteger(n) ? (n as number) : fail('not a whole number'));

export function checkManifest(x: unknown, chain: string): Manifest {
  const m = x as Manifest;
  if (m?.v !== 1 || m.chain !== chain || !(whole(m.height) > 0) || !/^history-\d+\.json$/.test(m.file)) fail('unexpected manifest');
  return m;
}

/** Throws on anything odd: a half-read file must never be taken for the truth. */
export function decodeHistory(x: unknown, chain: string, expected: readonly Expected[]): Decoded {
  const f = x as HistoryFile;
  if (f?.v !== 1 || f.chain !== chain) fail('another version or chain');
  const out: Decoded = { height: whole(f.height), streams: new Map(), times: [] };
  for (const want of expected) {
    const s = f.streams[want.stream];
    // a file that knows fewer realms or attributes cannot vouch for what this page needs
    if (!s || !want.realms.every((r) => s.realms.includes(r)) || !want.keep.every((k) => s.keep.includes(k))) continue;
    const puts: Put[] = [], n = new Map<string, number>();
    let height = 0;
    for (const r of s.rows) {
      const [d, g, t, p] = r, group = s.groups[whole(g)], type = s.types[whole(t)], pkg = s.pkgs[whole(p)];
      if (group === undefined || type === undefined || pkg === undefined || whole(d) < 0 || r.length - 4 > s.keep.length) fail('malformed row');
      height += d;
      if (height < 1 || height >= out.height) fail('row outside its range');
      const attrs: Record<string, string> = {};
      for (let i = 4; i < r.length; i++) { const v = r[i]; if (typeof v !== 'string') fail('malformed value'); if (v !== '') attrs[s.keep[i - 4]!] = v === '=' ? group! : (v as string); }
      const k = `${height}|${group}`, seq = n.get(k) ?? 0;
      n.set(k, seq + 1);
      puts.push({ group: group!, seq, event: { height, type: type!, pkg: pkg!, attrs } });
    }
    out.streams.set(want.stream, puts);
  }
  let h = 0, ms = 0;
  for (const [dh, dt] of f.times) { h += whole(dh); ms += whole(dt); out.times.push([h, ms]); }
  return out;
}

/** Worth downloading only if this much is missing; smaller gaps are cheaper to ask the indexer for. */
const WORTH_IT = 20_000;
export async function isWorthIt(store: Store, height: number, expected: readonly Expected[]): Promise<boolean> {
  for (const e of expected) {
    if (await store.get(`trimmed:${e.stream}`)) continue; // dropped on purpose to save space
    const missing = ranges.gaps(await store.coverage(e.stream, ALL), 1, height).reduce((n, [a, b]) => n + b - a, 0);
    if (missing > WORTH_IT) return true;
  }
  return false;
}

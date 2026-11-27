import { isAccount } from './address.ts';
import { attrInt, TAIL, type ChainEvent, type EventFilter, type Indexer } from './indexer.ts';
import { mapPool } from './net.ts';

/** Balances of a token, rebuilt by adding up every transfer since the start of the chain. */
export interface Ledger { height: number; balances: Map<string, bigint>; /** "from|to" between two accounts: how many times and how much. */ sent: Map<string, { n: number; v: bigint }> }
export interface Link { a: string; b: string; times: number; value: bigint }
/** `quiet`: no signature on record. It may be a multisig, an unused account or a contract nobody could name. `unread`: not looked up. */
export type Kind = 'wallet' | 'contract' | 'quiet' | 'unread';
export interface Holder { address: string; amount: number; /** 0 to 1. */ share: number; kind: Kind; realm?: string }
export interface HolderSet {
  holders: Holder[]; links: Link[]; supply: number; height: number;
  /** `exact`: supply and the largest balances match the contract. `silent`: the token does not record its transfers. */
  state: 'exact' | 'differs' | 'silent' | 'empty';
  /** False when contracts could not be told apart from wallets. */
  named: boolean;
}

export const emptyLedger = (): Ledger => ({ height: 0, balances: new Map(), sent: new Map() });
export const copyLedger = (l: Ledger): Ledger => ({ height: l.height, balances: new Map(l.balances), sent: new Map([...l.sent].map(([k, x]) => [k, { ...x }])) });

/** Order does not matter, so ranges can be read in parallel. An empty side is a mint or a burn. */
export function add(l: Ledger, events: readonly ChainEvent[]): void {
  for (const e of events) {
    const from = e.attrs['from'] ?? '', to = e.attrs['to'] ?? '', v = attrInt(e, 'value');
    if (from === to) continue;
    for (const [who, d] of [[from, -v], [to, v]] as const) {
      if (!who) continue;
      const now = (l.balances.get(who) ?? 0n) + d;
      if (now === 0n) l.balances.delete(who); else l.balances.set(who, now);
    }
    if (from && to) { const k = `${from}|${to}`, s = l.sent.get(k); if (s) { s.n++; s.v += v; } else l.sent.set(k, { n: 1, v }); }
  }
}
export const totalOf = (l: Ledger): bigint => { let s = 0n; for (const v of l.balances.values()) s += v; return s; };
export const ranked = (l: Ledger): [string, bigint][] => [...l.balances].filter(([, v]) => v > 0n).sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : x[0] < y[0] ? -1 : 1));

/** Pairs that sent this token to each other, either way. */
export function linksOf(l: Ledger): Link[] {
  const out = new Map<string, Link>();
  for (const [k, s] of l.sent) {
    const [x, y] = k.split('|') as [string, string], [a, b] = x < y ? [x, y] : [y, x], id = `${a}|${b}`, had = out.get(id);
    if (had) { had.times += s.n; had.value += s.v; } else out.set(id, { a, b, times: s.n, value: s.v });
  }
  return [...out.values()];
}
/** Sets of accounts joined by links, two or more each, largest set first. */
export function groupsOf(members: readonly string[], links: readonly Link[]): string[][] {
  const up = new Map(members.map((m) => [m, m]));
  const root = (x: string): string => { let r = x; while (up.get(r) !== r) r = up.get(r)!; up.set(x, r); return r; };
  for (const { a, b } of links) if (up.has(a) && up.has(b)) up.set(root(a), root(b));
  const sets = new Map<string, string[]>();
  for (const m of members) { const r = root(m); (sets.get(r) ?? sets.set(r, []).get(r)!).push(m); }
  return [...sets.values()].filter((s) => s.length > 1).sort((a, b) => b.length - a.length);
}

const STEP = 200_000;
const filter = (id: string): EventFilter => ({ types: ['Transfer'], pkg: (p) => p.startsWith('gno.land/p/nt/grc20/'), pkgLike: 'gno.land/p/nt/grc20/', attr: { key: 'token', values: [id] } });

/** The ledger as of `tip`. What is settled is remembered as a summary, so later visits read only what is new. */
export async function readLedger(ix: Indexer, id: string, tip: number, fresh: boolean, progress: (part: number) => void): Promise<{ ledger: Ledger; remembered: boolean }> {
  const key = `ledger:1:${id}`, had = fresh ? undefined : await ix.recall<Ledger>(key), base = had ? copyLedger(had) : emptyLedger();
  const f = filter(id), safe = Math.max(base.height + 1, tip - TAIL + 1), spans: [number, number][] = [];
  for (let a = base.height + 1; a < safe; a += STEP) spans.push([a, Math.min(a + STEP, safe)]);
  let done = 0;
  await mapPool(spans, 4, async ([a, b]) => { add(base, await ix.events(f, a, b)); progress(++done / spans.length); });
  base.height = safe - 1;
  await ix.note(key, copyLedger(base));
  add(base, await ix.events(f, safe, tip + 1));
  base.height = Math.max(tip, base.height);
  return { ledger: base, remembered: had !== undefined };
}

/** Whether an account has ever signed. Accounts the chain does not know have no key either. */
export function hasSigned(reply: string): boolean {
  try { const j = JSON.parse(reply) as { BaseAccount?: Record<string, unknown> } | null, b = (j?.BaseAccount ?? j) as Record<string, unknown> | null; return !!b && (Number(b['sequence'] ?? 0) > 0 || !!b['public_key']); } catch { return false; }
}
export const readable = (list: readonly [string, bigint][], n: number): string[] => list.filter(([a]) => isAccount(a)).slice(0, n).map(([a]) => a);

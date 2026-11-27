/**
 * The few protobuf messages needed to dry-run a transaction, checked byte for byte against
 * @gnolang/gno-js-client in the tests. Nothing here signs or broadcasts.
 */
export interface Call { caller: string; send: string; max_deposit: string; pkg_path: string; func: string; args: string[] }

const enc = new TextEncoder(), dec = new TextDecoder();
function varint(n: bigint): number[] {
  const out: number[] = [];
  for (; n > 127n; n >>= 7n) out.push(Number(n & 127n) | 128);
  return [...out, Number(n)];
}
const field = (no: number, b: Uint8Array): number[] => (b.length ? [...varint(BigInt((no << 3) | 2)), ...varint(BigInt(b.length)), ...b] : []);
const text = (no: number, s: string) => field(no, enc.encode(s));
const sint = (no: number, n: bigint): number[] => (n ? [...varint(BigInt(no << 3)), ...varint(n >= 0n ? n * 2n : -n * 2n - 1n)] : []);
const bytes = (...p: number[][]) => Uint8Array.from(p.flat());
const any = (url: string, v: Uint8Array) => bytes(text(1, url), field(2, v));

const encodeCall = (c: Call) => bytes(text(1, c.caller), text(2, c.send), text(3, c.max_deposit), text(4, c.pkg_path), text(5, c.func),
  ...c.args.map((a) => (a ? text(6, a) : [(6 << 3) | 2, 0]))); // an empty argument still counts

export function encodeTx(calls: readonly Call[], gasWanted: number, gasFee: number, pubKey?: Uint8Array): Uint8Array {
  const key = pubKey ? field(1, any('/tm.PubKeySecp256k1', bytes(field(1, pubKey)))) : [];
  return bytes(...calls.map((c) => field(1, any('/vm.m_call', encodeCall(c)))), field(2, bytes(sint(1, BigInt(gasWanted)), text(2, `${gasFee}ugnot`))), field(3, bytes(key, field(2, new Uint8Array(64)))));
}

type Field = { no: number; n: bigint; b: Uint8Array };
function* fields(b: Uint8Array): Generator<Field> {
  let i = 0;
  const num = (): bigint => { let n = 0n; for (let s = 0n; ; s += 7n) { const x = b[i++]; if (x === undefined) throw new RangeError('truncated message'); n |= BigInt(x & 127) << s; if (x < 128) return n; } };
  while (i < b.length) {
    const tag = Number(num()), no = tag >> 3, wire = tag & 7;
    if (wire === 0) yield { no, n: num(), b: new Uint8Array() };
    else if (wire === 2) { const len = Number(num()); if (i + len > b.length) throw new RangeError('truncated message'); yield { no, n: 0n, b: b.subarray(i, i + len) }; i += len; }
    else throw new RangeError(`unsupported wire type ${wire}`);
  }
}
const unzig = (n: bigint) => (n & 1n ? -((n + 1n) >> 1n) : n >> 1n);

export interface Simulated { ok: boolean; error: string; gasUsed: number; /** Net ugnot the chain keeps as storage deposit. */ deposit: number; data: string }
export function decodeResult(raw: Uint8Array): Simulated {
  const out: Simulated = { ok: true, error: '', gasUsed: 0, deposit: 0, data: '' };
  let log = '';
  for (const f of fields(raw)) {
    if (f.no === 3) out.gasUsed = Number(unzig(f.n));
    if (f.no !== 1) continue;
    for (const r of fields(f.b)) {
      if (r.no === 1) { out.ok = false; for (const a of fields(r.b)) if (a.no === 2) try { for (const s of fields(a.b)) if (s.no === 1) out.error = dec.decode(s.b); } catch { out.error = dec.decode(a.b); } }
      else if (r.no === 2) out.data = dec.decode(r.b);
      else if (r.no === 4) log = dec.decode(r.b);
      else if (r.no === 3) {
        let url = '', v = new Uint8Array();
        for (const a of fields(r.b)) { if (a.no === 1) url = dec.decode(a.b); else if (a.no === 2) v = a.b as Uint8Array<ArrayBuffer>; }
        const sign = url === '/tm.StorageDepositEvent' ? 1 : url === '/tm.StorageUnlockEvent' ? -1 : 0;
        if (!sign) continue;
        let coins = 0, withheld = false;
        for (const a of fields(v)) { if (a.no === 2) coins = Number(/^(\d+)ugnot$/.exec(dec.decode(a.b))?.[1] ?? 0); else if (a.no === 4) withheld = a.n !== 0n; }
        if (!withheld) out.deposit += sign * coins;
      }
    }
  }
  if (!out.ok && !out.error) out.error = log || 'the chain rejected the transaction';
  return out;
}

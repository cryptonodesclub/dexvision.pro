import { postJson, type NetOptions } from './net.ts';

export class RpcError extends Error { override name = 'RpcError'; }

export interface GnoValue { value: string; type: string }

/** Parses qeval output: one `(value type)` per line, e.g. `("123" string)` or `(6 int)`. */
export function parseGno(text: string): GnoValue[] {
  return text.split('\n').flatMap((line) => {
    const m = /^\((?:"((?:[^"\\]|\\.)*)"|([^()\s]+)) (\S+)\)$/.exec(line.trim());
    return m ? [{ value: m[1] === undefined ? m[2]! : unquote(m[1]), type: m[3]! }] : [];
  });
}

/** Go-quoted text is JSON-compatible for the ASCII these calls return; anything else stays raw. */
function unquote(s: string): string { try { return JSON.parse(`"${s}"`) as string; } catch { return s; } }

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

interface AbciReply { id?: number; error?: unknown; result?: { response?: { ResponseBase?: { Data?: string | null; Error?: unknown } } } }
interface Pending { path: string; data: string; ok(v: string): void; fail(e: unknown): void }

/** Reads made within a few ms share a request: kinder to a public node, and faster. */
const BATCH = 40, WINDOW_MS = 4;

export class Rpc {
  url: string; net: NetOptions;
  private queue: Pending[] = [];
  constructor(url: string, net: NetOptions = {}) { this.url = url; this.net = net; }

  query(path: string, data: string): Promise<string> {
    return new Promise((ok, fail) => {
      this.queue.push({ path, data, ok, fail });
      if (this.queue.length === 1) setTimeout(() => { const q = this.queue; this.queue = []; for (let i = 0; i < q.length; i += BATCH) void this.flush(q.slice(i, i + BATCH)); }, WINDOW_MS);
    });
  }
  private async flush(batch: Pending[]): Promise<void> {
    const body = batch.map((p, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'abci_query', params: { path: p.path, data: b64(p.data) } }));
    try {
      const raw = await postJson(this.url, body.length === 1 ? body[0] : body, this.net);
      const replies = (Array.isArray(raw) ? raw : [raw]) as AbciReply[];
      const byId = new Map(replies.map((r, i) => [r.id ?? i + 1, r]));
      batch.forEach((p, i) => {
        const r = byId.get(i + 1), base = r?.result?.response?.ResponseBase;
        if (!r || r.error || !base || base.Error || !base.Data) p.fail(new RpcError(`${p.path} failed for ${p.data}: ${JSON.stringify(r?.error ?? base?.Error ?? 'empty reply').slice(0, 300)}`));
        else try { p.ok(unb64(base.Data)); } catch (e) { p.fail(e); }
      });
    } catch (e) { for (const p of batch) p.fail(e); }
  }
  /** Dry-runs an encoded transaction. Returns the raw result message. */
  async simulate(tx: Uint8Array): Promise<Uint8Array> {
    let bin = ''; for (const b of tx) bin += String.fromCharCode(b);
    const r = (await postJson(this.url, { jsonrpc: '2.0', id: 1, method: 'abci_query', params: { path: '.app/simulate', data: btoa(bin) } }, this.net)) as { error?: unknown; result?: { response?: { Value?: string | null; ResponseBase?: { Error?: unknown } } } };
    const v = r.result?.response?.Value;
    if (r.error || !v) throw new RpcError(`simulation failed: ${JSON.stringify(r.error ?? r.result?.response?.ResponseBase?.Error ?? 'empty reply').slice(0, 300)}`);
    return Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
  }
  async eval(expr: string): Promise<GnoValue[]> {
    const text = await this.query('vm/qeval', expr), vals = parseGno(text);
    if (!vals.length) throw new RpcError(`unexpected qeval reply for ${expr}: ${text.slice(0, 200)}`);
    return vals;
  }
  async evalInt(expr: string): Promise<bigint> {
    const v = (await this.eval(expr))[0]!;
    if (!/^-?\d+$/.test(v.value)) throw new RpcError(`expected a number from ${expr}, got ${v.value}`);
    return BigInt(v.value);
  }
  async evalString(expr: string): Promise<string> {
    const v = (await this.eval(expr))[0]!;
    if (v.type !== 'string') throw new RpcError(`expected a string from ${expr}, got ${v.type}`);
    return v.value;
  }
  async evalBool(expr: string): Promise<boolean> {
    const v = (await this.eval(expr))[0]!;
    if (v.value !== 'true' && v.value !== 'false') throw new RpcError(`expected a bool from ${expr}, got ${v.value}`);
    return v.value === 'true';
  }
  render(realm: string, args = ''): Promise<string> { return this.query('vm/qrender', `${realm}:${args}`); }
}

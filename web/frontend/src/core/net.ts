/** Shared HTTP: timeout, cancellation, and retries for transient failures only. */
export class HttpError extends Error {
  override name = 'HttpError';
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface NetOptions { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; retries?: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function postJson(url: string, body: unknown, o: NetOptions = {}): Promise<unknown> {
  const { fetch: f = fetch, timeoutMs = 40_000, retries = 2 } = o;
  for (let attempt = 0; ; attempt++) {
    o.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout });
      if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} from ${new URL(url).host}`);
      return await res.json();
    } catch (e) {
      o.signal?.throwIfAborted();
      const transient = !(e instanceof HttpError) || e.status === 429 || e.status >= 500;
      if (!transient || attempt >= retries) throw e;
      await sleep(300 * 3 ** attempt);
    }
  }
}

/** Runs `fn` over `items` with bounded concurrency, keeping order. Stops at the first failure. */
export async function mapPool<T, R>(items: readonly T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]!, i); } catch (e) { failed = true; throw e; }
    }
  }));
  return out;
}

/** GNOT in US dollars. No token on gno.land tracks the dollar, so this is the one figure that comes from outside the chain. */
export interface UsdPrice { price: number; source: string; at: number }

const TIMEOUT = 6000, STALE = 36e5;
const sane = (n: unknown): number => { const p = typeof n === 'string' || typeof n === 'number' ? Number(n) : NaN; if (!(p > 1e-6 && p < 1e5)) throw new Error('not a price'); return p; };

async function json(f: typeof fetch, url: string): Promise<unknown> {
  const r = await f(url, { signal: AbortSignal.timeout(TIMEOUT), credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
/** Last trade on Kraken's GNOT/USD book. */
async function kraken(f: typeof fetch, now: number): Promise<UsdPrice> {
  const j = (await json(f, 'https://api.kraken.com/0/public/Ticker?pair=GNOTUSD')) as { error?: unknown[]; result?: { GNOTUSD?: { c?: unknown[] } } };
  if (j.error?.length) throw new Error(String(j.error[0]));
  return { price: sane(j.result?.GNOTUSD?.c?.[0]), source: 'Kraken', at: now };
}
async function coingecko(f: typeof fetch, now: number): Promise<UsdPrice> {
  const j = (await json(f, 'https://api.coingecko.com/api/v3/simple/price?ids=gno-land&vs_currencies=usd&include_last_updated_at=true')) as { 'gno-land'?: { usd?: unknown; last_updated_at?: number } };
  const at = (j['gno-land']?.last_updated_at ?? 0) * 1000;
  if (now - at > STALE) throw new Error('old price');
  return { price: sane(j['gno-land']?.usd), source: 'CoinGecko', at: Math.min(at, now) };
}
export async function gnotUsd(f: typeof fetch = fetch, now = Date.now()): Promise<UsdPrice> {
  try { return await kraken(f, now); } catch { return coingecko(f, now); }
}

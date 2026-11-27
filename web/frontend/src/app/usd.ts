import { gnotUsd, type UsdPrice } from '../core/usd.ts';
import { usd } from './format.ts';

const KEY = 'dexvision:usd', EVERY = 60_000, OLD = 600_000, GONE = 864e5;
function remembered(): UsdPrice | null {
  try { const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as UsdPrice | null; return p && p.price > 0 && Number.isFinite(p.price) && Date.now() - p.at < GONE ? p : null; } catch { return null; }
}
/** The GNOT price in the header. Pages and tabs share one reading a minute. */
export function usdBox(onRate: (rate: number) => void): void {
  const box = document.getElementById('usd')!, out = document.getElementById('usd-price')!;
  let last = remembered(), timer = 0, fails = 0;
  function draw() {
    if (!last) return;
    const old = Date.now() - last.at > OLD;
    out.textContent = usd(last.price);
    onRate(last.price);
    box.toggleAttribute('data-old', old);
    const when = new Date(last.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    box.title = `${old ? 'Last known GNOT price' : 'GNOT price'}, ${last.source}, ${when}`;
  }
  async function tick(): Promise<void> {
    clearTimeout(timer);
    const shared = remembered();
    if (shared && shared.at > (last?.at ?? 0)) last = shared;
    if (!last || Date.now() - last.at >= EVERY) {
      try { last = await gnotUsd(); fails = 0; try { localStorage.setItem(KEY, JSON.stringify(last)); } catch { /* storage blocked */ } }
      catch { fails++; }
    }
    draw();
    if (!document.hidden) timer = window.setTimeout(() => void tick(), Math.min(EVERY * 2 ** Math.min(fails, 4), 900_000));
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else void tick(); });
  draw();
  void tick();
}

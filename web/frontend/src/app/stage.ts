import type { Scene } from '../design/horizon.ts';
import { horizonLite } from '../design/horizon-lite.ts';
import { CORAL, GNOLAND } from '../design/palettes.ts';
import { NETWORK } from '../core/config.ts';

export interface Stage { scene: Scene; /** Splits the headline again after its text changed. */ retitle(): void }

/** The hole and the headline that bends toward it. `place` positions the camera for the current viewport. */
/**
 * Where the hole sits on narrow screens: smaller and to the right, just under the header, so the page
 * title can start close to the top and overlap only the edge of the disk.
 */
export function narrowHole(): { x: number; y: number; r: number } {
  const r = Math.min(innerWidth * 0.27, 130), top = document.querySelector('header')?.getBoundingClientRect().bottom ?? 160;
  return { x: innerWidth * 0.7, y: top + r * 0.75, r };
}

export function createStage(place: (s: Scene) => void, onFrame: (dt: number, s: { x: number; y: number; scroll: number }) => void = () => {}): Stage {
  const scene: Scene = { incl: 0.16, roll: 0.26, zoom: 1, dim: 1, off: [0, 0], t: 8, light: NETWORK.id === 'onyx' ? CORAL : GNOLAND };
  let letters: HTMLElement[] = [], homes: { x: number; y: number }[] = [], stale = true;
  const mouse = { x: -9999, y: -9999 };
  function measure() {
    letters.forEach((l) => { l.style.fontVariationSettings = ''; l.dataset['v'] = ''; });
    homes = letters.map((l) => { const r = l.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + scrollY + r.height / 2 }; });
    stale = true;
  }
  function retitle() {
    letters = [];
    document.querySelectorAll('h1 span').forEach((w) => {
      const s = w.textContent ?? ''; w.textContent = ''; w.setAttribute('aria-hidden', 'true');
      for (const c of s) { const i = document.createElement('i'); i.textContent = c; w.append(i); letters.push(i); }
    });
    void document.fonts.load('900 40px "Anybody Variable"', 'Watch price bend').then(() => { measure(); dispatchEvent(new Event('horizon:redraw')); });
  }
  addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; stale = true; }, { passive: true });
  addEventListener('scroll', () => { stale = true; }, { passive: true });
  place(scene); addEventListener('resize', () => { place(scene); measure(); });
  retitle();

  horizonLite(document.getElementById('hole') as HTMLCanvasElement, scene, (dt) => {
    const scroll = Math.min(1, scrollY / innerHeight), hx = innerWidth / 2 + scene.off[0] * innerHeight, hy = innerHeight / 2 - scene.off[1] * innerHeight;
    onFrame(dt, { x: hx, y: hy, scroll });
    if (!stale || scroll > 0.75) return;
    stale = false;
    letters.forEach((l, i) => {
      const h = homes[i]; if (!h) return;
      const y = h.y - scrollY, d = Math.hypot(h.x - hx, (y - hy) * 0.8) / innerWidth, m = Math.exp(-((Math.hypot(h.x - mouse.x, y - mouse.y) / 170) ** 2));
      const pull = Math.max(0, Math.min(1, (0.66 - d) / 0.34));
      const v = `'wdth' ${Math.round((52 + pull * 98 - m * 34) / 3) * 3}, 'wght' ${Math.round((880 - pull * 420 + m * 300) / 12) * 12}`;
      if (l.dataset['v'] !== v) { l.dataset['v'] = v; l.style.fontVariationSettings = v; }
    });
  });
  return { scene, retitle };
}

/** "/" focuses the search anywhere. */
export function searchKeys(onClear?: () => void) {
  const q = document.getElementById('q') as HTMLInputElement;
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !(e.target as Element).matches('input, textarea')) { e.preventDefault(); q.focus(); }
    if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; q.blur(); onClear?.(); }
  });
  return q;
}

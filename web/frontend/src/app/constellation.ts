import type { Holder, Link } from '../core/holders.ts';

export interface Star { x: number; y: number; r: number; h: Holder }
const STARS = 80, GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Who is drawn: the largest holders. Contracts are drawn but never linked, since everyone trades with them. */
export function cast(holders: readonly Holder[], links: readonly Link[]): { shown: Holder[]; pairs: [number, number][] } {
  const shown = holders.slice(0, STARS), at = new Map(shown.map((h, i) => [h.address, i]));
  const pairs = links.flatMap((l): [number, number][] => {
    const a = at.get(l.a), b = at.get(l.b);
    return a === undefined || b === undefined || shown[a]!.kind === 'contract' || shown[b]!.kind === 'contract' ? [] : [[a, b]];
  });
  return { shown, pairs };
}

/** Area stands for share. The heaviest sit in the middle; linked stars are pulled together. Same input, same picture. */
export function layout(shown: readonly Holder[], pairs: readonly (readonly [number, number])[], w: number, h: number): Star[] {
  const total = shown.reduce((s, x) => s + x.share, 0) || 1, cap = Math.min(w, h) * 0.25, scale = Math.sqrt((0.17 * w * h) / (Math.PI * total));
  const stars = shown.map((x, i): Star => {
    const d = Math.sqrt(i / Math.max(1, shown.length)) * Math.min(w, h) * 0.48, a = i * GOLDEN;
    return { x: w / 2 + Math.cos(a) * d * (w / h) ** 0.5, y: h / 2 + Math.sin(a) * d, r: Math.max(3, Math.min(cap, Math.sqrt(x.share) * scale)), h: x };
  });
  const push = 9 * Math.min(1, (w * h) / 780_000); // less room, gentler
  for (let k = 0; k < 320; k++) {
    const heat = 1 - k / 320;
    for (const s of stars) { const g = 0.006 + 0.02 * Math.min(1, s.r / cap); s.x += (w / 2 - s.x) * g * heat; s.y += (h / 2 - s.y) * g * heat * Math.max(1, w / h); }
    for (const [a, b] of pairs) {
      const p = stars[a]!, q = stars[b]!, dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1, f = ((d - (p.r + q.r + 34)) / d) * 0.04 * heat;
      p.x += dx * f; p.y += dy * f; q.x -= dx * f; q.y -= dy * f;
    }
    for (let i = 0; i < stars.length; i++) for (let j = i + 1; j < stars.length; j++) {
      const p = stars[i]!, q = stars[j]!, dx = q.x - p.x || 0.01, dy = q.y - p.y || 0.01, d = Math.hypot(dx, dy), gap = p.r + q.r + 12;
      const f = d < gap ? (gap - d) / d / 2 : (push * heat) / (d * d) / 2, mp = q.r / (p.r + q.r); // the small one gives way
      p.x -= dx * f * 2 * mp; p.y -= dy * f * 2 * mp; q.x += dx * f * 2 * (1 - mp); q.y += dy * f * 2 * (1 - mp);
    }
    for (const s of stars) { const m = s.r + 8; s.x = Math.max(m, Math.min(w - m, s.x)); s.y = Math.max(m, Math.min(h - m, s.y)); }
  }
  return stars;
}

export interface Sky { set(holders: readonly Holder[], links: readonly Link[]): void; focus(address: string | null): void; setOwner(a: string | null): void }

export function createSky(canvas: HTMLCanvasElement, name: (h: Holder) => string, onHover: (h: Holder | null, linked: number, x: number, y: number) => void, onPick: (h: Holder, touch: boolean) => void): Sky {
  const g = canvas.getContext('2d')!;
  let shown: Holder[] = [], pairs: [number, number][] = [], stars: Star[] = [], on = -1, owner: string | null = null, w = 0, h = 0;
  const near = (i: number) => new Set(pairs.flatMap(([a, b]) => (a === i ? [b] : b === i ? [a] : [])));

  function draw() {
    const k = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * k); canvas.height = Math.round(h * k); g.setTransform(k, 0, 0, k, 0, 0);
    const mates = on < 0 ? null : near(on), dim = (i: number) => (mates && i !== on && !mates.has(i) ? 0.22 : 1);
    for (const [a, b] of pairs) {
      const hot = on === a || on === b, p = stars[a]!, q = stars[b]!;
      g.globalAlpha = on < 0 ? 0.55 : hot ? 1 : 0.08; g.strokeStyle = '#49afeb'; g.lineWidth = hot ? 1.6 : 1;
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
    }
    stars.forEach((s, i) => {
      const a = dim(i), { x, y, r } = s;
      g.globalAlpha = a;
      if (s.h.kind === 'contract') { // a hole: dark, with a ring of light
        const halo = g.createRadialGradient(x, y, r * 0.7, x, y, r * 1.35);
        halo.addColorStop(0, 'rgba(240,240,240,0)'); halo.addColorStop(0.45, 'rgba(240,240,240,.22)'); halo.addColorStop(1, 'rgba(240,240,240,0)');
        g.fillStyle = halo; g.beginPath(); g.arc(x, y, r * 1.35, 0, 7); g.fill();
        g.fillStyle = '#000'; g.strokeStyle = '#d8d8d8'; g.lineWidth = Math.max(1, Math.min(2.5, r * 0.05)); g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.stroke();
      } else if (s.h.kind === 'wallet') {
        const glow = g.createRadialGradient(x, y, 0, x, y, r + 8);
        glow.addColorStop(0, '#d9f0ff'); glow.addColorStop(Math.min(0.55, r / (r + 8) * 0.6), '#49afeb'); glow.addColorStop(r / (r + 8), 'rgba(33,100,145,.55)'); glow.addColorStop(1, 'rgba(33,100,145,0)');
        g.fillStyle = glow; g.beginPath(); g.arc(x, y, r + 8, 0, 7); g.fill();
      } else {
        g.fillStyle = 'rgba(124,124,124,.16)'; g.strokeStyle = '#9a9a9a'; g.lineWidth = 1.2; g.setLineDash(s.h.kind === 'quiet' ? [4, 4] : []); g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.stroke(); g.setLineDash([]);
      }
      if (s.h.address === owner) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; const z = r + 7; g.beginPath(); g.moveTo(x, y - z * 1.2); g.lineTo(x + z * 1.2, y); g.lineTo(x, y + z * 1.2); g.lineTo(x - z * 1.2, y); g.closePath(); g.stroke(); }
      if (i === on) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, r + 4, 0, 7); g.stroke(); }
    });
    g.textAlign = 'center'; g.textBaseline = 'middle';
    stars.forEach((s, i) => {
      if (s.r < 25) return;
      const t = name(s.h);
      g.font = '500 10px "Martian Mono Variable", monospace';
      const px = Math.min(14, (s.r * 1.6 * 10) / g.measureText(t).width);
      g.globalAlpha = dim(i); g.fillStyle = s.h.kind === 'wallet' ? '#05131c' : '#f0f0f0';
      const pct = `${(s.h.share * 100).toFixed(1)}%`;
      if (px >= 8.5) { g.font = `500 ${px}px "Martian Mono Variable", monospace`; g.fillText(t, s.x, s.y - 9); }
      g.font = `600 ${Math.min(17, s.r * 0.4)}px "Martian Mono Variable", monospace`; g.fillText(pct, s.x, s.y + (px >= 8.5 ? 11 : 0));
    });
    g.globalAlpha = 1;
  }
  function size() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !shown.length || (r.width === w && r.height === h && stars.length)) return;
    w = r.width; h = r.height; on = -1; stars = layout(shown, pairs, w, h); draw();
  }
  new ResizeObserver(size).observe(canvas);
  const hit = (e: PointerEvent | MouseEvent): number => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = -1, d = Infinity;
    stars.forEach((s, i) => { const q = Math.hypot(s.x - x, s.y - y) - Math.max(s.r, 9); if (q <= 0 && q < d) { best = i; d = q; } });
    return best;
  };
  const focusOn = (i: number) => { if (i !== on) { on = i; canvas.style.cursor = i < 0 ? '' : 'pointer'; draw(); } };
  const tell = (e: PointerEvent | MouseEvent) => { const i = hit(e); focusOn(i); onHover(i < 0 ? null : stars[i]!.h, i < 0 ? 0 : near(i).size, e.clientX, e.clientY); return i; };
  canvas.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') tell(e); });
  canvas.addEventListener('pointerleave', () => { focusOn(-1); onHover(null, 0, 0, 0); });
  canvas.addEventListener('click', (e) => { const i = tell(e); if (i >= 0) onPick(stars[i]!.h, (e as PointerEvent).pointerType === 'touch'); });
  return {
    set(holders, links) { ({ shown, pairs } = cast(holders, links)); stars = []; w = 0; size(); void document.fonts.load('500 14px "Martian Mono Variable"').then(() => { if (stars.length) draw(); }); },
    focus(a) { focusOn(a === null ? -1 : shown.findIndex((x) => x.address === a)); },
    setOwner(a) { owner = a; if (stars.length) draw(); },
  };
}

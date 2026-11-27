/**
 * Demo market shared by the three cover directions.
 * Every figure is simulated; only the GNOT, GNS and WUGNOT names exist on chain.
 * Replace `tokens` and `subscribe` with the indexer feed when it exists.
 */
export type Win = 'm5' | 'h1' | 'h6' | 'h24';
export type Tab = 'trending' | 'gainers' | 'losers' | 'new' | 'volume';

export interface Token {
  sym: string;
  name: string;
  realm: string;
  quote: string;
  fee: string; // Gnoswap fee tier
  price: number;
  ch: Record<Win, number>;
  vol: number;
  liq: number;
  mcap: number;
  tx: number;
  makers: number;
  age: number; // hours
  heat: number;
  spark: number[];
  dir: -1 | 0 | 1; // last tick direction
}

export const WINDOWS: { id: Win; label: string }[] = [
  { id: 'm5', label: '5M' },
  { id: 'h1', label: '1H' },
  { id: 'h6', label: '6H' },
  { id: 'h24', label: '24H' },
];
export const TABS: { id: Tab; label: string }[] = [
  { id: 'trending', label: 'Trending' },
  { id: 'gainers', label: 'Gainers' },
  { id: 'losers', label: 'Losers' },
  { id: 'new', label: 'New pairs' },
  { id: 'volume', label: 'Top volume' },
];

let seed = 20260912; // gnoland-1 genesis date
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// sym, name, realm, fee, price, h24, vol, liq, mcap, ageHours
type Row = [string, string, string, string, number, number, number, number, number, number];
const rows: Row[] = [
  ['GNOT', 'Gno.land', 'gno.land/r/gnoland/wugnot', '0.05%', 0.0712, 6.4, 1840000, 4120000, 71200000, 1776],
  ['GNS', 'Gnoswap', 'gno.land/r/gnoswap/gns', '0.30%', 0.1284, 14.8, 921000, 2260000, 12840000, 1730],
  ['HAT', 'Pointy Hat', 'gno.land/r/demo/hat', '1%', 0.00431, 182.6, 614000, 318000, 4310000, 61],
  ['SPORE', 'Sporefall', 'gno.land/r/demo/spore', '1%', 0.0000871, 64.1, 402000, 206000, 871000, 214],
  ['BEARD', 'Longbeard', 'gno.land/r/demo/beard', '0.30%', 0.0218, -11.7, 288000, 541000, 2180000, 902],
  ['MOSS', 'Moss Protocol', 'gno.land/r/demo/moss', '0.30%', 0.912, 3.2, 251000, 884000, 9120000, 1201],
  ['LANTRN', 'Lantern', 'gno.land/r/demo/lantern', '1%', 0.0157, 41.9, 197000, 143000, 1570000, 33],
  ['BOG', 'Bog Money', 'gno.land/r/demo/bog', '1%', 0.00000614, -48.3, 176000, 88000, 61400, 96],
  ['QUARK', 'Quarkyard', 'gno.land/r/demo/quark', '0.30%', 1.704, -2.6, 154000, 690000, 17040000, 1488],
  ['TROWEL', 'Trowel', 'gno.land/r/demo/trowel', '1%', 0.000392, 27.5, 121000, 97000, 392000, 18],
  ['UMBRA', 'Umbra', 'gno.land/r/demo/umbra', '0.30%', 0.0543, -19.4, 112000, 187000, 543000, 407],
  ['ZWERG', 'Zwerg', 'gno.land/r/demo/zwerg', '1%', 0.00196, 96.2, 98600, 71000, 196000, 7],
  ['DELTAV', 'Delta V', 'gno.land/r/demo/deltav', '0.30%', 0.338, 8.9, 87200, 264000, 3380000, 655],
  ['GARDEN', 'Garden Index', 'gno.land/r/demo/garden', '0.05%', 4.117, 1.1, 74900, 1120000, 8234000, 1390],
  ['ACORN', 'Acorn', 'gno.land/r/demo/acorn', '1%', 0.0000212, -33.8, 61300, 42000, 21200, 4],
  ['PERI', 'Periapsis', 'gno.land/r/demo/peri', '0.30%', 0.0839, 12.3, 55800, 133000, 839000, 288],
];

export const tokens: Token[] = rows.map(([sym, name, realm, fee, price, h24, vol, liq, mcap, age]) => {
  const spark: number[] = [];
  const n = 40;
  const start = 100 / (1 + h24 / 100);
  let drift = 0;
  for (let i = 0; i < n; i++) {
    drift = drift * 0.82 + (rnd() - 0.5) * 9;
    const t = i / (n - 1);
    spark.push(start + (100 - start) * (t * t * 0.6 + t * 0.4) + drift * (1 - t) * (0.5 + Math.abs(h24) / 70));
  }
  return {
    sym, name, realm, fee, price, vol, liq, mcap, age, spark,
    quote: sym === 'GNOT' ? 'USDC' : 'GNOT',
    ch: { m5: +((rnd() - 0.45) * 5).toFixed(1), h1: +(h24 * 0.16 + (rnd() - 0.5) * 7).toFixed(1), h6: +(h24 * 0.48 + (rnd() - 0.5) * 12).toFixed(1), h24 },
    tx: Math.round(vol / (70 + rnd() * 120)),
    makers: Math.round(vol / (420 + rnd() * 500)),
    heat: (vol / 4e4 + Math.abs(h24)) * (age < 100 ? 1.7 : 1),
    dir: 0 as const,
  };
});

export const chain = {
  id: 'gnoland-1',
  height: 1284417,
  get vol() { return tokens.reduce((a, t) => a + t.vol, 0); },
  get liq() { return tokens.reduce((a, t) => a + t.liq, 0); },
  get tx() { return tokens.reduce((a, t) => a + t.tx, 0); },
};

export function view(tab: Tab, win: Win, q = ''): Token[] {
  const s = q.trim().toLowerCase();
  const list = tokens.filter((t) => !s || `${t.sym} ${t.name} ${t.realm}`.toLowerCase().includes(s));
  switch (tab) {
    case 'gainers': return list.filter((t) => t.ch[win] > 0).sort((a, b) => b.ch[win] - a.ch[win]);
    case 'losers': return list.filter((t) => t.ch[win] < 0).sort((a, b) => a.ch[win] - b.ch[win]);
    case 'new': return list.sort((a, b) => a.age - b.age);
    case 'volume': return list.sort((a, b) => b.vol - a.vol);
    default: return list.sort((a, b) => b.heat - a.heat);
  }
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';
/** 0.00000614 -> $0.0₅614 */
export function price(p: number): string {
  if (p >= 1) return '$' + p.toFixed(3);
  if (p >= 0.001) return '$' + p.toFixed(5);
  const z = -Math.floor(Math.log10(p)) - 1;
  const digits = Math.round(p * 10 ** (z + 4)).toString().padEnd(4, '0').slice(0, 4);
  return '$0.0' + [...String(z)].map((d) => SUB[+d]).join('') + digits;
}
export const usd = (n: number) =>
  n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K' : '$' + n.toFixed(0);
export const num = (n: number) => n.toLocaleString('en-US');
export const pct = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1) + '%';
export const age = (h: number) => (h < 24 ? `${Math.round(h)}h` : h < 24 * 60 ? `${Math.round(h / 24)}d` : `${Math.round(h / 24 / 30)}mo`);

export { calm } from './motion';
import { calm } from './motion';

/** Simulated live feed. Calls back with the tokens that moved. */
export function subscribe(fn: (changed: Token[]) => void) {
  let last = 0;
  setInterval(() => {
    if (document.hidden) return;
    chain.height += Math.random() < 0.35 ? 1 : 0;
    const changed: Token[] = [];
    for (let i = 0; i < 3; i++) {
      const t = tokens[(Math.random() * tokens.length) | 0];
      if (changed.includes(t)) continue;
      const d = (Math.random() - 0.48) * 0.012;
      t.price *= 1 + d;
      for (const w of WINDOWS) t.ch[w.id] += d * 100;
      t.vol += Math.random() * 900;
      t.tx += 1 + ((Math.random() * 3) | 0);
      t.dir = d > 0 ? 1 : -1;
      t.spark[t.spark.length - 1] *= 1 + d;
      changed.push(t);
    }
    last++;
    fn(changed);
  }, calm() ? 4000 : 1100);
}

/** Wires tabs, window switch and search (also "/" to focus). Returns current state. */
export function controls(onChange: () => void) {
  const state = { tab: 'trending' as Tab, win: 'h24' as Win, q: '' };
  const press = (sel: string, el: Element) =>
    document.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
  document.addEventListener('click', (e) => {
    const t = (e.target as Element).closest<HTMLElement>('[data-tab],[data-win]');
    if (!t) return;
    if (t.dataset.tab) { state.tab = t.dataset.tab as Tab; press('[data-tab]', t); }
    if (t.dataset.win) { state.win = t.dataset.win as Win; press('[data-win]', t); }
    onChange();
  });
  const input = document.querySelector<HTMLInputElement>('[data-search]');
  input?.addEventListener('input', () => { state.q = input.value; onChange(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input?.focus(); }
    if (e.key === 'Escape' && document.activeElement === input && input) { input.value = ''; state.q = ''; input.blur(); onChange(); }
  });
  return state;
}

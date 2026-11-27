const SUB = '₀₁₂₃₄₅₆₇₈₉';
/** Prices in GNOT. Very small ones count their zeros: 0.0₄9562 is 0.00009562. */
export function price(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return 'n/a';
  if (p >= 1000) return Math.round(p).toLocaleString('en-US');
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.001) return p.toFixed(5);
  if (p <= 0) return '0';
  let z = -Math.floor(Math.log10(p)) - 1, d = Math.round(p * 10 ** (z + 4));
  if (d >= 10_000) { z -= 1; d = Math.round(p * 10 ** (z + 4)); } // rounding carried over
  return '0.0' + [...String(z)].map((c) => SUB[+c]).join('') + String(d).padStart(4, '0');
}
export function amount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  if (a >= 999_500_000) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 999_500) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 99_950) return (n / 1e3).toFixed(0) + 'K';
  if (a >= 1000) return (n / 1e3).toFixed(1) + 'K';
  return a >= 100 || a === 0 ? n.toFixed(0) : a >= 0.1 ? n.toFixed(1) : '<0.1';
}
/** Dollars: cents above one, four figures below. */
export const usd = (n: number): string => '$' + (n >= 1000 ? Math.round(n).toLocaleString('en-US') : n >= 1 ? n.toFixed(2) : n.toPrecision(4).replace(/e.*/, ''));
/** A token's price in dollars, with the same small-number notation as in GNOT. */
export const usdPrice = (n: number | null): string => { const t = price(n); return t === 'n/a' ? t : '$' + t; };
export function usdAmount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'n/a';
  if (n === 0) return '$0';
  return n < 0.01 ? '<$0.01' : n < 1000 ? '$' + n.toFixed(2) : '$' + amount(n);
}
export const count = (n: number | null): string => (n === null ? 'n/a' : n.toLocaleString('en-US'));
export function pct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'n/a';
  const s = Math.abs(n) >= 1000 ? Math.round(Math.abs(n)).toLocaleString('en-US') : Math.abs(n).toFixed(Math.abs(n) < 1 ? 2 : 1);
  return (n >= 0.005 ? '+' : n <= -0.005 ? '−' : '') + s + '%';
}
export function age(created: number | null, now: number): string {
  if (created === null) return 'n/a';
  const h = Math.max(0, (now - created) / 36e5);
  return h < 1 ? `${Math.floor(h * 60)}m` : h < 48 ? `${Math.floor(h)}h` : `${Math.floor(h / 24)}d`;
}
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

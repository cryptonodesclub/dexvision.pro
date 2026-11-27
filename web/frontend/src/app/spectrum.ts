import { FLAT } from '../core/overview.ts';

export const tone = (c: number | null) => (c === null || Math.abs(c) < FLAT ? 'flat' : c > 0 ? 'up' : 'down');
const REST = [34, 88, 126];
/** Three emission lines displaced from rest by the change: left is blue, right is coral. */
export function spectrum(c: number | null): string {
  const t = tone(c), s = t === 'flat' ? 0 : Math.max(-30, Math.min(30, Math.sign(c!) * Math.log1p(Math.abs(c!)) * 5.6)), line = t === 'down' ? 'dn-line' : 'up-line';
  return `<svg viewBox="0 0 160 26" width="160" height="26" aria-hidden="true"><rect y="3" width="160" height="20" fill="url(#band)"/>` +
    REST.map((x, i) => `<rect x="${Math.min(x, x - s)}" y="3" width="${Math.abs(s)}" height="20" fill="url(#${s >= 0 ? 'sb' : 'sr'})"/><path d="M${x} 0v26" stroke="#fff" stroke-opacity=".3" stroke-dasharray="2 2"/>${t === 'flat' ? '' : `<path d="M${x - s} 1v24" stroke="var(--${line})" stroke-width="${i === 1 ? 3 : 2}"/>`}`).join('') + '</svg>';
}

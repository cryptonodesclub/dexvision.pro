/** Pieces shared by the Horizon variants: spectrum, table, chain stats. */
import { view, subscribe, controls, tokens, chain, price, usd, num, pct, age, type Token } from './market';

const REST = [34, 88, 126];
const squash = (c: number) => Math.max(-30, Math.min(30, Math.sign(c) * Math.log1p(Math.abs(c)) * 5.6));

/** Three emission lines displaced from rest by the change: left is blue, right is red. */
export const spectrum = (c: number) => {
  const s = squash(c), up = c >= 0;
  return `<svg class="spec" viewBox="0 0 160 26" aria-hidden="true"><rect y="3" width="160" height="20" fill="url(#band)"/>` +
    REST.map((x, i) => `<rect x="${Math.min(x, x - s)}" y="3" width="${Math.abs(s)}" height="20" fill="url(#${up ? 'sb' : 'sr'})"/><path d="M${x} 0v26" stroke="#fff" stroke-opacity=".3" stroke-dasharray="2 2"/><path d="M${x - s} 1v24" stroke="${up ? '#a9d8ff' : '#ff8a72'}" stroke-width="${i === 1 ? 3 : 2}"/>`).join('') + '</svg>';
};
export const tone = (c: number) => (c >= 0 ? 'up' : 'down');
const $ = (id: string) => document.getElementById(id);

export interface Hooks { onList?: (list: Token[]) => void; onTick?: (changed: Token[]) => void; rowAttrs?: (t: Token) => string; realm?: boolean; makers?: boolean }

export function market(hooks: Hooks = {}) {
  const { makers = true } = hooks;
  const cell = (t: Token) => {
    const c = t.ch[state.win];
    return `<th scope="row" class="l"><span class="pair"><b>${t.sym}</b><s>${t.quote}</s><em>${t.fee}</em></span>${hooks.realm === false ? '' : `<a href="https://${t.realm}" class="realm">${t.realm.replace('gno.land', '')}</a>`}</th>
      <td class="p ${t.dir > 0 ? 'fu' : t.dir < 0 ? 'fd' : ''}">${price(t.price)}</td><td class="l sp">${spectrum(c)}</td><td class="c ${tone(c)}">${pct(c)}</td>
      <td>${usd(t.vol)}</td><td>${usd(t.liq)}</td><td>${usd(t.mcap)}</td><td>${num(t.tx)}</td>${makers ? `<td>${num(t.makers)}</td>` : ''}<td>${age(t.age)}</td>`;
  };
  const stats = () => {
    $('height')!.textContent = num(chain.height);
    const el = $('chain');
    if (el) el.innerHTML = [['24h volume', usd(chain.vol)], ['Liquidity', usd(chain.liq)], ['24h txns', num(chain.tx)], ['Pairs', String(tokens.length)]].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  };
  const render = () => {
    const list = view(state.tab, state.win, state.q);
    $('rows')!.innerHTML = list.map((t) => `<tr id="row-${t.sym}" data-sym="${t.sym}" ${hooks.rowAttrs?.(t) ?? ''}>${cell(t)}</tr>`).join('');
    $('empty')!.hidden = list.length > 0;
    stats(); hooks.onList?.(list);
  };
  const state = controls(render);
  const start = () => {
    render();
    subscribe((changed) => {
      tokens.forEach((t) => { if (!changed.includes(t)) t.dir = 0; });
      changed.forEach((t) => { const r = $('row-' + t.sym); if (r) r.innerHTML = cell(t); });
      stats(); hooks.onTick?.(changed);
    });
  };
  return { state, start, render };
}

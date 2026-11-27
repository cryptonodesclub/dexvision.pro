import { WUGNOT } from '../core/config.ts';
import type { Engine } from '../core/engine.ts';
import type { MarketRow } from '../core/overview.ts';
import { outcome, tierRange, type Book, type Outcome, type Tier } from '../core/traders.ts';
import { age, amount, count, esc } from './format.ts';
import { explorer, symbolOf, txUrl } from './links.ts';
import type { createMoney } from './money.ts';

type Money = ReturnType<typeof createMoney>;
const SHOWN = 200; // trades listed in the panel, newest first
const AGAIN = 15_000; // a market that keeps trading is read again at most this often

/** The size of every account that traded in the selected market, and a panel with one account's trades. */
export function createTraders(engine: Engine, money: Money, path: string, symbol: string, changed: () => void) {
  let key = '', at = 0, busy = false, data: { books: Map<string, Book>; partial: boolean } | null = null, market: MarketRow | null = null, open: string | null = null;
  const dialog = document.getElementById('trader') as HTMLDialogElement;
  const toGnot = (m: MarketRow) => (m.pairedWith === WUGNOT ? 1 : m.priceGnot !== null && m.price ? m.priceGnot / m.price : null);

  async function load(k: string) {
    busy = true;
    try { const got = await engine.traders(path, k); if (k === key) { data = got; at = Date.now(); changed(); if (open) void show(open); } }
    catch (e) { console.warn('[DexVision] could not read the traders of', k, e); }
    finally { busy = false; }
  }
  function figures(address: string): Outcome | null {
    const b = data?.books.get(address), q = market && toGnot(market);
    return b && q !== null && q !== undefined ? outcome(b, q, market!.priceGnot) : null;
  }

  async function show(address: string) {
    open = address;
    const b = data?.books.get(address), o = figures(address), m = market!;
    const pair = `${esc(symbol)} / ${esc(symbolOf(m.pairedWith))}`, gnot = m.pairedWith === WUGNOT;
    const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + money.text(Math.abs(n), 'amount');
    const tone = (n: number | null) => (n === null || Math.abs(n) < 1e-9 ? 'flat' : n > 0 ? 'up' : 'down');
    const head = `<div class="tr-head"><p class="tr-tier">${o ? `<span aria-hidden="true">${o.tier.icon}</span> ${esc(o.tier.name)} <small>${esc(tierRange(o.tier))} bought and sold here</small>` : 'Trader'}</p>
      <button type="button" class="tr-x" data-close aria-label="Close">×</button></div>
      <p class="tr-who"><a href="${esc(explorer({ address }))}" target="_blank" rel="noopener">${esc(address)}</a></p>
      <p class="tr-where">${pair}, ${esc(m.venue)}. Only trades in this market.</p>`;
    if (!b || !o) {
      dialog.innerHTML = head + `<p class="tr-note">${data ? 'No trades by this account in this market yet.' : 'Reading every trade of this market'}</p>`;
      if (!dialog.open) dialog.showModal();
      return;
    }
    const facts = `<dl class="tr-facts">
      <div><dt>Bought</dt><dd><b>${money.text(o.spentGnot, 'amount')}</b> <span>${amount(b.bought)} ${esc(symbol)} in ${count(b.buys)} ${b.buys === 1 ? 'trade' : 'trades'}</span></dd></div>
      <div><dt>Sold</dt><dd><b>${money.text(o.gotGnot, 'amount')}</b> <span>${amount(b.sold)} ${esc(symbol)} in ${count(b.sells)} ${b.sells === 1 ? 'trade' : 'trades'}</span></dd></div>
      <div><dt>Sold minus bought</dt><dd><b class="${tone(o.net)}">${signed(o.net)}</b></dd></div>
      <div><dt>Still holds from these</dt><dd><b>${o.leftGnot === null ? 'n/a' : money.text(o.leftGnot, 'amount')}</b> <span>${amount(o.left)} ${esc(symbol)} at today’s price</span></dd></div>
      <div class="tr-total"><dt>Result</dt><dd><b class="${tone(o.total)}">${o.total === null ? 'n/a' : signed(o.total)}</b> <span>sold minus bought, plus what it still holds</span></dd></div>
    </dl>`;
    const list = b.trades.slice(0, SHOWN), times = await engine.indexer.blockTimes(list.map((t) => t.height)).catch(() => new Map<number, number>());
    if (open !== address) return; // another trader was opened meanwhile
    const q = toGnot(m) ?? 0, now = Date.now();
    const rows = list.map((t) => {
      const when = times.get(t.height), v = t.paid * q;
      return `<tr><td class="l">${when === undefined ? `block ${count(t.height)}` : esc(now - when < 6e4 ? 'now' : age(when, now) + ' ago')}</td><td class="l ${t.buy ? 'up' : 'down'}">${t.buy ? 'Buy' : 'Sell'}</td><td>${amount(t.amount)}</td>
        <td>${money.text(v, 'amount')}</td><td>${money.text(t.amount ? v / t.amount : null, 'price')}</td>
        <td class="l">${t.tx ? `<a href="${esc(txUrl(t.tx))}" target="_blank" rel="noopener" title="${esc(t.tx)}">${esc(t.tx.slice(0, 8))}…</a>` : 'n/a'}</td></tr>`;
    }).join('');
    const notes = [
      data!.partial ? 'The oldest trades of this market could not be read, so these totals may be low.' : '',
      gnot ? '' : `Amounts in ${esc(symbolOf(m.pairedWith))} are shown in ${money.unit()} at today’s rate.`,
      b.trades.length > SHOWN ? `Showing the latest ${SHOWN} of ${count(b.trades.length)} trades; the totals count them all.` : '',
    ].filter(Boolean).map((n) => `<p class="tr-note">${n}</p>`).join('');
    dialog.innerHTML = head + facts + `<div class="scroll"><table><thead><tr><th class="l">Time</th><th class="l">Side</th><th>Amount ${esc(symbol)}</th><th>Value <span class="unit">${money.unit()}</span></th><th>Price <span class="unit">${money.unit()}</span></th><th class="l">Tx</th></tr></thead><tbody>${rows}</tbody></table></div>` + notes;
    if (!dialog.open) dialog.showModal();
  }

  dialog.addEventListener('click', (e) => { if (e.target === dialog || (e.target as Element).closest('[data-close]')) dialog.close(); });
  dialog.addEventListener('close', () => { open = null; });
  document.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-trader]');
    if (b && market) void show(b.dataset['trader']!);
  });

  return {
    /** Follows the selected market. `moved`: it traded since the last look. */
    sync(m: MarketRow, moved: boolean) {
      market = m;
      if (m.key !== key) { key = m.key; data = null; void load(key); }
      else if (moved && !busy && Date.now() - at > AGAIN) void load(key);
    },
    tier(address: string | undefined): Tier | null { return address ? figures(address)?.tier ?? null : null; },
    volume(address: string | undefined): number | null { return address ? figures(address)?.volumeGnot ?? null : null; },
    /** Paints the panel again, for a change of unit. */
    redraw() { if (open && dialog.open) void show(open); },
  };
}

import type { Engine } from '../core/engine.ts';
import { groupsOf, type Holder, type HolderSet, type Kind } from '../core/holders.ts';
import { cast, createSky, type Sky } from './constellation.ts';
import { amount, count, esc } from './format.ts';
import { explorer, shortRealm } from './links.ts';
import type { Money } from './money.ts';
import { sortable, sortBy, type Keys } from './sort.ts';

const TOP = 20, ALL = 100, DUST = 1e-5;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
interface Account { address: string; kind: Kind; realm?: string }
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;
export const share = (s: number): string => (s === 0 ? '0%' : s < DUST ? '<0.001%' : s < 0.01 ? `${(s * 100).toFixed(3)}%` : `${(s * 100).toFixed(1)}%`);
export const label = (h: Account): string => (h.realm ? shortRealm(h.realm).replace(/^\/r\//, '') : short(h.address));
export const TYPE: Record<Kind, string> = { wallet: 'Wallet', contract: 'Contract', quiet: 'Never signed', unread: '' };

/** A name that opens the explorer, and a way to copy the address. */
export const who = (h: Account, you = false): string => `<a href="${esc(explorer(h))}" target="_blank" rel="noopener" title="${esc(h.realm ?? h.address)}">${esc(label(h))}</a>${you ? ' <span class="you">you</span>' : ''}${h.realm ? '' : ` <button type="button" class="cp" data-copy="${esc(h.address)}" aria-label="Copy ${esc(h.address)}">Copy</button>`}`;

/** What the figures above the picture say. */
export function digest(holders: readonly Holder[]): { contracts: number; top10: number; dust: number } {
  const own = holders.filter((h) => h.kind !== 'contract');
  const sum = (l: readonly Holder[]) => l.reduce((s, h) => s + h.share, 0);
  return { contracts: sum(holders.filter((h) => h.kind === 'contract')), top10: sum(own.slice(0, 10)), dust: holders.filter((h) => h.share < DUST).length };
}

export function createHolders(engine: Engine, money: Money, path: string, symbol: string, onAnalyze: () => void) {
  const go = $<HTMLButtonElement>('h-go'), says = $('h-says'), bar = $('h-bar'), tip = document.createElement('div');
  tip.className = 'tooltip'; tip.hidden = true; document.body.append(tip);
  let set: HolderSet | null = null, sky: Sky | null = null, busy = false, all = false, owner: string | null = null, unitPrice: number | null = null;
  let linked = new Map<string, number>();
  /** The rank stays the holder's place by share, whatever the table is sorted by. */
  const BY: Keys<{ h: Holder; rank: number }> = { rank: (x) => x.rank, holder: (x) => label(x.h), type: (x) => TYPE[x.h.kind] || null, share: (x) => x.h.share, amount: (x) => x.h.amount, value: (x) => x.h.amount, links: (x) => (x.h.kind === 'contract' ? null : linked.get(x.h.address) ?? null) };
  const order = sortable($('h-rows').closest('table')!, () => table());

  function row(h: Holder, rank: number): string {
    const value = unitPrice === null ? null : h.amount * unitPrice;
    return `<tr data-holder="${esc(h.address)}" ><td class="l">${count(rank)}</td><th scope="row" class="l">${who(h, h.address === owner)}</th><td class="l kind ${h.kind}">${TYPE[h.kind]}</td>
      <td class="share"><i style="width:${(Math.min(1, h.share) * 100).toFixed(2)}%"></i><span>${share(h.share)}</span></td><td>${amount(h.amount)}</td><td${money.attrs(value, 'amount')}>${money.text(value, 'amount')}</td><td>${h.kind === 'contract' ? '' : linked.get(h.address) ?? ''}</td></tr>`;
  }
  function table(): void {
    if (!set) return;
    const list = sortBy(set.holders.map((h, i) => ({ h, rank: i + 1 })), order, BY), shown = list.slice(0, all ? ALL : TOP), mine = owner ? list.findIndex((x) => x.h.address === owner) : -1;
    $('h-rows').innerHTML = shown.map((x) => row(x.h, x.rank)).join('') + (mine >= shown.length ? row(list[mine]!.h, list[mine]!.rank) : '');
    const more = $('h-more'); more.hidden = list.length <= TOP; more.textContent = all ? `Show the first ${TOP}` : `Show the first ${Math.min(ALL, list.length)}`;
  }
  function show(s: HolderSet): void {
    const { shown, pairs } = cast(s.holders, s.links), d = digest(s.holders);
    linked = new Map(); for (const [a, b] of pairs) for (const i of [a, b]) linked.set(shown[i]!.address, (linked.get(shown[i]!.address) ?? 0) + 1);
    $('h-count').textContent = count(s.holders.length); $('h-top').textContent = share(d.top10); $('h-con').textContent = s.named ? share(d.contracts) : 'n/a'; $('h-dust').textContent = count(d.dust);
    const members = shown.filter((h) => h.kind !== 'contract').map((h) => h.address), by = new Map(shown.map((h) => [h.address, h.share]));
    const g = groupsOf(members, s.links.filter((l) => by.has(l.a) && by.has(l.b)))[0];
    $('h-group').textContent = g ? `The largest group joined by transfers has ${g.length} accounts and ${share(g.reduce((t, a) => t + by.get(a)!, 0))} of the supply.` : 'No transfers between the accounts drawn here.';
    $('h-drawn').textContent = s.holders.length > shown.length ? `The ${shown.length} largest of ${count(s.holders.length)} holders. Size is share of the supply.` : 'Size is share of the supply.';
    $('h-out').hidden = false;
    sky ??= createSky($<HTMLCanvasElement>('h-sky'), label, hover, pick);
    sky.setOwner(owner); sky.set(s.holders, s.links); table();
  }
  function hover(h: Holder | null, n: number, x: number, y: number): void {
    document.querySelectorAll('#h-rows tr[data-on]').forEach((r) => r.removeAttribute('data-on'));
    tip.hidden = h === null;
    if (!h) return;
    tip.textContent = `${label(h)}  ${share(h.share)}${TYPE[h.kind] ? `  ${TYPE[h.kind]}` : ''}${n ? `, linked to ${n}` : ''}`; if (told !== h.address) told = '';
    tip.style.left = `${Math.max(6, Math.min(document.documentElement.clientWidth - tip.offsetWidth - 6, x - tip.offsetWidth / 2)).toFixed(0)}px`; tip.style.top = `${(y - tip.offsetHeight - 24 > 4 ? y - tip.offsetHeight - 24 : y + 18).toFixed(0)}px`;
    $('h-rows').querySelector(`tr[data-holder="${CSS.escape(h.address)}"]`)?.setAttribute('data-on', '');
  }
  /** A mouse has already shown who it is; a finger has not, so its first tap only tells. */
  let told = '';
  function pick(h: Holder, touch: boolean): void {
    if (touch && told !== h.address) { told = h.address; return; }
    told = ''; open(explorer(h), '_blank', 'noopener');
  }
  const say = (t: string, bad = false) => { says.textContent = t; says.toggleAttribute('data-bad', bad); };

  async function analyze(): Promise<void> {
    if (busy) return;
    onAnalyze();
    busy = true; go.disabled = true; go.textContent = 'Analyzing'; say(`Reading every transfer of ${symbol}`); bar.hidden = false; bar.style.setProperty('--p', '0');
    try {
      const s = await engine.holders(path, (p) => { bar.style.setProperty('--p', p.toFixed(3)); if (p >= 1) say('Checking the result against the contract'); });
      const empty = s.state === 'empty' || s.state === 'silent';
      set = empty ? null : s;
      if (empty) { $('h-out').hidden = true; say(s.state === 'empty' ? `Nobody holds ${symbol} right now.` : `${symbol} does not record its transfers, so its holders cannot be listed.`); }
      else {
        show(s);
        const b = `block ${count(s.height)}`;
        if (s.state === 'differs') say(`Read at ${b}, but it does not match what the contract says. Some balances may be wrong.`, true);
        else if (!s.named) say(`Read at ${b} and checked against the contract. Contracts could not be told apart from wallets.`, true);
        else say(`Read at ${b}. Total supply and the largest balances match the contract.`);
      }
      go.textContent = 'Analyze again';
    } catch { say('The holders could not be read. Try again in a moment.', true); go.textContent = set ? 'Analyze again' : 'Analyze holders'; }
    finally { busy = false; go.disabled = false; bar.hidden = true; }
  }

  go.addEventListener('click', () => void analyze());
  $('h-more').addEventListener('click', () => { all = !all; table(); });
  for (const id of ['h-rows', 'q-rows']) $(id).addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-copy]');
    if (b) void navigator.clipboard.writeText(b.dataset['copy']!).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200); }, () => { b.textContent = b.dataset['copy']!; });
  });
  $('h-rows').addEventListener('pointerover', (e) => { if (e.pointerType === 'mouse') sky?.focus((e.target as Element).closest<HTMLElement>('tr')?.dataset['holder'] ?? null); });
  $('h-rows').addEventListener('pointerleave', () => sky?.focus(null));
  addEventListener('scroll', () => { tip.hidden = true; }, { passive: true, capture: true });
  return {
    setOwner(a: string | null): void { owner = a; sky?.setOwner(a); table(); },
    /** Prices move on their own: only the value column follows. */
    setPrice(p: number | null): void { if (p !== unitPrice) { unitPrice = p; table(); } },
    redraw: table,
  };
}

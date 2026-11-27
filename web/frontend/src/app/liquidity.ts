import type { Engine, Liquidity, Provider } from '../core/engine.ts';
import type { MarketRow } from '../core/overview.ts';
import { amount, count } from './format.ts';
import { label, share, TYPE, who } from './holders.ts';
import type { Money } from './money.ts';
import { sortable, sortBy, type Keys } from './sort.ts';

const TOP = 10, ALL = 100;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface Backer { p: Provider; depth: number; share: number; amount: number; positions: number; staked: number }
/** Puts GNOT values on what each provider could take out. `priceOf` gives the paired token's price in a market, or null. */
export function backers(l: Liquidity, priceOf: (key: string) => number | null): { list: Backer[]; total: number; unpriced: boolean } {
  let unpriced = false;
  const list = l.providers.map((p): Backer => {
    const b = { p, depth: 0, share: 0, amount: 0, positions: 0, staked: 0 };
    for (const x of p.parts) {
      const q = priceOf(x.key);
      if (q === null) unpriced = true; else { b.depth += x.paired * q; if (x.staked) b.staked += x.paired * q; }
      b.amount += x.token; b.positions += x.positions;
    }
    return b;
  });
  const total = list.reduce((s, b) => s + b.depth, 0);
  for (const b of list) b.share = total > 0 ? b.depth / total : 0;
  return { list: list.sort((a, b) => b.depth - a.depth || b.amount - a.amount), total, unpriced };
}

export function createLiquidity(engine: Engine, money: Money, path: string) {
  const says = $('q-says');
  let got: Liquidity | null = null, busy = false, all = false, owner: string | null = null, prices = new Map<string, number | null>();

  /** The rank stays the provider's place by depth, whatever the table is sorted by. */
  const BY: Keys<{ b: Backer; rank: number }> = { rank: (x) => x.rank, provider: (x) => label(x.b.p), type: (x) => TYPE[x.b.p.kind] || null, share: (x) => x.b.share, depth: (x) => x.b.depth, amount: (x) => x.b.amount, positions: (x) => x.b.positions, staked: (x) => (x.b.depth > 0 ? x.b.staked / x.b.depth : null) };
  const order = sortable($('q-rows').closest('table')!, () => draw());
  function draw(): void {
    if (!got) return;
    const { list, total, unpriced } = backers(got, (k) => prices.get(k) ?? null), sum = (n: number) => list.slice(0, n).reduce((s, b) => s + b.share, 0), part = (f: (b: Backer) => number) => (total > 0 ? share(list.reduce((s, b) => s + f(b), 0) / total) : 'n/a');
    $('q-count').textContent = count(list.length); $('q-one').textContent = total > 0 ? share(sum(1)) : 'n/a'; $('q-three').textContent = total > 0 ? share(sum(3)) : 'n/a'; $('q-staked').textContent = part((b) => b.staked); $('q-con').textContent = got.named ? part((b) => (b.p.kind === 'contract' ? b.depth : 0)) : 'n/a';
    $('q-bar').innerHTML = list.filter((b) => b.share > 0.002).slice(0, 12).map((b) => `<i class="${b.p.kind}" style="flex:${b.share.toFixed(5)} 0 0" title="${label(b.p)} ${share(b.share)}"></i>`).join('') + `<i class="rest" style="flex:${Math.max(0, 1 - list.filter((b) => b.share > 0.002).slice(0, 12).reduce((s, b) => s + b.share, 0)).toFixed(5)} 0 0"></i>`;
    const row = (b: Backer, rank: number) => `<tr><td class="l">${count(rank)}</td><th scope="row" class="l">${who(b.p, b.p.address === owner)}</th><td class="l kind ${b.p.kind}">${TYPE[b.p.kind]}</td><td class="share"><i style="width:${(b.share * 100).toFixed(2)}%"></i><span>${total > 0 ? share(b.share) : 'n/a'}</span></td><td${money.attrs(b.depth, 'amount')}>${money.text(b.depth, 'amount')}</td><td>${amount(b.amount)}</td><td>${count(b.positions)}</td><td>${b.depth > 0 ? share(b.staked / b.depth) : ''}</td></tr>`;
    const sorted = sortBy(list.map((b, i) => ({ b, rank: i + 1 })), order, BY), shown = sorted.slice(0, all ? ALL : TOP), mine = owner ? sorted.findIndex((x) => x.b.p.address === owner) : -1;
    $('q-rows').innerHTML = shown.map((x) => row(x.b, x.rank)).join('') + (mine >= shown.length ? row(sorted[mine]!.b, sorted[mine]!.rank) : '');
    const more = $('q-more'); more.hidden = list.length <= TOP; more.textContent = all ? `Show the first ${TOP}` : `Show the first ${Math.min(ALL, list.length)}`;
    $('q-unpriced').hidden = !unpriced;
  }
  const say = (t: string, bad = false) => { says.textContent = t; says.toggleAttribute('data-bad', bad); };
  async function run(): Promise<void> {
    if (busy) return;
    busy = true; $('liquidity').hidden = false; say('Reading the positions');
    try {
      const l = await engine.liquidity(path, (p) => say(`Reading the positions, ${Math.round(p * 100)}%`));
      if (!l.pools.length) { got = null; $('q-out').hidden = true; say(l.failed.length ? 'The liquidity could not be read. Try again in a moment.' : l.curve ? 'On the Gnomi curve there are no providers: the curve pays sellers with what buyers put in.' : 'No pool to read.', l.failed.length > 0); return; }
      got = l; $('q-out').hidden = false; draw();
      const low = Math.min(...l.pools.map((p) => p.covered)), odd = l.pools.some((p) => p.covered > 1.001 || p.covered < 0.8);
      if (l.failed.length) say(`Could not read ${l.failed.length === 1 ? 'one pool' : `${l.failed.length} pools`}, so this is incomplete.`, true);
      else if (odd) say('The positions do not add up to what the pools hold. Some figures may be wrong.', true);
      else say(`${l.pools.length === 1 ? 'One pool' : `${l.pools.length} pools`} read. The positions add up to ${low > 0.995 ? 'over 99.5%' : `${(low * 100).toFixed(1)}% or more`} of each pool. The rest sits outside any position, fees not collected yet for example.`);
    } catch { say('The liquidity could not be read. Try again in a moment.', true); }
    finally { busy = false; }
  }
  $('q-more').addEventListener('click', () => { all = !all; draw(); });
  return {
    run, redraw: draw,
    setOwner(a: string | null): void { owner = a; draw(); },
    /** What the other side of each market is worth. */
    setMarkets(rows: readonly MarketRow[]): void {
      const next = new Map(rows.map((r) => [r.key, r.priceGnot === null || !r.price ? null : r.priceGnot / r.price] as const));
      if (next.size === prices.size && [...next].every(([k, v]) => prices.get(k) === v)) return;
      prices = next; draw();
    },
  };
}

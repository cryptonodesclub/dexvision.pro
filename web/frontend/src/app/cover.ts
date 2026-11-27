import { createEngine } from '../core/engine.ts';
import { pick, summarize, type Overview, type Row, type Tab } from '../core/overview.ts';
import { project, type Scene } from '../design/horizon.ts';
import { createFeed, type FeedState } from './feed.ts';
import { openStore, wireClear } from './store.ts';
import { age, count, esc, pct } from './format.ts';
import { createMoney } from './money.ts';
import { shortRealm, symbolOf, tokenUrl } from './links.ts';
import { spectrum, tone } from './spectrum.ts';
import { createStage, narrowHole, searchKeys } from './stage.ts';
import { createWallet } from './wallet.ts';
import { sortable, sortBy, type Keys } from './sort.ts';
import { usdBox } from './usd.ts';
import { walletButton } from './walletbutton.ts';
import { networkSwitch } from './netswitch.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const rowId = (r: { token: { path: string } }) => 'row-' + r.token.path.replace(/[^A-Za-z0-9]/g, '-');
const WIN: Record<string, string> = { 3600000: '1h', 21600000: '6h', 86400000: '24h', 604800000: '7d' };

let camera: Scene;
/* ---- orbit: radius is volume rank, speed is Keplerian ---- */
const bodies = Array.from({ length: 7 }, (_, i) => {
  const el = document.createElement('a'); el.className = 'body'; el.hidden = true; $('orbit').append(el);
  return { el, r: 3.5 + i * 0.72, a: i * 2.4 + 0.4, on: false };
});

createStage((scene) => {
  if (innerWidth < 820) {
    const { x, y, r } = narrowHole();
    scene.zoom = r / (0.1755 * innerHeight); scene.off = [(x - innerWidth / 2) / innerHeight, 0.5 - y / innerHeight];
  } else { scene.zoom = 1.16 * Math.min(1, (innerWidth * 0.64) / innerHeight); scene.off = [(innerWidth / innerHeight) * 0.2, 0.13]; }
  camera = scene;
}, (dt, hole) => {
  for (const b of bodies) {
    if (!b.on) continue;
    b.a += (dt * 1.1) / Math.pow(b.r, 1.5);
    const p = project(camera, Math.cos(b.a) * b.r, Math.sin(b.a) * b.r), behind = Math.sin(b.a) > 0.2;
    // lensed light hides what passes behind the shadow; keep the copy column clear too
    const off = hole.scroll >= 0.5 || (behind && Math.hypot(p.x - hole.x, p.y - hole.y) < innerHeight * 0.21 * camera.zoom) || (innerWidth > 820 && p.x < innerWidth * 0.42) || p.x > innerWidth - 190;
    b.el.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) scale(${Math.min(1.15, 15 / p.depth).toFixed(3)})`;
    b.el.style.opacity = off ? '0' : behind ? '.6' : '1';
    b.el.style.visibility = off ? 'hidden' : 'visible';
    b.el.style.pointerEvents = off ? 'none' : 'auto';
  }
});

const money = createMoney();
/* ---- list ---- */
const params = new URLSearchParams(location.search);
const view = { tab: 'trending' as Tab, win: 864e5, q: '', venue: params.get('market') ?? '' };
let feedState: FeedState | null = null, last = new Map<string, number>();

/** Clicking a header sorts the list; the tab still decides which tokens are in it. */
const BY: Keys<Row> = {
  token: (r) => r.token.symbol, price: (r) => r.price, change: (r) => r.change, volume: (r) => r.volume, depth: (r) => r.depth,
  cap: (r) => r.marketCap, trades: (r) => r.trades, accounts: (r) => r.accounts, market: (r) => r.venue, age: (r) => (r.created === null ? null : -r.created),
};
const order = sortable(document.querySelector('#market table')!, () => render());

function cells(r: Row, now: number, moved: string): string {
  const path = r.token.path, at = path.lastIndexOf('.'), t = tone(r.change);
  return `<th scope="row" class="l"><span class="pair"><a class="open" href="${esc(tokenUrl(path))}"><b>${esc(r.token.symbol)}</b></a><s>${esc(symbolOf(r.quote))}</s><em>${r.feePct}%</em></span><a href="https://${esc(path.slice(0, at))}" class="realm" title="${esc(path)}">${esc(shortRealm(r.token.realm))}</a></th>
    <td class="p ${moved}"${money.attrs(r.price, 'price')}>${money.text(r.price, 'price')}</td><td class="l sp">${spectrum(r.change)}</td><td class="c ${t}">${pct(r.change)}</td>
    <td${money.attrs(r.volume, 'amount')}>${money.text(r.volume, 'amount')}</td><td${money.attrs(r.depth, 'amount')}>${money.text(r.depth, 'amount')}</td><td${money.attrs(r.marketCap, 'amount')}>${money.text(r.marketCap, 'amount')}</td><td>${count(r.trades)}${r.partial ? '+' : ''}</td><td>${count(r.accounts)}</td><td class="l"><span class="venue">${esc(r.venue)}${r.stage ? `<small>${esc(r.stage)}</small>` : ''}</span></td><td>${age(r.created, now)}</td>`;
}

function render() {
  if (!feedState?.snap) { if (feedState?.error) fail(feedState.error); return; }
  const { snap, activity, stale: old, error, moved } = feedState, now = Date.now();
  const o: Overview = summarize(snap, activity, view.win, now), rows = sortBy(pick(o.rows, view.tab, view.q, view.venue), order, BY), w = WIN[view.win]!;
  $('height').textContent = count(snap.height);
  money.set($('vol'), o.volume, 'amount'); $('volk').textContent = `${w} volume, ${money.unit()}`; $('trk').textContent = `${w} trades`;
  money.set($('locked'), o.locked, 'amount'); $('trades').textContent = count(o.trades); $('ntok').textContent = String(o.rows.length);

  venues(o.rows);
  const body = $('rows'), focus = (document.activeElement as HTMLElement | null)?.closest('tr')?.id;
  body.innerHTML = rows.map((r) => {
    const was = last.get(r.token.path), hit = r.price !== null && was !== undefined && r.markets.some((k) => moved.has(k)) && r.price !== was;
    return `<tr id="${rowId(r)}">${cells(r, now, hit ? (r.price! > was! ? 'fu' : 'fd') : '')}</tr>`;
  }).join('');
  if (focus) document.getElementById(focus)?.querySelector('a')?.focus({ preventScroll: true });
  last = new Map(o.rows.flatMap((r) => (r.price === null ? [] : [[r.token.path, r.price] as const])));
  document.querySelector('.scroll')!.classList.toggle('dim', old);

  const empty = $('empty'); empty.hidden = rows.length > 0;
  if (!rows.length) empty.textContent = view.venue && !pick(o.rows, 'trending', '', view.venue).length ? `No token trades on ${view.venue} right now.` : view.q.trim() ? 'No token matches that search. Try a symbol or a path such as gno.land/r/gnoswap/gns.' : !activity || activity.span < view.win ? `Reading the last ${w} of trades` : view.tab === 'gainers' ? `No token is up in the last ${w}. Try a longer window.` : `No token is down in the last ${w}. Try a longer window.`;

  // orbit: whoever trades most, then the deepest
  const top = pick(o.rows, 'volume').slice(0, bodies.length);
  bodies.forEach((b, i) => {
    const r = top[i]; b.on = !!r; b.el.hidden = !r;
    if (!r) return;
    b.el.href = tokenUrl(r.token.path); b.el.className = 'body ' + tone(r.change);
    b.el.innerHTML = `<b>${esc(r.token.symbol)}</b><span>${pct(r.change)}</span>`;
  });
  dispatchEvent(new Event('horizon:redraw'));

  const bad = [...new Set(snap.unavailable.map((u) => u.source))], st = $('state');
  const when = new Date(snap.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  st.textContent = error ? `Could not reach gno.land. Showing prices from ${when}; trying again.` : old ? `Showing prices from ${when} while the chain is read.` : bad.length ? `Could not read ${bad.join(', ')}. Those rows are incomplete.` : `Gnoswap pools and Gnomi launches, read at ${when}. Depth is the GNOT behind the price.`;
  st.toggleAttribute('data-bad', !!error || bad.length > 0);
}
/** The market picker lists the markets the snapshot holds; a market from the address stays listed until it shows up. */
const picker = $<HTMLSelectElement>('venue');
function venues(rows: readonly Row[]) {
  const names = [...new Set(rows.flatMap((r) => r.venues))].sort((a, b) => a.localeCompare(b));
  if (view.venue && !names.includes(view.venue)) names.push(view.venue);
  const want = ['', ...names].join('|');
  if (picker.dataset['list'] !== want) {
    picker.dataset['list'] = want;
    picker.innerHTML = '<option value="">All markets</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  }
  picker.value = view.venue;
}
picker.addEventListener('change', () => {
  view.venue = picker.value;
  const u = new URL(location.href);
  if (view.venue) u.searchParams.set('market', view.venue); else u.searchParams.delete('market');
  history.replaceState(null, '', u);
  render();
});

function fail(reason: string) {
  $('rows').innerHTML = '<tr class="wait"><td colspan="11">Could not reach gno.land. Trying again.</td></tr>';
  console.warn(reason);
  $('state').textContent = 'Check your connection. This page retries on its own.'; $('state').toggleAttribute('data-bad', true);
}

document.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('[data-tab],[data-win]');
  if (!b) return;
  const group = b.dataset['tab'] ? '[data-tab]' : '[data-win]';
  document.querySelectorAll(group).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  if (b.dataset['tab']) view.tab = b.dataset['tab'] as Tab;
  if (b.dataset['win']) { view.win = +b.dataset['win']; feed.cover(view.win); }
  render();
});
const q = searchKeys(() => { view.q = ''; render(); });
q.form!.addEventListener('submit', (e) => { e.preventDefault(); document.querySelector<HTMLAnchorElement>('#rows .open')?.click(); });
q.addEventListener('input', () => { view.q = q.value; render(); });
q.value = view.q = params.get('q') ?? ''; // arriving from another page's search
if (view.q) $('market').scrollIntoView();

const engine = createEngine({ marketTtlMs: 300_000, store: openStore(), history: '/data' });
money.watch(render);
usdBox(money.setRate);
wireClear(engine);
const wallet = createWallet();
walletButton(wallet);
networkSwitch(wallet);
const feed = createFeed(engine, (s) => { feedState = s; render(); });

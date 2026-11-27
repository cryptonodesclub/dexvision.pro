import { NETWORK, WUGNOT } from '../core/config.ts';
import { createEngine } from '../core/engine.ts';
import { detail, type Detail, type MarketRow } from '../core/overview.ts';
import { parseRealm } from '../core/paths.ts';
import { createPriceChart } from './chart.ts';
import { createFeed, type FeedState } from './feed.ts';
import { openStore, wireClear } from './store.ts';
import { age, amount, count, esc, pct, price } from './format.ts';
import { createHolders } from './holders.ts';
import { createLiquidity } from './liquidity.ts';
import { createMoney } from './money.ts';
import { pathFromLocation, realmPage, shortRealm, symbolOf, tokenUrl } from './links.ts';
import { networkSwitch } from './netswitch.ts';
import { spectrum, tone } from './spectrum.ts';
import { createStage, narrowHole, searchKeys } from './stage.ts';
import { createPanel } from './trade.ts';
import { createProfile } from './profile.ts';
import { createWallet } from './wallet.ts';
import { usdBox } from './usd.ts';
import { walletButton } from './walletbutton.ts';
import { sortable, sortBy, type Keys } from './sort.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const WIN: Record<string, string> = { 3600000: '1h', 21600000: '6h', 86400000: '24h', 604800000: '7d' };
const WEEK = 6048e5, SHOWN = 25;
const params = new URLSearchParams(location.search);

let path = '', bare = '', problem = '';
try {
  const r = parseRealm(pathFromLocation(location) ?? '');
  if (r.symbol) path = `${r.realm}.${r.symbol}`; else bare = r.realm; // a realm alone: find its token below
} catch { problem = 'This is not a token address.'; }
// older links keep working, under the readable address
if (path && path !== WUGNOT && location.pathname !== tokenUrl(path)) { const u = new URL(location.href); u.pathname = tokenUrl(path); u.searchParams.delete('t'); history.replaceState(null, '', u); }
if (path === WUGNOT || (bare && WUGNOT.startsWith(`${bare}.`))) problem = 'GNOT is the unit every price here is quoted in, so it has no price of its own.';

/* ---- head ---- */
const symbol = path ? path.slice(path.lastIndexOf('.') + 1) : bare ? bare.slice(bare.lastIndexOf('/') + 1) : 'Lost';
const h1 = document.querySelector('h1')!;
h1.setAttribute('aria-label', symbol); h1.style.setProperty('--n', String(Math.max(4, symbol.length)));
h1.innerHTML = `<span>${esc(symbol)}</span>`;
createStage((scene) => {
  const narrow = innerWidth < 820, n = narrow ? narrowHole() : null, r = n ? n.r : Math.min(innerWidth * 0.13, 190);
  const x = n ? n.x : innerWidth * 0.74, y = n ? n.y : 96 + r;
  scene.zoom = r / (0.1755 * innerHeight); scene.incl = 0.2;
  scene.off = [(x - innerWidth / 2) / innerHeight, 0.5 - y / innerHeight];
});
searchKeys();

const money = createMoney();
/* ---- state ---- */
const view = { win: 864e5, market: params.get('m') ?? '', all: false };
let state: FeedState | null = null, seenActivity: FeedState['activity'] = null, feed: ReturnType<typeof createFeed> | null = null, lastPrice: number | null = null;

/** Own trades by market, as `block|amount`, to mark them in the list. */
const own = new Map<string, Set<string>>();
let owner: string | null = null;
/** Header sorting. Trades run newest first until a header says otherwise. */
const BY_MARKET: Keys<MarketRow> = { pair: (x) => symbolOf(x.pairedWith), market: (x) => x.venue, fee: (x) => x.feePct, price: (x) => x.priceGnot, gap: (x) => (x.main ? 0 : x.gap), depth: (x) => x.depthGnot, volume: (x) => x.volume, trades: (x) => x.trades };
const BY_TRADE: Keys<Detail['trades'][number]> = { time: (t) => t.time, side: (t) => (t.buy ? 'Buy' : 'Sell'), amount: (t) => t.amount, price: (t) => t.priceGnot, value: (t) => t.valueGnot, block: (t) => t.height };
const marketOrder = sortable($('markets').closest('table')!, () => render()), tradeOrder = sortable($('trades').closest('table')!, () => render());
const pick = (d: Detail): MarketRow => d.markets.find((m) => m.key === view.market) ?? d.markets[0]!;

function render() {
  if (!state) return;
  if (state.fatal) return stop(state.error ?? '');
  if (!state.snap) { if (state.error) status('Could not reach gno.land. This page retries on its own.', true); return; }
  const now = Date.now(), d = detail(state.snap, state.activity, path, view.win, now);
  if (!d) return stop('This token is no longer in any market that could be read.');
  const { row } = d, m = pick(d), w = WIN[view.win]!;
  $('height').textContent = count(state.snap.height);

  const px = $('px'); money.set(px, row.price, 'price');
  if (lastPrice !== null && row.price !== null && row.price !== lastPrice) { px.className = ''; void px.offsetWidth; px.className = row.price > lastPrice ? 'fu' : 'fd'; }
  lastPrice = row.price;
  $('chg').textContent = pct(row.change); $('chg').className = 'c ' + tone(row.change); $('spec').innerHTML = spectrum(row.change);
  document.title = `${symbol} ${money.text(row.price, 'price')}${money.unit() === 'GNOT' ? ' GNOT' : ''}, DexVision`;
  const fact = (id: string, v: string) => { $(id).textContent = v; };
  const cash = (id: string, v: number | null) => money.set($(id), v, 'amount'), u = money.unit();
  cash('f-vol', row.volume); $('k-vol').textContent = `${w} volume, ${u}`; $('k-dep').textContent = `Depth, ${u}`; $('k-cap').textContent = `Market cap, ${u}`; fact('f-tr', count(row.trades) + (row.partial ? '+' : '')); $('k-tr').textContent = `${w} trades`;
  cash('f-dep', row.depth); cash('f-cap', row.marketCap); fact('f-acc', count(row.accounts)); fact('f-age', age(row.created, now));
  const sup = state.snap.supply.get(path); fact('f-sup', amount(sup?.supply ?? null)); fact('f-dec', String(row.token.decimals));

  $('markets').innerHTML = sortBy(d.markets, marketOrder, BY_MARKET).map((x) => `<tr class="${x.active ? '' : 'off'}" aria-selected="${x.key === m.key}">
    <th scope="row" class="l"><button class="open" data-market="${esc(x.key)}" aria-pressed="${x.key === m.key}"><b>${esc(symbol)}</b> / ${esc(symbolOf(x.pairedWith))}</button></th>
    <td class="l"><span class="venue">${esc(x.venue)}${x.stage ? `<small>${esc(x.stage)}</small>` : ''}</span></td><td>${x.feePct}%</td><td class="p"${money.attrs(x.priceGnot, 'price')}>${money.text(x.priceGnot, 'price')}</td>
    <td class="${x.main ? 'flat' : tone(x.gap)}">${x.main ? 'sets the price' : pct(x.gap)}</td><td${money.attrs(x.depthGnot, 'amount')}>${money.text(x.depthGnot, 'amount')}</td><td${money.attrs(x.volume, 'amount')}>${money.text(x.volume, 'amount')}</td><td>${count(x.trades)}</td></tr>`).join('');

  const mine = sortBy(d.trades.filter((t) => t.market === m.key), tradeOrder, BY_TRADE), list = view.all ? mine : mine.slice(0, SHOWN);
  $('amt-of').textContent = symbol; $('q-sym').textContent = symbol;
  $('trades-of').textContent = `${symbol} / ${symbolOf(m.pairedWith)}, ${m.venue}${money.unit() === 'USD' ? ', in dollars at today’s GNOT price' : ''}`;
  $('trades').innerHTML = list.map((t) => `<tr><td class="l">${esc(ago(t.time, now))}</td><td class="l c ${t.buy ? 'up' : 'down'}">${t.buy ? 'Buy' : 'Sell'}${own.get(m.key)?.has(`${t.height}|${t.amount}`) ? ' <span class="you">you</span>' : ''}</td><td${money.attrs(t.valueGnot, 'amount', true, true)}>${amount(t.amount)}</td><td${money.attrs(t.priceGnot, 'price', true)}>${money.text(t.priceGnot, 'price')}</td><td${money.attrs(t.valueGnot, 'amount', true)}>${money.text(t.valueGnot, 'amount')}</td><td>${count(t.height)}</td></tr>`).join('');
  const more = $('more'); more.hidden = mine.length <= SHOWN; more.textContent = view.all ? 'Show fewer' : `Show all ${mine.length}`;
  const none = $('no-trades'); none.hidden = mine.length > 0;
  none.textContent = !state.activity ? 'Reading trades' : 'No trades here in the last 7 days.';

  slots(m);
  people?.setPrice(row.price); backing?.setMarkets(d.markets);
  const when = new Date(state.snap.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), bad = [...new Set(state.snap.unavailable.map((u) => u.source))];
  if (state.error) status(`Could not reach gno.land. Showing prices from ${when}; trying again.`, true);
  else if (state.stale) status(`Showing prices from ${when} while the chain is read.`, false);
  else if (bad.length) status(`Could not read ${bad.join(', ')}. Some figures may be incomplete.`, true);
  else status(`Read from the chain at ${when}. Depth is the GNOT behind the price.`, false);
}
const ago = (t: number, now: number) => (now - t < 6e4 ? 'now' : age(t, now) + ' ago');
function status(text: string, bad: boolean) { $('state').textContent = text; $('state').toggleAttribute('data-bad', bad); }

/* ---- chart and trade panel follow the selected market ---- */
let chart: ReturnType<typeof createPriceChart> | null = null, panel: ReturnType<typeof createPanel> | null = null;
function slots(m: MarketRow) {
  $('trade-pair').textContent = `${symbol} / ${symbolOf(m.pairedWith)}`; $('trade-venue').textContent = `${m.venue}, ${m.feePct}% fee`;
  money.set($('trade-price'), m.priceGnot, 'price', `${price(m.price)} ${symbolOf(m.pairedWith)}`); money.set($('trade-depth'), m.depthGnot, 'amount', `${amount(m.depthGnot)} GNOT`);
  $('chart-pair').textContent = `${symbol} / ${symbolOf(m.pairedWith)}`; $('chart-venue').textContent = m.venue;
  if (!chart) { chart = createPriceChart(engine, path, (k, l) => { own.set(k, new Set(l.map((t) => `${t.height}|${t.amount}`))); render(); }); chart.setOwner(owner); } if (NETWORK.trading) panel ??= createPanel(engine, wallet, money, path, () => { setTimeout(() => feed?.poke(), 4000); });
  else $('trade-soon').textContent = `Trading on ${NETWORK.chainId} opens here soon. Try it now on the onyx-1 testnet from the header.`;
  chart.setMarket(m, state!.snap!.markets.find((x) => x.key === m.key)?.m ?? null); void panel?.setMarket(m);
  if (state!.moved.has(m.key) && state!.activity !== seenActivity) { seenActivity = state!.activity; chart.refresh(); }
}

function stop(message: string) {
  $('page').hidden = true; $('stop').hidden = false; $('stop-why').textContent = message;
  document.title = 'Token not found, DexVision';
}

document.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('[data-win],[data-market],#more,#copy,[data-file]');
  if (!b) return;
  if (b.dataset['win']) { view.win = +b.dataset['win']; document.querySelectorAll('[data-win]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); render(); }
  else if (b.dataset['market']) {
    view.market = b.dataset['market']; view.all = false;
    const u = new URL(location.href); u.searchParams.set('m', view.market); history.replaceState(null, '', u);
    render(); document.querySelector<HTMLElement>(`[data-market="${CSS.escape(view.market)}"]`)?.focus({ preventScroll: true });
  } else if (b.id === 'more') { view.all = !view.all; render(); }
  else if (b.dataset['file']) void openFile(b.dataset['file']);
  else if (b.id === 'copy') navigator.clipboard.writeText(path).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy address'; }, 1500); }, () => { b.textContent = 'Could not copy'; });
});

/* ---- source: the contract as published, on demand ---- */
const wallet = createWallet();
const engine = createEngine({ marketTtlMs: 300_000, store: openStore(), history: '/data' });
const realm = path.slice(0, path.lastIndexOf('.'));
const KEYWORDS = /\b(package|import|func|var|const|type|struct|interface|map|return|if|else|for|range|switch|case|default|panic|defer|crossing|cross|realm)\b/;
/** One pass over comments, strings and keywords, escaping everything it does not recognise. */
function highlight(src: string): string {
  const re = new RegExp(`(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|("(?:[^"\\\\\\n]|\\\\.)*"|\`[^\`]*\`)|${KEYWORDS.source}`, 'g');
  let out = '', at = 0;
  for (const m of src.matchAll(re)) { out += esc(src.slice(at, m.index)) + `<${m[1] ? 'i' : m[2] ? 'q' : 'b'}>${esc(m[0])}</${m[1] ? 'i' : m[2] ? 'q' : 'b'}>`; at = m.index + m[0].length; }
  return out + esc(src.slice(at));
}
async function openFile(file: string) {
  document.querySelectorAll<HTMLElement>('[data-file]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset['file'] === file)));
  const code = $('code'); code.textContent = 'Reading the source';
  try { const src = await engine.sourceFile(realm, file); if (document.querySelector(`[data-file="${CSS.escape(file)}"][aria-pressed="true"]`)) code.innerHTML = highlight(src); }
  catch { code.textContent = 'The source could not be read. Try again in a moment.'; }
}
$('source').addEventListener('toggle', async () => {
  if (!($('source') as HTMLDetailsElement).open || $('files').childElementCount) return;
  $('code').textContent = 'Reading the source';
  try {
    const files = await engine.sourceFiles(realm);
    $('files').innerHTML = files.map((f) => `<button data-file="${esc(f)}" aria-pressed="false">${esc(f)}</button>`).join('');
    const first = files.find((f) => f.startsWith(realm.split('/').pop()!)) ?? files.find((f) => /token/.test(f)) ?? files[0];
    if (first) await openFile(first); else $('code').textContent = 'This realm publishes no source files.';
  } catch { $('code').textContent = 'The source could not be read. Close this and open it again to retry.'; }
});

/* ---- Trades | Holders tabs ---- */
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tabrow [role="tab"]')];
function showTab(t: HTMLButtonElement, focus = false) {
  for (const x of tabs) {
    const on = x === t;
    x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1;
    $(x.getAttribute('aria-controls')!).hidden = !on;
  }
  $('trades-of').hidden = t.id !== 'tab-trades';
  if (t.id === 'tab-holders') { people?.redraw(); backing?.redraw(); } // a hidden canvas has no size to draw at
  if (focus) t.focus();
}
for (const t of tabs) {
  t.addEventListener('click', () => showTab(t));
  t.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(t), n = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (n) { e.preventDefault(); showTab(tabs[(i + n + tabs.length) % tabs.length]!, true); }
  });
}

const people = path && !problem ? createHolders(engine, money, path, symbol, () => void backing?.run()) : null, backing = people && createLiquidity(engine, money, path);
money.watch(() => { render(); people?.redraw(); backing?.redraw(); });
usdBox(money.setRate);
wireClear(engine);
walletButton(wallet);
networkSwitch(wallet);
wallet.watch((s) => { owner = s.address; if (!owner) own.clear(); chart?.setOwner(owner); people?.setOwner(owner); backing?.setOwner(owner); });
/** /token/r/gnoswap/gns: the realm's only token, or a choice when it holds several. */
async function fromRealm(): Promise<void> {
  $('page').hidden = true; $('stop').hidden = false; $('stop-why').textContent = 'Looking for this realm’s token';
  try {
    const { list, unavailable } = await engine.markets(), found = [...new Set(list.flatMap((m) => [m.token0, m.token1]))].filter((t) => t.slice(0, t.lastIndexOf('.')) === bare && t !== WUGNOT);
    if (found.length === 1) { location.replace(tokenUrl(found[0]!) + location.search); return; }
    if (!found.length) return stop(`No known market trades a token from ${bare}.${unavailable.length ? ` Could not check ${unavailable.map((u) => u.source).join(', ')}.` : ''}`);
    $('stop-why').textContent = 'This realm holds several tokens. Choose one:';
    $('stop-list').innerHTML = found.map((t) => `<a href="${esc(tokenUrl(t))}">${esc(symbolOf(t))}</a>`).join('');
    document.title = `${symbol}, DexVision`;
  } catch { stop('Could not reach gno.land. Reload to try again.'); }
}
if (problem) stop(problem);
else if (bare) void fromRealm();
else {
  const link = $<HTMLAnchorElement>('realm'); link.href = realmPage(realm); link.textContent = shortRealm(realm);
  feed = createFeed(engine, (s) => { state = s; render(); }, { scope: path, span: WEEK });
  createProfile(wallet, path);
}

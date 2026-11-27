import { ColorType, createChart, CrosshairMode, HistogramSeries, LineStyle, PriceScaleMode, type AutoscaleInfo, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Engine, OwnTrade, TradeSet } from '../core/engine.ts';
import type { MarketRow } from '../core/overview.ts';
import { candles, ema, sides, type Candle, type Sides } from '../core/price.ts';
import type { Market } from '../core/venues/venue.ts';
import { EmissionSeries, type Line } from './emission.ts';
import { amount, price } from './format.ts';
import { symbolOf } from './links.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const M = 6e4, H = 36e5, D = 24 * H;
/** Interval, and how far back it reads: `long` once the whole history is on the device, `range` while it is not. */
const FRAMES: Record<string, { interval: number; range: number; long: number }> = {
  '1m': { interval: M, range: 12 * H, long: 2 * D }, '3m': { interval: 3 * M, range: D, long: 5 * D }, '5m': { interval: 5 * M, range: 2 * D, long: 10 * D }, '15m': { interval: 15 * M, range: 4 * D, long: 30 * D },
  '1h': { interval: H, range: 4 * D, long: 30 * D }, '4h': { interval: 4 * H, range: 14 * D, long: 120 * D }, '1d': { interval: D, range: 45 * D, long: 1500 * D } };
const SHOWN = 110; // bars in view at first; the rest is a drag away
const EMA = 20;
const SCALES = { linear: PriceScaleMode.Normal, log: PriceScaleMode.Logarithmic, percent: PriceScaleMode.Percentage } as const;
type Scale = keyof typeof SCALES;
type Tool = 'volume' | 'ema' | 'trades' | 'mine';
interface Prefs { scale: Scale; volume: boolean; ema: boolean; trades: boolean; mine: boolean }

/** Axis labels: prices are never negative, and rounding noise around zero is zero. */
/** A price scale at least this wide around the middle, so a move of a billionth does not fill the chart. */
const FLOOR = 0.001;
export function widen(lo: number, hi: number): { minValue: number; maxValue: number } {
  const mid = (lo + hi) / 2, half = Math.max((hi - lo) / 2, mid * FLOOR / 2);
  return { minValue: mid - half, maxValue: mid + half };
}
const axis = (p: number) => (p < -1e-12 ? '' : p < 1e-12 ? '0' : price(p));
const PREFS = 'dexvision:chart';
function readPrefs(): Prefs {
  const d: Prefs = { scale: 'linear', volume: true, ema: true, trades: true, mine: true };
  try {
    const j = JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>;
    return { scale: j.scale !== undefined && j.scale in SCALES ? j.scale : d.scale, volume: j.volume ?? d.volume, ema: j.ema ?? d.ema, trades: j.trades ?? d.trades, mine: j.mine ?? d.mine };
  } catch { return d; }
}

export function createPriceChart(engine: Engine, path: string, onMine: (market: string, list: readonly OwnTrade[]) => void = () => {}) {
  const box = $('plot'), says = $('chart-says');
  let chart: IChartApi | null = null, frame = '4h', market: MarketRow | null = null, live: Market | null = null, turn = 0, whole = false;
  void engine.indexer.whole.then((w) => { whole = w; });
  const reach = () => { const f = FRAMES[frame]!; return whole ? f.long : f.range; };
  const cache = new Map<string, TradeSet>();

  const token = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const up = token('--blue'), down = token('--red');
  const prefs = readPrefs();
  let parts: ReturnType<typeof mount> | null = null, volume: ISeriesApi<'Histogram'> | null = null, drawn: { lines: Line[]; cs: Candle[]; tz: number } | null = null;
  let last: Line | null = null, byTime = new Map<number, { c: Candle; s: Sides | undefined; ema: number | null; own: OwnTrade[] }>();
  let owner: string | null = null, own: OwnTrade[] = [], ownTurn = 0, shown: TradeSet | null = null;

  function mount() {
    const c = createChart(box, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8c8c8c', fontFamily: "'Martian Mono Variable', ui-monospace, monospace", fontSize: 11, attributionLogo: true, panes: { separatorColor: '#f0f0f024', separatorHoverColor: '#49afeb44' } },
      grid: { vertLines: { color: '#f0f0f00d' }, horzLines: { color: '#f0f0f00d' } },
      rightPriceScale: { borderColor: '#f0f0f024', scaleMargins: { top: 0.14, bottom: 0.12 }, mode: SCALES[prefs.scale] },
      timeScale: { borderColor: '#f0f0f024', timeVisible: true, secondsVisible: false, rightOffset: 2, minBarSpacing: 1.5 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#49afeb88', style: LineStyle.Solid, width: 1, labelBackgroundColor: '#21506b' }, horzLine: { color: '#49afeb88', style: LineStyle.Dotted, width: 1, labelBackgroundColor: '#21506b' } },
      // nothing can lose more than everything
      localization: { percentageFormatter: (p: number) => (p < -100 ? '' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(Math.abs(p) < 10 ? 2 : 0)}%`) },
    });
    const main = c.addCustomSeries(new EmissionSeries(), { up, down, priceLineColor: '#f0f0f066', priceLineStyle: LineStyle.Dotted, priceFormat: { type: 'custom', formatter: axis, minMove: 1e-9 },
      autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => { const r = base(); return r?.priceRange ? { ...r, priceRange: widen(r.priceRange.minValue, r.priceRange.maxValue) } : r; } });
    c.subscribeCrosshairMove((m) => { const d = m.seriesData.get(main) as Line | undefined; legend(d ?? last); });
    chart = c;
    return { main };
  }

  function legend(d: Line | null) {
    const k = d && byTime.get(d.time as number);
    const rows: [string, string][] = !d ? [] : [['O', price(d.open)], ['H', price(d.high)], ['L', price(d.low)], ['C', price(d.close)], ['Vol', amount(k?.c.vol ?? 0)]];
    if (k?.ema != null && prefs.ema) rows.push([`EMA ${EMA}`, price(k.ema)]);
    if (k?.s && prefs.trades) rows.push(['Buys', String(k.s.buys)], ['Sells', String(k.s.sells)]);
    if (k && prefs.mine) for (const t of k.own.slice(-3)) rows.push([t.buy ? 'You bought' : 'You sold', `${amount(t.amount)} at ${price(t.price)}`]);
    $('ohlc').innerHTML = rows.map(([a, b]) => `<span><i>${a}</i>${b}</span>`).join('');
  }

  /** Adds or removes the optional layers to match what is switched on. */
  function layers() {
    if (!parts || !chart || !drawn) return;
    const { lines, cs } = drawn, enough = cs.length >= EMA;
    parts.main.applyOptions({ showEma: prefs.ema && enough, showTrades: prefs.trades, showMine: prefs.mine && own.length > 0 } as Parameters<typeof parts.main.applyOptions>[0]);

    if (prefs.volume) {
      if (!volume) {
        volume = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'custom', formatter: (v: number) => amount(v), minMove: 1e-6 } }, 1);
        volume.priceScale().applyOptions({ scaleMargins: { top: 0.18, bottom: 0 }, mode: PriceScaleMode.Normal });
        const [a, b] = chart.panes(); a?.setStretchFactor(4); b?.setStretchFactor(1);
      }
      volume.setData(lines.map((l, i) => ({ time: l.time, value: cs[i]!.vol, color: (l.close >= l.open ? up : down) + 'b0' })));
    } else if (volume) { chart.removeSeries(volume); volume = null; }

    chart.priceScale('right').applyOptions({ mode: SCALES[prefs.scale] });
    buttons(enough);
    legend(last);
  }
  function buttons(enough = true) {
    document.querySelectorAll<HTMLElement>('[data-scale]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset['scale'] === prefs.scale)));
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      const t = b.dataset['tool'] as Tool;
      b.hidden = t === 'mine' && !owner;
      b.disabled = (t === 'ema' && !enough) || (t === 'mine' && !own.length); b.title = !b.disabled ? '' : t === 'ema' ? `Needs ${EMA} candles` : 'This account has not traded here';
      b.setAttribute('aria-pressed', String(prefs[t] && !b.disabled));
    });
  }

  function show(set: TradeSet) {
    shown = set;
    const { interval } = FRAMES[frame]!, now = Date.now(), from = Math.max(now - reach(), set.seed === undefined && set.trades.length ? set.trades[0]!.t - interval : 0);
    const before = set.trades.filter((t) => t.t < Math.floor(from / interval) * interval).at(-1)?.price ?? set.seed;
    const all = candles(set.trades, from, now, interval, before), cs = all.slice(all.findIndex((c) => c.swaps > 0 || before !== undefined)), max = Math.max(...cs.map((c) => c.vol), 1e-12);
    if (!cs.length) { drawn = null; says.textContent = 'This market has no price in this range yet.'; says.hidden = false; return; }
    const tz = new Date().getTimezoneOffset() * 60_000; // the axis prints UTC; shift it to the reader's clock
    const avg = ema(cs.map((c) => c.c), EMA), by = sides(set.trades, interval), heaviest = Math.max(...[...by.values()].flatMap((x) => [x.bought, x.sold]), 1e-12);
    const ours = new Map<number, OwnTrade[]>();
    for (const t of own) { const k = Math.floor(t.t / interval) * interval; (ours.get(k) ?? ours.set(k, []).get(k)!).push(t); }
    const weight = (n: number | undefined) => (n ? Math.max(0.02, Math.sqrt(n / heaviest)) : 0);
    const lines = cs.map((c, i): Line => ({ time: ((c.t - tz) / 1000) as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c, glow: Math.sqrt(c.vol / max), quiet: c.swaps === 0, ema: avg[i]!, buy: weight(by.get(c.t)?.bought), sell: weight(by.get(c.t)?.sold), mine: ours.get(c.t) ?? [] }));
    byTime = new Map(cs.map((c, i) => [(c.t - tz) / 1000, { c, s: by.get(c.t), ema: avg[i]!, own: ours.get(c.t) ?? [] }]));
    drawn = { lines, cs, tz };
    parts ??= mount();
    parts.main.setData(lines); last = lines.at(-1)!;
    layers();
    says.hidden = !cs.every((c) => c.swaps === 0); says.textContent = 'No trades in this range. The line marks the last price.';
    $('chart-part').hidden = !set.partial;
  }
  function blank() {
    drawn = null; shown = null; byTime = new Map(); last = null; legend(null);
    parts?.main.setData([]); volume?.setData([]);
  }
  async function load(fresh = false) {
    if (!market) return;
    const mine = ++turn, m = market, f = FRAMES[frame]!, key = `${m.key}|${frame}`, had = cache.get(key);
    $('chart-unit').textContent = `in ${symbolOf(m.pairedWith)}`;
    document.querySelectorAll<HTMLElement>('[data-frame]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset['frame'] === frame)));
    const view = () => { const n = byTime.size; chart?.timeScale().setVisibleLogicalRange({ from: n - Math.min(n, SHOWN) - 0.5, to: n + 1.5 }); };
    if (had && !fresh) { show(had); view(); return; }
    if (!fresh) { says.textContent = 'Reading trades from the chain'; says.hidden = false; blank(); }
    let painted = false;
    try {
      if (!fresh && live) { // what is already here, at once
        const old = await engine.peekTrades(path, live, Date.now() - reach() - f.interval);
        if (mine !== turn) return;
        if (old?.trades.length) { show(old); view(); painted = true; }
      }
      whole = await engine.indexer.whole;
      const set = await engine.trades(path, m.key, Date.now() - reach() - f.interval);
      cache.set(key, set);
      if (mine !== turn) return;
      show(set); if (!fresh && !painted) view();
    } catch { if (mine === turn && !fresh && !painted) { says.textContent = 'The trades could not be read.'; says.hidden = false; $('chart-retry').hidden = false; } return; }
    $('chart-retry').hidden = true;
  }
  /** The connected account's trades in this market. Silent on failure: the chart is whole without them. */
  async function loadMine(): Promise<void> {
    const mine = ++ownTurn, m = live, who = owner;
    if (!m || !who) { if (own.length) { own = []; if (shown) show(shown); } buttons((drawn?.cs.length ?? EMA) >= EMA); if (market) onMine(market.key, own); return; }
    await engine.indexer.whole;
    const got = await engine.myTrades(path, m, who).catch(() => null);
    if (mine !== ownTurn || !got) return;
    own = got;
    if (shown) show(shown); else buttons();
    if (market) onMine(market.key, own);
  }

  // short candles: a quiet market still gets its empty bars as time passes, from what is already loaded
  setInterval(() => {
    const f = FRAMES[frame]!, ts = chart?.timeScale();
    if (!shown || f.interval >= H || document.hidden) return;
    const following = !ts || ts.scrollPosition() > -1; // looking at now, not scrolled back
    show(shown);
    if (following) ts?.scrollToRealTime();
  }, 15_000);

  $('chart').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-frame],[data-scale],[data-tool],#chart-retry');
    if (!b) return;
    if (b.dataset['scale'] || b.dataset['tool']) {
      if (b.dataset['scale']) prefs.scale = b.dataset['scale'] as Scale;
      else { const t = b.dataset['tool'] as Tool; prefs[t] = !prefs[t]; }
      try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* storage blocked */ }
      buttons((drawn?.cs.length ?? EMA) >= EMA); layers();
      return;
    }
    if (b.dataset['frame']) frame = b.dataset['frame'];
    void load();
  });
  buttons();
  return {
    setMarket(m: MarketRow, l: Market | null) { const same = market?.key === m.key; market = m; live = l; if (!same) { own = []; void load(); void loadMine(); } },
    /** Whose trades to mark, or null. */
    setOwner(a: string | null) { if (a === owner) return; owner = a; own = []; if (shown) show(shown); void loadMine(); },
    /** The market traded: read it again without moving the view. */
    refresh() { for (const k of cache.keys()) if (market && k.startsWith(market.key) && !k.endsWith('|' + frame)) cache.delete(k); void load(true); if (owner) void loadMine(); },
  };
}

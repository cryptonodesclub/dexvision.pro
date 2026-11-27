import type { CustomBarItemData, CustomData, CustomSeriesOptions, CustomSeriesPricePlotValues, CustomSeriesWhitespaceData, ICustomSeriesPaneRenderer, ICustomSeriesPaneView, PaneRendererCustomData, PriceToCoordinateConverter, Time } from 'lightweight-charts';
import { customSeriesDefaultOptions } from 'lightweight-charts';

/** A candle drawn as an emission line: the body is the bright core, the range its faint extent, volume its glow. */
export interface Line extends CustomData<Time> { open: number; high: number; low: number; close: number; glow: number; quiet: boolean; /** Moving average here, if known. */ ema: number | null; /** Weight of each side, 0 (none) to 1 (the heaviest in view). */ buy: number; sell: number; /** The reader's own trades here. */ mine: readonly { price: number; buy: boolean }[] }
interface Options extends CustomSeriesOptions { up: string; down: string; dim: string; average: string; showEma: boolean; showTrades: boolean; showMine: boolean }
type Target = Parameters<ICustomSeriesPaneRenderer['draw']>[0];

const rgba = (hex: string, a: number) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',')},${a})`;

class Renderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<Time, Line> | null = null;
  private o: Options | null = null;
  update(data: PaneRendererCustomData<Time, Line>, o: Options) { this.data = data; this.o = o; }
  draw(target: Target, y: PriceToCoordinateConverter) {
    target.useBitmapCoordinateSpace(({ context: c, horizontalPixelRatio: hx, verticalPixelRatio: vx }) => {
      const d = this.data, o = this.o;
      if (!d?.visibleRange || !o) return;
      const slot = d.barSpacing * hx;
      const tick = (x: number, at: number, w: number, up: boolean) => { // weight sets size and strength, so big trades stand out
        const h = (2 + 3.6 * w) * vx, half = (1.6 + 2.8 * w) * hx, s = up ? 1 : -1, tip = at + s * 6 * vx;
        c.fillStyle = rgba(up ? o.up : o.down, 0.22 + 0.78 * w);
        c.beginPath(); c.moveTo(x, tip); c.lineTo(x - half, tip + s * h); c.lineTo(x + half, tip + s * h); c.fill();
      };
      for (let i = d.visibleRange.from; i < d.visibleRange.to; i++) {
        const b: CustomBarItemData<Time, Line> | undefined = d.bars[i];
        if (!b) continue;
        const v = b.originalData, x = Math.round(b.x * hx), yo = y(v.open), yc = y(v.close), yh = y(v.high), yl = y(v.low);
        if (yo === null || yc === null || yh === null || yl === null) continue;
        if (v.quiet) { // nothing traded: a faint mark keeps the price level visible
          const w = Math.max(1, Math.min(slot * 0.5, 10 * hx));
          c.fillStyle = rgba(o.dim, 0.55); c.fillRect(Math.round(x - w / 2), Math.round(yc * vx), Math.round(w), Math.max(1, Math.round(vx)));
          continue;
        }
        const up = v.close >= v.open, col = up ? o.up : o.down, core = Math.max(2 * hx, Math.min(slot * 0.26, 7 * hx)), halo = Math.max(core * 1.6, Math.min(slot * 1.5, 46 * hx)) * (0.55 + v.glow * 0.45);
        const top = Math.min(yo, yc) * vx, bot = Math.max(yo, yc) * vx, hi = yh * vx, lo = yl * vx, pad = 5 * vx;
        // glow
        const g = c.createLinearGradient(x - halo, 0, x + halo, 0), a = (up ? 0.16 : 0.1) + v.glow * (up ? 0.5 : 0.3);
        g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.5, rgba(col, a)); g.addColorStop(1, rgba(col, 0));
        c.fillStyle = g; c.fillRect(x - halo, top - pad, halo * 2, Math.max(bot - top, 1) + pad * 2);
        // range
        c.fillStyle = rgba(col, 0.5); c.fillRect(Math.round(x - hx / 2), Math.round(hi), Math.max(1, Math.round(hx)), Math.max(1, Math.round(lo - hi)));
        // core: filled when it rose, hollow when it fell, so colour is not the only cue
        const h = Math.max(bot - top, 2 * vx), cx = Math.round(x - core / 2), cw = Math.round(core);
        if (up) { c.fillStyle = col; c.fillRect(cx, Math.round(top), cw, Math.round(h)); if (cw >= 5) { c.fillStyle = 'rgba(255,255,255,.75)'; c.fillRect(Math.round(x - hx / 2), Math.round(top), Math.max(1, Math.round(hx)), Math.round(h)); } }
        else { c.fillStyle = '#090909'; c.fillRect(cx, Math.round(top), cw, Math.round(h)); c.strokeStyle = col; c.lineWidth = Math.max(1, Math.round(1.25 * hx)); c.strokeRect(cx + 0.5, Math.round(top) + 0.5, Math.max(1, cw - 1), Math.max(1, Math.round(h) - 1)); }
        if (o.showTrades) { if (v.buy) tick(x, lo, v.buy, true); if (v.sell) tick(x, hi, v.sell, false); }
      }
      if (o.showEma) { // drawn here, not as a second series, so it follows the same scale in every mode
        c.beginPath(); c.strokeStyle = o.average; c.lineWidth = 1.25 * vx; c.lineJoin = 'round';
        let pen = false;
        for (let i = Math.max(0, d.visibleRange.from - 1); i < Math.min(d.bars.length, d.visibleRange.to + 1); i++) {
          const b = d.bars[i], at = b && b.originalData.ema !== null ? y(b.originalData.ema) : null;
          if (!b || at === null) { pen = false; continue; }
          if (pen) c.lineTo(b.x * hx, at * vx); else c.moveTo(b.x * hx, at * vx);
          pen = true;
        }
        c.stroke();
      }
      if (o.showMine) { // on top of everything: a diamond at the price paid
        const size = Math.max(4.5, Math.min(7, 3 + d.barSpacing * 0.25)) * hx;
        for (let i = d.visibleRange.from; i < d.visibleRange.to; i++) {
          const b = d.bars[i];
          for (const t of b?.originalData.mine ?? []) {
            const at = y(t.price);
            if (at === null || !b) continue;
            const x = b.x * hx, py = at * vx;
            c.beginPath(); c.moveTo(x, py - size); c.lineTo(x + size, py); c.lineTo(x, py + size); c.lineTo(x - size, py); c.closePath();
            c.fillStyle = t.buy ? o.up : o.down; c.fill();
            c.strokeStyle = '#fff'; c.lineWidth = 1.5 * hx; c.stroke();
          }
        }
      }
    });
  }
}

export class EmissionSeries implements ICustomSeriesPaneView<Time, Line, Options> {
  private r = new Renderer();
  priceValueBuilder(d: Line): CustomSeriesPricePlotValues { return [d.high, d.low, d.close]; }
  isWhitespace(d: Line | CustomSeriesWhitespaceData<Time>): d is CustomSeriesWhitespaceData<Time> { return (d as Partial<Line>).close === undefined; }
  renderer(): ICustomSeriesPaneRenderer { return this.r; }
  update(data: PaneRendererCustomData<Time, Line>, o: Options): void { this.r.update(data, o); }
  defaultOptions(): Options { return { ...customSeriesDefaultOptions, color: '#49afeb', up: '#49afeb', down: '#eb6c49', dim: '#7c7c7c', average: '#a9dcfb', showEma: false, showTrades: false, showMine: false }; }
}

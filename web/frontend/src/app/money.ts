import { amount, price, usdAmount, usdPrice } from './format.ts';

/** Figures worth GNOT: shown in the chosen unit, with the other one in a tooltip. */
export type Unit = 'GNOT' | 'USD';
export type Kind = 'price' | 'amount';

export function display(gnot: number | null, kind: Kind, unit: Unit, rate: number | null): string {
  if (unit === 'USD' && rate !== null) return kind === 'price' ? usdPrice(gnot === null ? null : gnot * rate) : usdAmount(gnot === null ? null : gnot * rate);
  return kind === 'price' ? price(gnot) : amount(gnot);
}
/** The tooltip: whichever unit is not on screen. Empty when there is nothing to say. */
export function other(gnot: number, kind: Kind, unit: Unit, rate: number | null, past: boolean): string {
  if (rate === null) return '';
  const t = unit === 'USD' ? `${display(gnot, kind, 'GNOT', rate)} GNOT` : display(gnot, kind, 'USD', rate);
  return past && unit === 'GNOT' ? `${t} at today’s GNOT price` : t; // an old trade was not made at this rate
}

const KEY = 'dexvision:unit';
export function createMoney() {
  let wanted: Unit = 'GNOT', rate: number | null = null;
  try { if (localStorage.getItem(KEY) === 'USD') wanted = 'USD'; } catch { /* storage blocked */ }
  const watchers = new Set<() => void>();
  /** Dollars need a rate; without one everything stays in GNOT. */
  const unit = (): Unit => (wanted === 'USD' && rate !== null ? 'USD' : 'GNOT');

  function buttons() {
    document.querySelectorAll<HTMLButtonElement>('[data-unit-set]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset['unitSet'] === unit()));
      if (b.dataset['unitSet'] === 'USD') { b.disabled = rate === null; b.title = rate === null ? 'The dollar price is not available' : ''; }
    });
    document.querySelectorAll('.unit').forEach((e) => { e.textContent = unit(); });
  }
  const changed = () => { buttons(); hide(); for (const f of watchers) f(); };

  /* one tooltip for the page */
  const tip = document.createElement('div');
  tip.className = 'tooltip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true; document.body.append(tip);
  let over: HTMLElement | null = null, at = { x: 0, y: 0 }, queued = false;
  function hide() { over = null; tip.hidden = true; }
  function look() {
    queued = false;
    // rows are covered by a link, so ask what lies under the pointer instead of what received it
    const el = (document.elementsFromPoint(at.x, at.y).find((e) => e instanceof HTMLElement && e.dataset['gnot'] !== undefined) ?? null) as HTMLElement | null;
    if (!el) return hide();
    const text = other(Number(el.dataset['gnot']), el.dataset['kind'] as Kind, el.dataset['fixed'] === undefined ? unit() : 'GNOT', rate, el.dataset['past'] !== undefined);
    if (!text) return hide();
    if (el !== over || tip.textContent !== text) {
      over = el; tip.textContent = text; tip.hidden = false;
      const r = el.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(el);
      const t = range.getBoundingClientRect(), w = tip.offsetWidth, mid = t.width ? t.left + t.width / 2 : r.left + r.width / 2; // over the figure, not the whole cell
      const above = t.top - tip.offsetHeight - 8;
      tip.style.left = `${Math.max(6, Math.min(document.documentElement.clientWidth - w - 6, mid - w / 2)).toFixed(0)}px`;
      tip.style.top = `${(above > 4 ? above : t.bottom + 8).toFixed(0)}px`;
    }
  }
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    at = { x: e.clientX, y: e.clientY };
    if (!queued) { queued = true; requestAnimationFrame(look); }
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', hide);
  addEventListener('scroll', hide, { passive: true, capture: true });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  document.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-unit-set]');
    if (!b) return;
    wanted = b.dataset['unitSet'] as Unit;
    try { localStorage.setItem(KEY, wanted); } catch { /* storage blocked */ }
    changed();
  });
  addEventListener('storage', (e) => { if (e.key === KEY) { wanted = e.newValue === 'USD' ? 'USD' : 'GNOT'; changed(); } });
  buttons();

  const text = (gnot: number | null, kind: Kind) => display(gnot, kind, unit(), rate);
  return {
    unit, text,
    /** Attributes for a cell that holds the figure. `fixed`: the cell shows something else, so the tooltip is always dollars. */
    attrs: (gnot: number | null, kind: Kind, past = false, fixed = false): string => (gnot === null || !Number.isFinite(gnot) ? '' : ` data-gnot="${gnot}" data-kind="${kind}"${past ? ' data-past' : ''}${fixed ? ' data-fixed' : ''}`),
    /** Writes a figure into an element. With `fixed` the text never changes unit, only the tooltip is added. */
    set(el: HTMLElement, gnot: number | null, kind: Kind, fixed?: string): void {
      el.textContent = fixed ?? text(gnot, kind);
      if (gnot === null || !Number.isFinite(gnot)) { delete el.dataset['gnot']; return; }
      el.dataset['gnot'] = String(gnot); el.dataset['kind'] = kind;
      if (fixed !== undefined) el.dataset['fixed'] = '';
    },
    setRate(r: number | null): void { if (r === rate) return; rate = r; changed(); },
    watch(f: () => void): void { watchers.add(f); },
  };
}
export type Money = ReturnType<typeof createMoney>;

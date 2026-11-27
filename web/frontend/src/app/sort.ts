/** Tables sorted by their headers. A header opts in with `data-sort="key"`, and `data-first="asc"` when it reads best rising (names, ages). */
export interface Sort { key: string | null; desc: boolean }
export type Keys<T> = Record<string, (row: T) => number | string | null>;

/**
 * Sorts a copy of `list` by the chosen column, keeping the given order among equals.
 * Missing values go last whichever the direction: they are unknown, not small.
 */
export function sortBy<T>(list: readonly T[], s: Sort, keys: Keys<T>): T[] {
  const get = s.key ? keys[s.key] : undefined;
  if (!get) return [...list];
  const v = list.map((r, i) => ({ r, i, k: get(r) }));
  const known = (k: number | string | null) => k !== null && !(typeof k === 'number' && Number.isNaN(k));
  v.sort((a, b) => {
    const x = known(a.k), y = known(b.k);
    if (!x || !y) return Number(y) - Number(x) || a.i - b.i;
    const c = typeof a.k === 'string' || typeof b.k === 'string' ? String(a.k).localeCompare(String(b.k), 'en', { sensitivity: 'base', numeric: true }) : (a.k as number) - (b.k as number);
    return (s.desc ? -c : c) || a.i - b.i;
  });
  return v.map((x) => x.r);
}

/**
 * Turns the `data-sort` headers of `table` into buttons. A click picks the column in its natural direction,
 * the next one flips it, and the third goes back to the table's own order.
 */
export function sortable(table: Element, onChange: (s: Sort) => void): Sort {
  const s: Sort = { key: null, desc: true };
  const heads = [...table.querySelectorAll<HTMLElement>('th[data-sort]')];
  for (const th of heads) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sort'; b.append(...th.childNodes); th.append(b);
    b.addEventListener('click', () => {
      const key = th.dataset['sort']!, first = th.dataset['first'] !== 'asc';
      if (s.key !== key) { s.key = key; s.desc = first; }
      else if (s.desc === first) s.desc = !first;
      else s.key = null;
      for (const h of heads) {
        if (s.key && h.dataset['sort'] === s.key) h.setAttribute('aria-sort', s.desc ? 'descending' : 'ascending'); else h.removeAttribute('aria-sort');
      }
      onChange(s);
    });
  }
  return s;
}

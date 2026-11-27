import { NETWORK } from '../core/config.ts';
import type { Engine } from '../core/engine.ts';
import { InputError } from '../core/paths.ts';
import type { Activity, Snapshot } from '../core/overview.ts';

/** One snapshot per chain: a list from one must never be painted on the other. */
const KEY = `dexvision:snapshot:v3:${NETWORK.chainId}`, POLL = 20_000, FULL = 300_000, ACTIVITY = 60_000;
export interface FeedState { fatal: boolean; snap: Snapshot | null; activity: Activity | null; stale: boolean; error: string | null; moved: ReadonlySet<string> }

const pack = (s: Snapshot) => JSON.stringify({ ...s, unavailable: [], tokens: [...s.tokens], supply: [...s.supply], created: [...s.created] });
function unpack(t: string): Snapshot | null {
  try {
    const j = JSON.parse(t);
    if (!Array.isArray(j.markets) || Date.now() - j.at > 864e5) return null;
    return { ...j, tokens: new Map(j.tokens), supply: new Map(j.supply), created: new Map(j.created) };
  } catch { return null; }
}

/**
 * Keeps the list current without hammering a public node: shows the last snapshot at once, then
 * polls one cheap question ("who traded?") and re-reads only those markets. A full read every 5 min
 * catches liquidity changes and new markets.
 */
export function createFeed(engine: Engine, onChange: (s: FeedState) => void, opts: { scope?: string; span?: number } = {}) {
  const { scope } = opts, key = scope ? `${KEY}:${scope}` : KEY;
  const st: FeedState = { fatal: false, snap: null, activity: null, stale: true, error: null, moved: new Set() };
  let span = opts.span ?? 864e5, seen = 0, fullAt = 0, activityAt = 0, busy = false, again = false, timer = 0, fails = 0;
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('dexvision:snapshot:v2')) localStorage.removeItem(k); // shared by both chains
    const t = localStorage.getItem(key); st.snap = t ? unpack(t) : null;
  } catch { /* storage blocked */ }
  const emit = () => onChange({ ...st });
  const keep = `activity:v2:${scope ?? 'all'}`; // v2: trades carry their transaction and signer
  // last visit's trades, so the page is whole before the chain answers
  const was = engine.indexer.recall<Activity>(keep).then((a) => { if (a && a.span >= span && st.snap && !st.activity) { st.activity = a; emit(); } }, () => undefined);

  async function step(): Promise<void> {
    const now = Date.now();
    st.moved = new Set();
    if (!st.snap || st.stale || now - fullAt > FULL) {
      st.snap = await engine.snapshot(undefined, undefined, scope);
      fullAt = now; seen = st.snap.height; st.stale = false; st.error = null; emit();
      st.activity = await engine.activity(st.snap, span); activityAt = Date.now(); emit();
      void engine.indexer.note(keep, st.activity);
      try { localStorage.setItem(key, pack(st.snap)); } catch { /* storage blocked or full */ }
      return;
    }
    const t = await engine.touched(seen);
    seen = t.height; st.error = null;
    const mine = new Set(st.snap.markets.map((m) => m.key)), hits = new Set([...t.keys].filter((k) => !scope || mine.has(k)));
    if (hits.size) st.snap = await engine.snapshot(st.snap, hits, scope);
    if (hits.size || span > (st.activity?.span ?? 0) || now - activityAt > ACTIVITY * 5) {
      st.activity = await engine.activity({ ...st.snap, height: seen }, span); activityAt = Date.now();
    }
    st.moved = hits;
    emit();
  }
  async function run(): Promise<void> {
    if (busy) { again = true; return; }
    busy = true; clearTimeout(timer);
    try { await step(); fails = 0; }
    catch (e) {
      fails++;
      if (e instanceof InputError) { st.fatal = true; st.error = e.message; st.snap = null; busy = false; emit(); return; } // asking again will not help
      st.error = e instanceof Error ? e.message : String(e); emit();
    }
    busy = false;
    if (again) { again = false; return run(); }
    if (!document.hidden) timer = window.setTimeout(run, Math.min(POLL * 2 ** Math.min(fails, 4), 240_000));
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else if (!st.fatal) void run(); });
  if (st.snap) emit();
  void Promise.race([was, new Promise((r) => setTimeout(r, 600))]).then(run);
  return { /** Checks now instead of at the next poll. */ poke() { void run(); },
    /** Makes sure activity covers at least this long. */ cover(ms: number) { if (ms > span) { span = ms; void run(); } } };
}

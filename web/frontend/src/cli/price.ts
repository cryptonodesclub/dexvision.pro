/** npm run price -- <realm> [--candles 1h --range 7d] */
import { createEngine } from '../core/engine.ts';

const args = process.argv.slice(2), realm = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const flag = (n: string) => { const i = args.indexOf('--' + n); return i < 0 ? undefined : args[i + 1]; };
const ms = (s: string) => { const m = /^(\d+)(m|h|d)$/.exec(s); if (!m) throw new Error(`bad duration "${s}"`); return +m[1]! * { m: 6e4, h: 36e5, d: 864e5 }[m[2] as 'm' | 'h' | 'd']; };
if (!realm) { console.error('usage: npm run price -- <realm> [--candles 1h --range 7d]'); process.exit(2); }

try {
  const engine = createEngine(), t0 = performance.now();
  const res = await engine.prices(realm);
  for (const p of res.tokens) {
    console.log(`\n${p.token.symbol}  ${p.token.path}  (${p.token.decimals} decimals)`);
    console.log(p.priceGnot === null ? '  no priced route to GNOT' : `  ${p.priceGnot.toPrecision(8)} GNOT` + (p.depthGnot === null ? '' : `   depth ${p.depthGnot.toFixed(2)} GNOT`));
    for (const q of p.markets) console.log(`  ${q.active ? ' ' : 'x'} ${q.venue.padEnd(9)} ${q.feePct.toFixed(2)}%  ${q.pairedWith.split('.').pop()!.padEnd(8)} ${(q.priceGnot?.toPrecision(8) ?? 'n/a').padStart(14)} GNOT   depth ${q.depthGnot?.toFixed(2) ?? 'n/a'}${q.stage ? '   ' + q.stage : ''}`);
    const iv = flag('candles');
    if (iv && p.route.length) {
      const h = await engine.history(p.token.path, { interval: ms(iv), from: Date.now() - ms(flag('range') ?? '7d') });
      console.log(`  candles ${iv} in ${h.quote.split('.').pop()}, ${h.trades} trades, ${h.venue}`);
      for (const c of h.candles.slice(-12)) console.log('   ', new Date(c.t).toISOString().slice(0, 16), ...[c.o, c.h, c.l, c.c].map((x) => x.toPrecision(8)), 'vol', c.vol.toFixed(4), 'n', c.swaps);
    }
  }
  for (const u of res.unavailable) console.log(`  ! could not read ${u.source}: ${u.reason.slice(0, 140)}`);
  console.log(`\n${((performance.now() - t0) / 1000).toFixed(1)} s`);
} catch (e) { console.error(String(e instanceof Error ? `${e.name}: ${e.message}` : e)); process.exit(1); }

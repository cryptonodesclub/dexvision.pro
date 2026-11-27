import { NETWORK, WUGNOT } from '../core/config.ts';
import type { Engine, Token } from '../core/engine.ts';
import type { MarketRow } from '../core/overview.ts';
import { InputError } from '../core/paths.ts';
import { PAD } from '../core/trade/gnomi.ts';
import { createTrader, costOf, explain, formatAmount, minOut, parseAmount, planUnwrap, UNWRAP_GAS, withUnwrap, type Balances, type Desk, type Gas, type Order, type Quote } from '../core/trade/trade.ts';
import type { Call } from '../core/trade/proto.ts';
import type { Simulated } from '../core/trade/proto.ts';
import { symbolOf } from './links.ts';
import type { Money } from './money.ts';
import { WalletError, type Wallet, type WalletState } from './wallet.ts';
import { shortAddress } from './walletbutton.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const PREF = 'dexvision:unwrap', WORTH = 20_000n; // less wugnot than this does not pay its own conversion
const WARN = 0.05, CONSENT = 0.15, REFUSE = 0.5;
const asGnot = (ugnot: number) => formatAmount(BigInt(Math.max(0, Math.round(ugnot))), 6, 3);

/** The trade panel. One market, the one selected on the page: no routing, no surprises. */
export function createPanel(engine: Engine, w: Wallet, money: Money, path: string, done: () => void) {
  const trader = createTrader(engine);
  let market: MarketRow | null = null, tok: Record<string, Token> = {}, side: 'buy' | 'sell' = 'buy', slippage = 100;
  let wallet: WalletState = { installed: false, address: null, chainId: null }, bal: Balances | null = null;
  let order: Order | null = null, quote: Quote | null = null, sim: Simulated | null = null, credit = 0n, problem = '', busy = '', note = '', bad = false, turn = 0, timer = 0;

  const input = $<HTMLInputElement>('t-in'), agree = $<HTMLInputElement>('t-agree'), native = $<HTMLInputElement>('t-native');
  native.checked = true;
  try { native.checked = localStorage.getItem(PREF) !== '0'; } catch { /* storage blocked */ }
  const poolId = () => market!.key.slice(market!.key.indexOf('|') + 1);
  const desk = (): Desk | null => {
    if (!market?.active) return null;
    if (market.key.startsWith('gnoswap|')) return trader.desks.gnoswap;
    return market.key.startsWith(`gnomi|${PAD}:`) && market.stage === 'curve' ? trader.desks.gnomi : null;
  };
  const paid = () => (side === 'buy' ? market!.pairedWith : path), got = () => (side === 'buy' ? path : market!.pairedWith);
  /** Paying with the GNOT pair can use plain GNOT too, wrapped on the way in. */
  const funds = (): bigint | null => (!bal ? null : paid() === WUGNOT ? bal.wrapped + (bal.gnot > keep() ? bal.gnot - keep() : 0n) : (bal.tokens.get(paid()) ?? 0n));
  const keep = () => desk()?.keep ?? 0n;
  /** Selling for wugnot, and asked to end up with plain GNOT. */
  const unwraps = () => got() === WUGNOT && native.checked;
  const gotName = () => (got() === WUGNOT ? (unwraps() ? 'GNOT' : 'wGNOT') : symbolOf(got()));
  const cost = () => {
    if (!quote || !market || !tok[paid()]) return null;
    return costOf(quote, side === 'buy' ? 1 / market.price : market.price, tok[paid()]!.decimals, tok[got()]!.decimals);
  };


  async function refresh(): Promise<void> {
    if (wallet.address && market) {
      const who = wallet.address, b = await trader.balances(who, [...new Set([path, market.pairedWith])].filter((p) => p !== WUGNOT)).catch(() => null);
      const c = await desk()?.credit?.(who).catch(() => 0n);
      if (who === wallet.address) { bal = b; credit = c ?? 0n; }
    }
    ask(0);
  }

  /** Re-quotes, then dry-runs the real transaction if there is a funded wallet to run it from. */
  function ask(delay = 320): void {
    clearTimeout(timer); turn++; quote = null; sim = null; problem = '';
    const mine = turn;
    const d = desk();
    if (!d || !tok[paid()] || !tok[got()]) { order = null; return draw(); }
    const raw = parseAmount(input.value, tok[paid()]!.decimals);
    if (!raw) { order = null; if (input.value.trim()) problem = raw === null ? (tok[paid()]!.decimals ? `Enter a number with up to ${tok[paid()]!.decimals} decimals.` : 'Enter a whole number.') : ''; return draw(); }
    const [token0, token1] = [path, market!.pairedWith].sort() as [string, string];
    const o: Order = order = { pool: { id: poolId(), token0, token1 }, input: paid(), output: got(), amountIn: raw };
    draw();
    timer = window.setTimeout(async () => {
      try {
        const q = await d.quote(o);
        if (mine !== turn) return;
        quote = q; draw();
        if (ready() && !short()) {
          const s = await trader.simulate((await build(d, o, q)).calls, d.gas);
          if (mine !== turn) return;
          sim = s; if (!s.ok) problem = explain(s.error);
        }
      } catch (e) { if (mine !== turn) return; problem = e instanceof InputError ? e.message : 'The quote could not be read. Try again.'; }
      draw();
    }, delay);
  }
  const ready = () => !!wallet.address && wallet.chainId === NETWORK.chainId && !!bal;
  const short = () => { const f = funds(); return f !== null && !!order && order.amountIn > f; };
  async function build(d: Desk, o: Order, q: Quote) {
    const caller = wallet.address!, min = minOut(q.amountOut, slippage), p = await d.build(o, { caller, min, wrapped: bal!.wrapped });
    return native.checked ? withUnwrap(p, o, caller, min) : p;
  }
  const unsure = 'Sent. Adena did not confirm the result, so check your balance before trying again.';

  /** One-off actions that are not trades: dry-run, sign, report. */
  async function act(label: string, ok: string, gas: Gas, make: () => Promise<Call[]>): Promise<void> {
    if (!ready() || busy) return;
    note = ''; bad = false;
    try {
      busy = label; draw();
      const calls = await make(), s = await trader.simulate(calls, gas);
      if (!s.ok) throw new InputError(explain(s.error));
      busy = 'Confirm in Adena'; draw();
      const r = await w.send(calls, gas);
      if (r.state === 'failed') throw new InputError(`${explain(r.reason)} The network fee was charged.`);
      note = r.state === 'done' ? ok : unsure;
      setTimeout(() => void refresh(), 4000);
    } catch (e) { bad = true; note = e instanceof InputError || e instanceof WalletError ? e.message : 'Something went wrong before anything was sent. Try again.'; }
    finally { busy = ''; draw(); }
  }
  /** Takes out money a market is holding for this account. */
  function claim(): void {
    const d = desk();
    if (d?.claim) void act('Checking the claim', 'Claimed. The wGNOT is in your wallet.', d.gas, async () => d.claim!(wallet.address!));
  }
  /** Turns all the wugnot this account holds back into GNOT. */
  function convert(): void {
    void act('Checking the conversion', 'Converted. The GNOT is in your wallet.', UNWRAP_GAS, async () => {
      const who = wallet.address!;
      return planUnwrap(who, (await trader.balances(who, [])).wrapped); // what is there now, not what was shown
    });
  }

  async function submit(): Promise<void> {
    note = ''; bad = false;
    try {
      if (!wallet.installed) return;
      if (!wallet.address) { busy = 'Connecting'; draw(); await w.connect(); return; }
      if (wallet.chainId !== NETWORK.chainId) { busy = 'Changing network'; draw(); await w.useNetwork(); return; }
      const d = desk();
      if (!order || !quote || !d) return;
      const o = order, shown = minOut(quote.amountOut, slippage), mine = turn;
      busy = 'Checking the trade'; draw();
      const q = await d.quote(o);
      if (mine !== turn) return;
      if (q.amountOut < shown) { quote = q; throw new InputError('The price moved while you decided. Check the new quote and confirm again.'); }
      // keep the minimum the person saw, not a looser one from the new quote
      const p = await build(d, o, { ...q, amountOut: quote.amountOut }), s = await trader.simulate(p.calls, d.gas);
      if (mine !== turn) return;
      sim = s;
      if (!s.ok) throw new InputError(explain(s.error));
      busy = 'Confirm in Adena'; draw();
      const r = await w.send(p.calls, d.gas);
      if (r.state === 'failed') throw new InputError(`${explain(r.reason)} The network fee was charged.`);
      note = r.state === 'done' ? `${side === 'buy' ? 'Bought' : 'Sold'} ${tok[path]!.symbol}. Transaction ${r.hash.slice(0, 10)}…` : unsure;
      input.value = ''; agree.checked = false; done();
      setTimeout(() => void refresh(), 4000);
    } catch (e) { bad = true; note = e instanceof InputError || e instanceof WalletError ? e.message : 'Something went wrong before anything was sent. Try again.'; }
    finally { busy = ''; if (order && !input.value) ask(0); else draw(); }
  }

  function draw(): void {
    const d = desk();
    $('t-form').hidden = !d; $('trade-soon').hidden = !!d;
    if (!market) return;
    if (!d) { $('trade-soon').textContent = !market.active ? 'This market is not active, so it cannot be traded.' : market.stage === 'graduated' ? 'This launch has graduated. Trading it from here is not available yet.' : `This pair trades on an older ${market.venue}, which cannot be traded from here.`; return; }
    const pay = tok[paid()], get = tok[got()], f = funds(), c = cost(), min = quote && minOut(quote.amountOut, slippage), gnotPay = paid() === WUGNOT;
    document.querySelectorAll<HTMLElement>('[data-side]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset['side'] === side)));
    document.querySelectorAll<HTMLElement>('[data-slip]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset['slip']! === slippage)));
    $('t-pay').textContent = gnotPay ? 'GNOT' : symbolOf(paid());
    $('t-bal').textContent = f === null || !pay ? '' : `Available ${formatAmount(f, pay.decimals, 4)}`;
    $('t-lock').hidden = !(gnotPay && bal && bal.locked > 0n); if (bal) $('t-lock').textContent = `${formatAmount(bal.locked, 6, 2)} GNOT of yours are locked by vesting.`;
    $('t-max').hidden = !f;
    $('t-get').textContent = gotName();
    $('t-out').textContent = quote && get ? formatAmount(quote.amountOut, get.decimals, 6) : order && !problem ? '…' : '0';
    $('t-min').textContent = min && get ? `${formatAmount(min, get.decimals, 6)} ${gotName()}` : '–';
    const loss = $('t-loss'); loss.textContent = c === null ? '–' : `${(c * 100).toFixed(2)}%`; loss.className = c !== null && c >= WARN ? 'alarm' : '';
    money.set($('t-net'), d.gas.fee / 1e6, 'amount', `${asGnot(d.gas.fee)} GNOT`);
    money.set($('t-dep'), sim?.ok ? Math.max(0, sim.deposit) / 1e6 : null, 'amount', sim?.ok ? `${asGnot(sim.deposit)} GNOT` : d.depositHint);
    const due = order && order.amountIn > credit ? order.amountIn - credit : 0n, wrap = gnotPay && bal && due > bal.wrapped ? due - bal.wrapped : 0n;
    $('t-credit').hidden = credit <= 0n; $('t-credit-text').textContent = `The pad holds ${formatAmount(credit, 6, 6)} wGNOT of yours. It pays for your next buy first.`;
    $('t-wrap').hidden = !(wrap > 0n); $('t-wrap').textContent = wrap > 0n ? `Wraps ${formatAmount(wrap, 6, 6)} GNOT into wGNOT first.` : '';
    $('t-native-row').hidden = got() !== WUGNOT; native.disabled = busy !== '';
    $('t-keep').hidden = got() !== WUGNOT;
    $('t-keep').textContent = !unwraps() ? 'You receive wGNOT, the wrapped GNOT this market pays in.' : min && get ? `${formatAmount(min, get.decimals, 6)} arrives as GNOT. Anything above that stays as wGNOT and pays for your next buy.` : 'The guaranteed amount arrives as GNOT. Anything above it stays as wGNOT.';
    $('t-held').hidden = !bal || bal.wrapped < WORTH; if (bal) $('t-held-text').textContent = `You hold ${formatAmount(bal.wrapped, 6, 4)} wGNOT.`;
    $<HTMLButtonElement>('t-convert').disabled = $<HTMLButtonElement>('t-claim').disabled = busy !== '' || !ready();

    const severe = c !== null && c >= REFUSE, heavy = c !== null && c >= CONSENT && !severe;
    $('t-consent').hidden = !heavy;
    if (heavy) $('t-consent-text').textContent = `I accept losing about ${(c! * 100).toFixed(0)}% against the current price.`;

    let label = `${side === 'buy' ? 'Buy' : 'Sell'} ${tok[path]?.symbol ?? ''}`, off = true, why = problem;
    if (busy) label = busy;
    else if (!wallet.installed) label = 'Adena not found';
    else if (!wallet.address) { label = 'Connect Adena'; off = false; }
    else if (wallet.chainId !== NETWORK.chainId) { label = `Switch to ${NETWORK.chainId}`; off = false; }
    else if (!order) label = 'Enter an amount';
    else if (short()) { label = `Not enough ${gnotPay ? 'GNOT' : symbolOf(paid())}`; if (gnotPay) why = `${asGnot(Number(keep()))} GNOT are kept aside for the network fee and storage deposit.`; }
    else if (severe) why = `This market is too small: you would lose about ${(c! * 100).toFixed(0)}%. Try a smaller amount.`;
    else if (heavy && !agree.checked) why = '';
    else if (!problem && quote && sim?.ok) off = false;
    else if (!problem) label = quote ? 'Checking the trade' : 'Getting a quote';
    const go = $<HTMLButtonElement>('t-go'); go.textContent = label; go.disabled = off;
    $('t-install').hidden = wallet.installed;
    $('t-addr').textContent = wallet.address ? `Signing with ${shortAddress(wallet.address)}` : '';
    const msg = $('t-msg'); msg.textContent = note || why; msg.toggleAttribute('data-bad', note ? bad : !!why);
  }

  $('trade').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-side],[data-slip],#t-max,#t-claim,#t-convert');
    if (!b || busy) return;
    note = '';
    if (b.id === 't-claim') return claim();
    if (b.id === 't-convert') return convert();
    if (b.dataset['side']) { side = b.dataset['side'] as 'buy' | 'sell'; input.value = ''; agree.checked = false; ask(0); }
    else if (b.dataset['slip']) { slippage = +b.dataset['slip']; ask(0); }
    else { const f = funds(); if (f && tok[paid()]) { input.value = formatAmount(f, tok[paid()]!.decimals).replaceAll(',', ''); ask(0); } }
  });
  input.addEventListener('input', () => { if (busy) return; note = ''; agree.checked = false; ask(); });
  agree.addEventListener('change', draw);
  native.addEventListener('change', () => { try { localStorage.setItem(PREF, native.checked ? '1' : '0'); } catch { /* storage blocked */ } note = ''; ask(0); });
  $('t-form').addEventListener('submit', (e) => { e.preventDefault(); if (!busy && !$<HTMLButtonElement>('t-go').disabled) void submit(); });
  // quotes age: refresh one that has been on screen for a while
  setInterval(() => { if (!document.hidden && !busy && order && !agree.checked) ask(0); }, 20_000);

  w.watch((s) => {
    const moved = s.address !== wallet.address || s.chainId !== wallet.chainId;
    wallet = s;
    if (moved) { bal = null; credit = 0n; void refresh(); } else draw();
  });

  return {
    async setMarket(m: MarketRow): Promise<void> {
      const same = market?.key === m.key;
      market = m;
      if (same) return draw();
      input.value = ''; note = ''; order = null; quote = null; sim = null; credit = 0n; agree.checked = false;
      draw();
      try { const [a, b] = await Promise.all([engine.token(path), engine.token(m.pairedWith)]); tok = { ...tok, [a.path]: a, [b.path]: b }; } catch { problem = 'This pair could not be read.'; }
      await refresh();
    },
  };
}

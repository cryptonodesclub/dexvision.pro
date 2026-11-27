import { NETWORK, WUGNOT } from '../config.ts';
import type { Engine } from '../engine.ts';
import { assertPoolPath, InputError, splitTokenPath } from '../paths.ts';
import { gnomiDesk, GNOMI_GAS, planClaim, planGnomi } from './gnomi.ts';
import { decodeResult, encodeTx, type Call, type Simulated } from './proto.ts';

const ROUTER = 'gno.land/r/gnoswap/router', REGISTRY = 'gno.land/r/nt/grc20reg/v0';
/** Address of the router realm: the spender that swaps pull tokens through. Seen in every mainnet swap. */
export const ROUTER_ADDRESS = 'g1vc883gshu5z7ytk5cdynhc8c2dh67pdp4cszkp';
export const WUGNOT_REALM = 'gno.land/r/gnoland/wugnot', MIN_WRAP = 1000n;

/** Swaps of one pool use 165M to 181M gas; the margin covers crossing more ticks. Fee is 1 ugnot per 1000 gas. */
export interface Gas { wanted: number; fee: number }
export const SWAP_GAS: Gas = { wanted: 230_000_000, fee: 230_000 };
/** No single step may lock more than this as storage deposit. The most a real swap has needed is 2.8 GNOT. */
export const MAX_DEPOSIT = 5_000_000;
export const DEADLINE_S = 600;
export const INT64 = 2n ** 63n - 1n;

export const isAddress = (s: string) => /^g1[02-9ac-hj-np-z]{38}$/.test(s);

/** Exact decimal text to raw units. Never goes through a float. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const m = /^(\d*)(?:[.,](\d*))?$/.exec(text.trim());
  if (!m || !(m[1] || m[2])) return null;
  const frac = m[2] ?? '';
  if (frac.replace(/0+$/, '').length > decimals) return null; // would silently lose value
  const raw = BigInt((m[1] || '0') + frac.slice(0, decimals).padEnd(decimals, '0'));
  return raw <= INT64 ? raw : null;
}
export function formatAmount(raw: bigint, decimals: number, places = decimals): string {
  const s = raw.toString().padStart(decimals + 1, '0'), whole = s.slice(0, s.length - decimals), frac = decimals ? s.slice(-decimals).slice(0, places).replace(/0+$/, '') : '';
  return whole.replace(/\B(?=(\d{3})+$)/g, ',') + (frac ? '.' + frac : '');
}
export const minOut = (out: bigint, slippageBps: number): bigint => { const m = (out * BigInt(10_000 - slippageBps)) / 10_000n; return m > 0n ? m : 1n; };

export interface Pool { id: string; token0: string; token1: string }
export interface Order { pool: Pool; input: string; output: string; amountIn: bigint }
/** The route is exactly this pool, in the direction of the trade. */
export function routeOf(o: Order): string {
  const [a, b, fee] = assertPoolPath(o.pool.id).split(':') as [string, string, string];
  const forward = o.input === a && o.output === b;
  if (!forward && !(o.input === b && o.output === a)) throw new InputError('The tokens do not belong to this pool.');
  return `${o.input}:${o.output}:${fee}`;
}

export interface Quote { amountIn: bigint; amountOut: bigint }
/** Share lost against the pool's spot price, fees included. Negative would mean better than spot. */
export function costOf(q: Quote, spot: number, decIn: number, decOut: number): number {
  const fair = (Number(q.amountIn) / 10 ** decIn) * spot;
  return fair > 0 ? 1 - Number(q.amountOut) / 10 ** decOut / fair : 0;
}

export type ApproveStyle = 'plain' | 'symbol' | null;
/** How a token realm wants to be approved, read from its published signature. Anything unfamiliar is refused. */
export function approveStyle(funcs: readonly { FuncName: string; Params?: readonly { Name: string; Type: string }[] | null }[]): ApproveStyle {
  const p = funcs.find((f) => f.FuncName === 'Approve')?.Params ?? [], is = (i: number, name: string, ...types: string[]) => p[i]?.Name === name && types.includes(p[i]!.Type);
  const spender = (i: number) => is(i, 'spender', 'string', '.uverse.address', 'address');
  if (p[0]?.Name !== 'cur') return null;
  if (p.length === 3 && spender(1) && is(2, 'amount', 'int64')) return 'plain';
  if (p.length === 4 && is(1, 'symbol', 'string') && spender(2) && is(3, 'amount', 'int64')) return 'symbol';
  return null;
}

export interface Plan { calls: Call[]; wrap: bigint }
/** Approve exactly this amount, wrap only the GNOT that is missing, swap in this pool. */
export function plan(o: Order, p: { caller: string; min: bigint; deadline: number; style: Exclude<ApproveStyle, null>; wrapped: bigint }): Plan {
  if (!isAddress(p.caller)) throw new InputError('That is not a gno.land address.');
  if (o.amountIn <= 0n || o.amountIn > INT64 || p.min <= 0n || p.min > INT64) throw new InputError('The amount is out of range.');
  const { realm, symbol } = splitTokenPath(o.input), route = routeOf(o);
  const call = (pkg_path: string, func: string, args: string[], send = ''): Call => ({ caller: p.caller, send, max_deposit: `${MAX_DEPOSIT}ugnot`, pkg_path, func, args });
  const missing = o.input === WUGNOT && o.amountIn > p.wrapped ? o.amountIn - p.wrapped : 0n, wrap = missing > 0n && missing < MIN_WRAP ? MIN_WRAP : missing;
  const calls = [call(realm, 'Approve', [...(p.style === 'symbol' ? [symbol] : []), ROUTER_ADDRESS, o.amountIn.toString()])];
  if (wrap > 0n) calls.push(call(WUGNOT_REALM, 'Deposit', [], `${wrap}ugnot`));
  calls.push(call(ROUTER, 'ExactInSwapRoute', [o.input, o.output, o.amountIn.toString(), route, '100', p.min.toString(), String(p.deadline), '']));
  return { calls, wrap };
}

/** Turning wugnot back into GNOT takes about 12M gas. */
export const UNWRAP_GAS: Gas = { wanted: 20_000_000, fee: 20_000 };
export function planUnwrap(caller: string, amount: bigint): Call[] {
  if (!isAddress(caller)) throw new InputError('That is not a gno.land address.');
  if (amount <= 0n || amount > INT64) throw new InputError('There is no wGNOT to convert.');
  return [{ caller, send: '', max_deposit: `${MAX_DEPOSIT}ugnot`, pkg_path: WUGNOT_REALM, func: 'Withdraw', args: [amount.toString()] }];
}
/**
 * Ends a sale in GNOT. It converts the guaranteed minimum, never the quote: the amount is fixed before the
 * trade runs, and asking for one unit more than arrives would undo the whole sale.
 */
export function withUnwrap(p: Plan, o: Order, caller: string, min: bigint): Plan {
  return o.output === WUGNOT ? { ...p, calls: [...p.calls, ...planUnwrap(caller, min)] } : p;
}

/** Turns a contract error into something a person can act on. */
export function explain(error: string): string {
  const e = error.toLowerCase();
  if (e.includes('vesting locked') || e.includes('lockstoragedeposit failed')) return 'Your GNOT cannot cover the storage deposit. Part of your balance may be locked by vesting.';
  if (e.includes('not enough deposit')) return 'This trade needs a larger storage deposit than this page allows.';
  if (e.includes('router-001') || e.includes('slippage') || e.includes('too few received')) return 'The price moved past your slippage limit. Get a new quote.';
  if (e.includes('anti-snipe')) return 'This launch is minutes old and limits how much one account can buy. Try a smaller amount or wait.';
  if (e.includes('not on curve') || e.includes('raise filled') || e.includes('sold out') || e.includes('fill capacity')) return 'This launch has just completed. It no longer trades on its curve.';
  if (e.includes('zero tokens out') || e.includes('zero ugnot out') || e.includes('fee consumes')) return 'That amount is too small to trade.';
  if (e.includes('more wugnot to pad')) return 'The pad did not see the payment, so nothing was spent. Try again.';
  if (e.includes('router-003') || e.includes('expired')) return 'The order expired before it was executed. Try again.';
  if (e.includes('insufficient balance') || e.includes('insufficient token balance') || e.includes('insufficient funds') || e.includes('insufficientcoins') || e.includes('insufficient coins')) return 'Your balance is too low for this trade and its network costs.';
  if (e.includes('allowance')) return 'The token did not accept the approval.';
  if (e.includes('liquidity') || e.includes('partial fill')) return 'The pool does not have enough liquidity for this amount.';
  if (e.includes('halt')) return 'Gnoswap is halted right now.';
  if (e.includes('out of gas')) return 'The trade needs more gas than this page allows.';
  return `The chain rejected the trade: ${error.replace(/\s+/g, ' ').slice(0, 160)}`;
}

/** Coins still locked by a vesting schedule that releases evenly between two moments. */
export function lockedCoins(v: { original_vesting?: string; start_time?: string; end_time?: string } | undefined, nowS: number): bigint {
  const total = BigInt(/^(\d+)ugnot$/.exec(v?.original_vesting ?? '')?.[1] ?? 0), start = BigInt(v?.start_time ?? 0), end = BigInt(v?.end_time ?? 0), now = BigInt(Math.floor(nowS));
  if (!total || now >= end) return 0n;
  return now <= start ? total : (total * (end - now)) / (end - start);
}

/** `gnot` is what can be spent; `locked` is held by vesting. */
export interface Balances { gnot: bigint; locked: bigint; wrapped: bigint; tokens: Map<string, bigint> }

/** One place to trade: what it costs, how it is quoted and which calls it takes. */
export interface Desk {
  gas: Gas;
  keep: bigint;        // ugnot left out of "Max" for the network fee and storage deposit
  depositHint: string; // shown until a dry run gives the real figure
  quote(o: Order): Promise<Quote>;
  build(o: Order, p: { caller: string; min: bigint; wrapped: bigint }): Promise<Plan>;
  /** Money of this account held by the market itself, and how to take it out. */
  credit?(address: string): Promise<bigint>;
  claim?(address: string): Call[];
}

export function createTrader(engine: Engine) {
  const { rpc, indexer } = engine, gnomi = gnomiDesk(rpc), styles = new Map<string, Promise<ApproveStyle>>();

  /** Dry run of this exact pool by the router itself, so it includes both fees. */
  async function quote(o: Order): Promise<Quote> {
    const text = await rpc.query('vm/qeval', `${ROUTER}.DrySwapRoute("${o.input}","${o.output}","${o.amountIn}","EXACT_IN","${routeOf(o)}","100","1")`);
    const m = /^\("(\d+)" string\)\s+\("(\d+)" string\)\s+\(undefined\)\s*$/.exec(text.trim());
    if (!m) throw new InputError('The pool cannot fill this amount.');
    const q = { amountIn: BigInt(m[1]!), amountOut: BigInt(m[2]!) };
    if (q.amountIn !== o.amountIn || q.amountOut <= 0n) throw new InputError('The pool cannot fill this amount.');
    return q;
  }
  function style(path: string): Promise<ApproveStyle> {
    const { realm } = splitTokenPath(path);
    let s = styles.get(realm);
    if (!s) { styles.set(realm, s = rpc.query('vm/qfuncs', realm).then((t) => approveStyle(JSON.parse(t)))); s.catch(() => styles.delete(realm)); }
    return s;
  }
  async function balances(address: string, paths: readonly string[]): Promise<Balances> {
    if (!isAddress(address)) throw new InputError('That is not a gno.land address.');
    const raw = (path: string) => { splitTokenPath(path); return rpc.evalInt(`${REGISTRY}.Get("${path}").BalanceOf("${address}")`); };
    const [coins, account, wrapped, ...rest] = await Promise.all([rpc.query(`bank/balances/${address}`, '').catch(() => ''), rpc.query(`auth/accounts/${address}`, '').catch(() => '{}'), raw(WUGNOT), ...paths.map(raw)]);
    const total = BigInt(/(?:^|[",])(\d+)ugnot/.exec(coins)?.[1] ?? 0), vest = (JSON.parse(account) as { BaseAccount?: { vesting?: Record<string, string> } } | null)?.BaseAccount?.vesting;
    const held = lockedCoins(vest, Date.now() / 1000), locked = held < total ? held : total;
    return { gnot: total - locked, locked, wrapped, tokens: new Map(paths.map((p, i) => [p, rest[i]!])) };
  }
  /** Seconds, on the chain's clock: the visitor's may be wrong. */
  async function deadline(): Promise<number> {
    const h = await indexer.latestHeight(), t = (await indexer.blockTimes([h])).get(h)!;
    return Math.floor(t / 1000) + DEADLINE_S;
  }
  /** Runs the exact transaction on a node without signing or sending it. */
  async function simulate(calls: readonly Call[], gas: Gas): Promise<Simulated> {
    const caller = calls[0]!.caller, acc = JSON.parse(await rpc.query(`auth/accounts/${caller}`, '')) as { BaseAccount?: { public_key?: { '@type': string; value: string } | null } };
    const key = acc.BaseAccount?.public_key, pub = key?.['@type'] === '/tm.PubKeySecp256k1' ? Uint8Array.from(atob(key.value), (c) => c.charCodeAt(0)) : undefined;
    return decodeResult(await rpc.simulate(encodeTx(calls, gas.wanted, gas.fee, pub)));
  }
  const desks: Record<'gnoswap' | 'gnomi', Desk> = {
    gnoswap: {
      gas: SWAP_GAS, keep: 4_000_000n, depositHint: 'About 1.7 GNOT', quote,
      async build(o, p) {
        const [how, by] = await Promise.all([style(o.input), deadline()]);
        if (!how) throw new InputError('This token uses an approval this page does not know, so it cannot be sold here.');
        return plan(o, { ...p, deadline: by, style: how });
      },
    },
    gnomi: {
      gas: GNOMI_GAS, keep: 1_500_000n, depositHint: 'Up to about 0.5 GNOT', quote: gnomi.quote, credit: gnomi.credit, claim: planClaim,
      async build(o, p) { return planGnomi(o, { ...p, credit: await gnomi.credit(p.caller) }); }, // read again: it decides how much is sent
    },
  };
  return { quote, style, balances, deadline, simulate, desks, chain: NETWORK };
}
export type Trader = ReturnType<typeof createTrader>;

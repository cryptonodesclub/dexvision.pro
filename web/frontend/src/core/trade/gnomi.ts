import { WUGNOT } from '../config.ts';
import { InputError, splitTokenPath } from '../paths.ts';
import { RpcError, type Rpc } from '../rpc.ts';
import { fee, parseTradeHistory, spotScaled, VT0, type Curve } from '../venues/gnomi.ts';
import type { Call } from './proto.ts';
import { INT64, isAddress, MIN_WRAP, WUGNOT_REALM, type Order, type Plan, type Quote } from './trade.ts';

/**
 * Trading on a Gnomi bonding curve. Two things about paying decide how this is written:
 *
 * 1. The pad does not record who sent it wugnot. Money sitting there unspent can be used by anyone's
 *    next buy, so the transfer and the buy always travel in one transaction, which fails as a whole.
 * 2. A buyer may already have credit inside the pad, and the pad spends that first. Sending the full
 *    amount on top would leave the difference ownerless, so only what is missing is sent.
 */
export const PAD = 'gno.land/r/g1n4pl5uc4yt5r96m9w6fmdznx3x0jyg8l6arhmt/gnomi/padv3';
/** Derived from the realm path (a test checks it). Never taken from a node: money is sent here. */
export const PAD_ADDRESS = 'g1ukml3j2pp5wmn2u6m7rzeamtp58r0r7f7d9eym';
/** Curve trades use 38M to 48M gas. */
export const GNOMI_GAS = { wanted: 80_000_000, fee: 80_000 } as const;
const CURVE_SUPPLY = 800_000_000n, MAX_DEPOSIT = '5000000ugnot';

export interface CurveState extends Curve { remaining: bigint /** ugnot still to raise before the launch completes */ }
export interface GnomiMarket { id: string; launch: string }

export function parseMarket(id: string): GnomiMarket {
  const i = id.lastIndexOf(':'), launch = id.slice(i + 1);
  if (id.slice(0, i) !== PAD || !/^[0-9a-z]{1,16}$/.test(launch)) throw new InputError('Only launches of the current Gnomi pad can be traded here.');
  return { id, launch };
}
const isBuy = (o: Order) => o.input === WUGNOT;
function check(o: Order): GnomiMarket {
  const m = parseMarket(o.pool.id), other = isBuy(o) ? o.output : o.input;
  if ((!isBuy(o) && o.output !== WUGNOT) || splitTokenPath(other).realm !== PAD) throw new InputError('The tokens do not belong to this launch.');
  return m;
}

/**
 * Reserves from LaunchInfo, whose name and URI are free text the creator controls. Counting fields from
 * the end keeps that text out of reach, and the result must reproduce the price the contract itself
 * recorded, so a forged line cannot pass.
 */
export function parseReserves(info: string, history: string): Curve {
  const f = info.split('|'), u = f.at(-9) ?? '', t = f.at(-8) ?? '';
  if (f.length < 21 || !/^\d+$/.test(u) || !/^\d+$/.test(t)) throw new RpcError('unexpected launch info');
  const c: Curve = { u: BigInt(u), t: BigInt(t), graduated: false };
  if (c.u <= 0n || c.t <= 0n || spotScaled(c) !== parseTradeHistory(history).at(-1)?.scaled) throw new RpcError('the launch reserves do not match its price');
  return c;
}

/** Exactly what the contract would do, in its own integer arithmetic. Fees included. */
export function quoteCurve(c: CurveState, buy: boolean, amountIn: bigint): Quote {
  const small = new InputError('That amount is too small to trade.');
  if (buy) {
    const f = fee(amountIn), inn = f.net + f.remainder, u = c.u + inn, out = c.t - (c.u * c.t) / u;
    if (inn <= 0n || out <= 0n) throw small;
    // the order that completes a launch is partly refunded inside the pad: leave it alone
    if (inn >= c.remaining || out >= CURVE_SUPPLY - (VT0 - c.t)) throw new InputError('This order would complete the launch. Use a smaller amount.');
    return { amountIn, amountOut: out };
  }
  const gross = c.u - (c.u * c.t) / (c.t + amountIn), out = gross > 0n ? gross - fee(gross).total : 0n;
  if (out <= 0n) throw small;
  return { amountIn, amountOut: out };
}

/** `credit`: wugnot the caller already has inside the pad. */
export function planGnomi(o: Order, p: { caller: string; min: bigint; wrapped: bigint; credit: bigint }): Plan {
  const { launch } = check(o);
  if (!isAddress(p.caller)) throw new InputError('That is not a gno.land address.');
  if (o.amountIn <= 0n || o.amountIn > INT64 || p.min <= 0n || p.min > INT64 || p.credit < 0n) throw new InputError('The amount is out of range.');
  const call = (pkg_path: string, func: string, args: string[], send = ''): Call => ({ caller: p.caller, send, max_deposit: MAX_DEPOSIT, pkg_path, func, args });
  if (!isBuy(o)) return { calls: [call(PAD, 'Sell', [launch, o.amountIn.toString(), p.min.toString()])], wrap: 0n };
  const pay = o.amountIn > p.credit ? o.amountIn - p.credit : 0n, missing = pay > p.wrapped ? pay - p.wrapped : 0n, wrap = missing > 0n && missing < MIN_WRAP ? MIN_WRAP : missing;
  const calls: Call[] = [];
  if (wrap > 0n) calls.push(call(WUGNOT_REALM, 'Deposit', [], `${wrap}ugnot`));
  if (pay > 0n) calls.push(call(WUGNOT_REALM, 'Transfer', [PAD_ADDRESS, pay.toString()]));
  calls.push(call(PAD, 'Buy', [launch, o.amountIn.toString(), p.min.toString()]));
  return { calls, wrap };
}
export const planClaim = (caller: string): Call[] => {
  if (!isAddress(caller)) throw new InputError('That is not a gno.land address.');
  return [{ caller, send: '', max_deposit: MAX_DEPOSIT, pkg_path: PAD, func: 'ClaimWugnot', args: [] }];
};

export function gnomiDesk(rpc: Rpc) {
  async function read(o: Order): Promise<CurveState> {
    const { launch } = check(o), q = `("${launch}")`, token = isBuy(o) ? o.output : o.input;
    const [path, status, info, history, remaining] = await Promise.all([
      rpc.evalString(`${PAD}.AdenaPathOf${q}`), rpc.evalInt(`${PAD}.GetStatus${q}`), rpc.evalString(`${PAD}.LaunchInfo${q}`), rpc.evalString(`${PAD}.TradeHistory${q}`), rpc.evalInt(`${PAD}.RemainingRaiseUgnot${q}`),
    ]);
    if (path !== token) throw new InputError('This launch does not match the token on the page.');
    if (status !== 0n) throw new InputError('This launch has graduated and no longer trades on its curve.');
    return { ...parseReserves(info, history), remaining };
  }
  return {
    async quote(o: Order): Promise<Quote> {
      // two reads can straddle a block, so a mismatch is worth one more look
      const c = await read(o).catch((e: unknown) => { if (e instanceof InputError) throw e; return read(o); });
      return quoteCurve(c, isBuy(o), o.amountIn);
    },
    credit(address: string): Promise<bigint> {
      if (!isAddress(address)) throw new InputError('That is not a gno.land address.');
      return rpc.evalInt(`${PAD}.PrepaidOf("${address}")`);
    },
  };
}

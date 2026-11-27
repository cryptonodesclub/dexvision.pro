import type { Indexer } from '../indexer.ts';
import type { Rpc } from '../rpc.ts';

export interface Token { path: string; realm: string; symbol: string; decimals: number }

/** One place where two tokens trade: an AMM pool, a bonding curve… `id` is unique within its venue. */
export interface Market { venue: string; id: string; token0: string; token1: string; feePct: number; height: number }

export interface MarketState {
  price: number;     // token0 in token1, human units
  balance0: number;  // real reserves a seller can draw on, human units
  balance1: number;
  active: boolean;   // can be traded here at this price right now
  stage?: string;    // e.g. "curve", shown to people
}
/** A trade, with the market price after it. Amounts are absolute, human units. */
export interface Fill { height: number; price: number; amount0: number; amount1: number; buy: boolean; tx?: string; by?: string } // buy: token0 was bought; tx: hash, by: signer
/** `seed`: price just before the range, if known. `partial`: older trades in the range may be missing. */
export interface Fills { seed?: number; fills: Fill[]; partial?: boolean }

/** Part of a market's reserves that one account can withdraw. Amounts in human units. */
export interface Stake { owner: string; staked: boolean; amount0: number; amount1: number }

export interface VenueContext { rpc: Rpc; indexer: Indexer; token(path: string): Promise<Token> }

/** A market source. Adding a DEX means writing one of these and listing it in venues/index.ts. */
export interface Venue {
  id: string;
  label: string;
  markets(): Promise<Market[]>;
  state(m: Market): Promise<MarketState>;
  /** Full history of one market, for charts. */
  fills(m: Market, from: number, to: number): Promise<Fills>;
  /** History already on this device, without asking anyone. Null if there is not enough to draw. */
  peek(m: Market): Promise<Fills | null>;
  /** Trades of one market signed by an account, at the price actually paid. */
  mine(m: Market, account: string, to: number): Promise<Fill[]>;
  /** Recent trades of many markets at once, for lists. Keyed by market id. */
  recent(ms: readonly Market[], from: number, to: number): Promise<Map<string, Fills>>;
  /** Who provides the reserves. Left out by venues where nobody does. */
  providers?(m: Market, to: number, progress: (part: number) => void): Promise<{ stakes: Stake[]; balance0: number; balance1: number }>;
  /** Ids of the markets that traded in [from, to). Cheap enough to poll. */
  touched(from: number, to: number): Promise<string[]>;
}
export type VenueFactory = (ctx: VenueContext) => Venue;

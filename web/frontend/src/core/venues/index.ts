import { NETWORK } from '../config.ts';
import { SEED } from '../seed.ts';
import type { Expected } from '../snapshot.ts';
import { gnomi, GNOMI_HISTORY } from './gnomi.ts';
import { gnoswap, GNOSWAP_HISTORY } from './gnoswap.ts';
import type { VenueFactory } from './venue.ts';

/** Every market source the engine reads. A new DEX is one more file and one more entry here. */
export const VENUES: readonly VenueFactory[] = [
  // the seed lists mainnet pools; other chains find theirs from the first block
  (ctx) => gnoswap(ctx, NETWORK.seeded ? SEED : { height: 0, pools: [] }),
  ...(NETWORK.gnomi ? [(ctx: Parameters<VenueFactory>[0]) => gnomi(ctx)] : []),
];
/** What the published history must contain to be used. */
export const HISTORY: readonly Expected[] = [GNOSWAP_HISTORY, GNOMI_HISTORY];

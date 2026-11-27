/** A gno.land chain DexVision can read. */
export interface Network {
  id: 'mainnet' | 'onyx';
  chainId: string;
  rpc: string;
  indexer: string;
  /** Where realms render, for links. */
  gnoweb: string;
  /** The token profile registry, see realm/tokeninfo. Empty until deployed there. */
  tokeninfo: string;
  /** Pool list and trade history published for this chain (services/history, core/seed). */
  seeded: boolean;
  /** Gnomi launchpads run here. */
  gnomi: boolean;
  /** The trade panel is on. Off on mainnet until a real Adena signature has been tested. */
  trading: boolean;
}

export const NETWORKS: Record<Network['id'], Network> = {
  mainnet: {
    id: 'mainnet', chainId: 'gnoland-1', rpc: 'https://rpc.gno.land:443', indexer: 'https://indexer.gno.land/graphql/query',
    gnoweb: 'https://gno.land', tokeninfo: '', seeded: true, gnomi: true, trading: false,
  },
  onyx: {
    id: 'onyx', chainId: 'onyx-1', rpc: 'https://rpc.onyx.testnets.gno.land:443', indexer: 'https://indexer.onyx.testnets.gno.land/graphql/query',
    gnoweb: 'https://onyx.testnets.gno.land', tokeninfo: 'gno.land/r/g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh/tokeninfo/v1', seeded: false, gnomi: false, trading: true,
  },
};
export const MAINNET = NETWORKS.mainnet;

const PREF = 'dexvision:network';
const isId = (s: string | null | undefined): s is Network['id'] => s === 'mainnet' || s === 'onyx';

/** What a first visit reads: the testnet, where the tokeninfo realm and trading are live. */
const FIRST_VISIT: Network['id'] = 'onyx';

/**
 * The chain this page reads: `?network=…` in the address (remembered), else the last choice, else FIRST_VISIT.
 * Outside a browser (the CLI tools and tests) it is DEXVISION_NETWORK, else mainnet.
 */
export function pickNetwork(): Network {
  if (typeof window === 'undefined') {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['DEXVISION_NETWORK'];
    return NETWORKS[isId(env) ? env : 'mainnet'];
  }
  const asked = new URLSearchParams(window.location.search).get('network');
  try {
    if (isId(asked)) localStorage.setItem(PREF, asked);
    const saved = localStorage.getItem(PREF);
    if (isId(saved)) return NETWORKS[saved];
  } catch { /* storage blocked: the address alone decides */ }
  return NETWORKS[isId(asked) ? asked : FIRST_VISIT];
}

export const NETWORK = pickNetwork();
export const WUGNOT = 'gno.land/r/gnoland/wugnot.wugnot';

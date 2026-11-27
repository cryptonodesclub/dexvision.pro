/** gno.land/r/gnoswap/gns.GNS lives at /token/r/gnoswap/gns.GNS */
export const tokenUrl = (path: string) => '/token' + path.replace(/^gno\.land/, '');
/** The token or realm an address points at: /token/r/…, or the older /token/?t=/r/…. Null if neither. */
export function pathFromLocation(l: { pathname: string; search: string }): string | null {
  if (!l.pathname.startsWith('/token/r/')) return new URLSearchParams(l.search).get('t');
  try { return decodeURIComponent(l.pathname.slice('/token'.length)); } catch { return null; }
}
import { NETWORK } from '../core/config.ts';

/** Where to read more about an account or a realm, on the chain this page reads. */
const onChain = NETWORK.id === 'mainnet' ? '' : `chainId=${NETWORK.chainId}`;
export const explorer = (x: { address: string; realm?: string }) => (x.realm ? `https://gnoscan.io/realms/details?path=${x.realm}${onChain && '&' + onChain}` : `https://gnoscan.io/account/${encodeURIComponent(x.address)}${onChain && '?' + onChain}`);
/** gno.land/r/x/y as rendered by gnoweb on this chain. */
export const realmPage = (realm: string) => NETWORK.gnoweb + realm.replace(/^gno\.land/, '');
/** /r/g1n4pl…rhmt/gnomi/padv3: addresses are too long for a row. */
export const shortRealm = (realm: string) => realm.replace('gno.land', '').replace(/\/(g1[a-z0-9]{4})[a-z0-9]{30}([a-z0-9]{4})(?=\/|$)/, '/$1…$2');
export const symbolOf = (path: string) => path.slice(path.lastIndexOf('.') + 1).replace(/^wugnot$/, 'GNOT');

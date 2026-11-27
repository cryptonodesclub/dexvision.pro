/** Realm and token identifiers. Everything that reaches a qeval expression is validated here. */
const REALM = /^gno\.land\/r\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;
const SYMBOL = /^[A-Za-z0-9_-]{1,32}$/;

export interface RealmRef { realm: string; symbol?: string }

export class InputError extends Error { override name = 'InputError'; }

/**
 * Accepts what people actually paste: a realm path, a token path (`realm.SYMBOL`),
 * a gno.land URL (with `$source` or `:args`) or a gnoswap.io link with `?path=`.
 */
export function parseRealm(input: string): RealmRef {
  let s = input.trim();
  const swap = /[?&]path=([^&#]+)/.exec(s);
  if (swap) s = decodeURIComponent(swap[1]!);
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (s.startsWith('/r/')) s = 'gno.land' + s;
  else if (s.startsWith('r/')) s = 'gno.land/' + s;
  s = s.replace(/[$?#:].*$/, '').replace(/\/+$/, '');
  if (/^g1[a-z0-9]{38}$/.test(s)) throw new InputError('That is an account address. A token is identified by its realm, for example gno.land/r/gnoswap/gns.');
  const slash = s.lastIndexOf('/'), dot = s.indexOf('.', slash);
  const realm = dot > slash && slash > 0 ? s.slice(0, dot) : s;
  const symbol = dot > slash && slash > 0 ? s.slice(dot + 1) : undefined;
  if (!REALM.test(realm)) throw new InputError(`"${input.trim()}" is not a realm path. Use something like gno.land/r/gnoswap/gns.`);
  if (symbol !== undefined && !SYMBOL.test(symbol)) throw new InputError(`"${symbol}" is not a valid token symbol.`);
  return symbol === undefined ? { realm } : { realm, symbol };
}

export function splitTokenPath(path: string): { realm: string; symbol: string } {
  const r = parseRealm(path);
  if (!r.symbol) throw new InputError(`"${path}" has no token symbol.`);
  return { realm: r.realm, symbol: r.symbol };
}

/** Throws unless `path` is exactly `token0:token1:fee`. */
export function assertPoolPath(path: string): string {
  const [a, b, fee, ...rest] = path.split(':');
  if (!a || !b || !fee || rest.length || !/^\d+$/.test(fee)) throw new InputError(`"${path}" is not a pool path.`);
  splitTokenPath(a); splitTokenPath(b);
  return path;
}

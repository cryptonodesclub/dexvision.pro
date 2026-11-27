/**
 * Token profiles from the tokeninfo realm (realm/tokeninfo): a description, a logo and official links that only
 * the people behind a token can write. The checks here mirror the realm's, so a form can say what is wrong
 * before anything is signed; the realm checks again and has the last word.
 */
import { InputError } from './paths.ts';
import { RpcError, type Rpc } from './rpc.ts';
import type { Call } from './trade/proto.ts';
import { isAddress, type Gas } from './trade/trade.ts';

export interface Profile {
  description: string; website: string; logo: string; x: string; telegram: string; discord: string; github: string;
}
export interface Published extends Profile { updatedBy: string; updatedAt: number; role: 'owner' | 'realm' | 'editor' | string }
export type Field = keyof Profile;
export const FIELDS: readonly Field[] = ['description', 'website', 'logo', 'x', 'telegram', 'discord', 'github'];
export const EMPTY: Profile = { description: '', website: '', logo: '', x: '', telegram: '', discord: '', github: '' };

/** Measured on onyx-1: a full profile takes about 8M gas. */
export const PROFILE_GAS: Gas = { wanted: 30_000_000, fee: 30_000 };
const MAX_DEPOSIT = 2_000_000; // ugnot; a profile is well under 1 KB

const TOKEN = /^gno\.land\/r\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\.[A-Za-z0-9_-]{1,32}$/;
const quote = (s: string) => JSON.stringify(s); // qeval reads Go string literals; JSON's are a subset for these inputs

function token(path: string): string {
  if (path.length > 200 || !TOKEN.test(path)) throw new InputError(`"${path}" is not a token path.`);
  return path;
}

/** The published profile, or null when there is none or a moderator hid it. */
export async function readProfile(rpc: Rpc, realm: string, path: string): Promise<Published | null> {
  if (!realm) return null;
  const v = await rpc.eval(`${realm}.Fields(${quote(token(path))})`);
  if (v.length !== 10) throw new RpcError(`unexpected profile reply for ${path}`);
  const [description, website, logo, x, telegram, discord, github, updatedBy, updatedAt, role] = v.map((x) => x.value) as [string, string, string, string, string, string, string, string, string, string];
  if (!updatedBy) return null;
  return { description, website, logo, x, telegram, discord, github, updatedBy, updatedAt: Number(updatedAt), role };
}

/** Whether `address`, signing itself, may write this token's profile now. */
export async function canEdit(rpc: Rpc, realm: string, path: string, address: string): Promise<boolean> {
  if (!realm || !isAddress(address)) return false;
  return rpc.evalBool(`${realm}.CanEdit(${quote(token(path))}, ${quote(address)})`);
}

/* ---- the realm's rules, for the form ---- */

const urlProblem = (s: string): string => {
  if (!s) return '';
  if (s.length > 200) return 'Keep it under 200 characters.';
  if (!/^https:\/\/[^/]/.test(s)) return 'Use an https:// address.';
  if (/[\s"'<>\\`()[\]{}|^]|[^\x21-\x7e]/.test(s)) return 'It has a character that is not allowed in a link.';
  return '';
};
const handleProblem = (s: string, min: number, max: number) =>
  !s ? '' : s.length < min || s.length > max ? `Use ${min} to ${max} characters.` : /^[A-Za-z0-9_]+$/.test(s) ? '' : 'Use letters, digits and _ only.';

/** Trims and drops a leading @, as the realm does. */
export function tidy(p: Profile): Profile {
  const at = (s: string) => s.trim().replace(/^@/, '');
  return { description: p.description.trim(), website: p.website.trim(), logo: p.logo.trim(), x: at(p.x), telegram: at(p.telegram), discord: p.discord.trim(), github: p.github.trim() };
}

/** What the realm would refuse, field by field. Empty means it would accept. */
export function problems(raw: Profile): Partial<Record<Field, string>> {
  const p = tidy(raw), out: Partial<Record<Field, string>> = {};
  if ([...p.description].length > 280) out.description = 'Keep it under 280 characters.';
  // eslint-disable-next-line no-control-regex
  else if (/[\x00-\x1f\x7f-\x9f]|[\u{2028}\u{2029}]/u.test(p.description)) out.description = 'Use one paragraph, without line breaks.';
  for (const f of ['website', 'logo', 'discord'] as const) { const e = urlProblem(p[f]); if (e) out[f] = e; }
  if (!out.discord && p.discord && !/^https:\/\/(discord\.gg|discord\.com\/invite)\//.test(p.discord)) out.discord = 'Use an invite link, https://discord.gg/…';
  const x = handleProblem(p.x, 1, 15); if (x) out.x = x;
  const tg = handleProblem(p.telegram, 5, 32); if (tg) out.telegram = tg;
  if (p.github && !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,38}(?:\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100})?$/.test(p.github)) out.github = 'Use owner or owner/repo.';
  return out;
}

/** The one call that writes the whole profile. Empty fields clear what was there. */
export function profileCall(caller: string, realm: string, path: string, raw: Profile): Call {
  if (!isAddress(caller)) throw new InputError('That is not a gno.land address.');
  if (!realm) throw new InputError('Token profiles are not available on this network yet.');
  const bad = Object.values(problems(raw));
  if (bad.length) throw new InputError(bad[0]!);
  const p = tidy(raw);
  return { caller, send: '', max_deposit: `${MAX_DEPOSIT}ugnot`, pkg_path: realm, func: 'SetProfile', args: [token(path), ...FIELDS.map((f) => p[f])] };
}

/** Safe to put in an href: only what the realm accepts. */
export const safeUrl = (s: string): string | null => (s && !urlProblem(s) ? s : null);

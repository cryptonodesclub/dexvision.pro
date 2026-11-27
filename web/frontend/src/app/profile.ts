import { NETWORK } from '../core/config.ts';
import { InputError } from '../core/paths.ts';
import { Rpc } from '../core/rpc.ts';
import { canEdit, EMPTY, FIELDS, problems, profileCall, PROFILE_GAS, readProfile, safeUrl, tidy, type Field, type Profile, type Published } from '../core/tokeninfo.ts';
import { explain } from '../core/trade/trade.ts';
import { realmPage } from './links.ts';
import { WalletError, type Wallet, type WalletState } from './wallet.ts';
import { shortAddress } from './walletbutton.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ROLE: Record<string, string> = { owner: 'the owner of its namespace', realm: 'the token’s own contract', editor: 'an editor the owner named' };
const LINKS: { field: Field; label: string; href: (v: string) => string | null; text: (v: string) => string }[] = [
  { field: 'website', label: 'Website', href: safeUrl, text: (v) => v.replace(/^https:\/\//, '').replace(/\/$/, '') },
  { field: 'x', label: 'X', href: (v) => `https://x.com/${encodeURIComponent(v)}`, text: (v) => '@' + v },
  { field: 'telegram', label: 'Telegram', href: (v) => `https://t.me/${encodeURIComponent(v)}`, text: (v) => '@' + v },
  { field: 'discord', label: 'Discord', href: safeUrl, text: (v) => v.replace(/^https:\/\//, '') },
  { field: 'github', label: 'GitHub', href: (v) => `https://github.com/${v.split('/').map(encodeURIComponent).join('/')}`, text: (v) => v },
];

/** The token's on-chain profile, and the form its owner edits it with. */
export function createProfile(wallet: Wallet, path: string) {
  const realm = NETWORK.tokeninfo, box = $('about');
  if (!realm || !box) return;
  box.hidden = false;
  const rpc = new Rpc(NETWORK.rpc), form = $<HTMLFormElement>('p-form'), edit = $<HTMLButtonElement>('p-edit'), msg = $('p-msg'), go = $<HTMLButtonElement>('p-go');
  const ns = path.replace(/^gno\.land\/r\//, '').split('/')[0] ?? '';
  let shown: Published | null = null, me: WalletState = { installed: false, address: null, chainId: null }, allowed = false, busy = false, turn = 0;
  $<HTMLAnchorElement>('p-registry').href = realmPage(realm) + ':' + path;

  function draw() {
    const p = shown;
    $('p-none').hidden = !!p;
    $('p-body').hidden = !p;
    if (p) {
      const logo = $<HTMLImageElement>('p-logo'), src = safeUrl(p.logo);
      logo.hidden = !src; if (src && logo.getAttribute('src') !== src) logo.src = src;
      $('p-desc').textContent = p.description; $('p-desc').hidden = !p.description;
      const list = $('p-links'); list.replaceChildren();
      for (const l of LINKS) {
        const v = p[l.field], href = v ? l.href(v) : null;
        if (!href) continue;
        const li = document.createElement('li'), k = document.createElement('span'), a = document.createElement('a');
        k.textContent = l.label; a.href = href; a.textContent = l.text(v); a.rel = 'noopener noreferrer nofollow'; a.target = '_blank';
        li.append(k, a); list.append(li);
      }
      $('p-who').textContent = `Published on-chain at block ${p.updatedAt.toLocaleString('en-US')} by ${shortAddress(p.updatedBy)}, ${ROLE[p.role] ?? p.role}.`;
    }
    $('p-hint').textContent = allowed ? '' : !me.address ? `Connect the wallet that owns ${ns} to publish this token’s links.` : `Only the owner of ${ns}, the token’s contract or an editor they name can write this profile.`;
    edit.hidden = !allowed || !form.hidden; edit.textContent = p ? 'Edit profile' : 'Add profile';
  }

  async function load() {
    const mine = ++turn;
    try {
      const [p, ok] = await Promise.all([readProfile(rpc, realm, path), me.address && me.chainId === NETWORK.chainId ? canEdit(rpc, realm, path, me.address) : Promise.resolve(false)]);
      if (mine !== turn) return;
      shown = p; allowed = ok;
    } catch { if (mine === turn) $('p-hint').textContent = 'The profile could not be read. It will be tried again.'; setTimeout(() => void load(), 15_000); return; }
    draw();
  }

  const input = (f: Field) => form.elements.namedItem(f) as HTMLInputElement | HTMLTextAreaElement;
  const values = (): Profile => Object.fromEntries(FIELDS.map((f) => [f, input(f).value])) as unknown as Profile;
  function check(): boolean {
    const bad = problems(values());
    for (const f of FIELDS) { const e = form.querySelector<HTMLElement>(`[data-err="${f}"]`)!; e.textContent = bad[f] ?? ''; input(f).setAttribute('aria-invalid', String(!!bad[f])); }
    $('p-count').textContent = `${[...input('description').value.trim()].length} / 280`;
    go.disabled = busy || Object.keys(bad).length > 0;
    return go.disabled === false;
  }
  function say(text: string, bad = false) { msg.textContent = text; msg.toggleAttribute('data-bad', bad); }

  edit.addEventListener('click', () => {
    const p = tidy(shown ?? EMPTY);
    for (const f of FIELDS) input(f).value = p[f];
    form.hidden = false; edit.hidden = true; say(''); check(); input('description').focus();
  });
  $('p-cancel').addEventListener('click', () => { form.hidden = true; say(''); draw(); });
  form.addEventListener('input', check);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !check() || !me.address) return;
    busy = true; go.disabled = true; say('Confirm in Adena');
    try {
      const sent = await wallet.send([profileCall(me.address, realm, path, values())], PROFILE_GAS);
      if (sent.state === 'failed') say(explain(sent.reason), true);
      else {
        say(sent.state === 'done' ? 'Published. Every app that reads the registry now shows it.' : 'Sent. Adena did not confirm it yet; it shows here once it lands.');
        form.hidden = true; setTimeout(() => void load(), 2500);
      }
    } catch (err) { say(err instanceof WalletError || err instanceof InputError ? err.message : 'Adena could not send it. Try again.', true); }
    finally { busy = false; check(); draw(); }
  });

  wallet.watch((s) => { const moved = s.address !== me.address || s.chainId !== me.chainId; me = s; if (moved) { allowed = false; void load(); } });
}

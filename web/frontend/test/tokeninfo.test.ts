import { describe, expect, it } from 'vitest';
import { Rpc } from '../src/core/rpc.ts';
import { canEdit, EMPTY, problems, profileCall, readProfile, safeUrl } from '../src/core/tokeninfo.ts';

const REALM = 'gno.land/r/g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh/tokeninfo/v1';
const TOKEN = 'gno.land/r/g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh/demo.DXV';
const ME = 'g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh';

/** An Rpc whose node answers every qeval with `reply`, and remembers what it was asked. */
function fakeRpc(reply: string) {
  const asked: string[] = [];
  const rpc = new Rpc('http://node', {
    fetch: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { params: { data: string } };
      asked.push(atob(body.params.data));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { response: { ResponseBase: { Data: btoa(reply) } } } }));
    }) as typeof fetch,
  });
  return { rpc, asked };
}

describe('token profiles', () => {
  it('accepts what the realm accepts', () => {
    expect(problems({ description: 'é'.repeat(280), website: 'https://tok.example', logo: 'https://tok.example/l.png', x: '@fifteen_chars__', telegram: 'tok_chat', discord: 'https://discord.com/invite/x', github: 'a-b/c.d_e' })).toEqual({});
    expect(problems(EMPTY)).toEqual({});
  });

  it('refuses what the realm refuses', () => {
    const bad = problems({ description: 'two\nlines', website: 'http://tok.example', logo: 'https://x.example/a)b', x: 'bad-handle', telegram: 'abc', discord: 'https://evil.example/d', github: 'alice/..' });
    expect(Object.keys(bad).sort()).toEqual(['description', 'discord', 'github', 'logo', 'telegram', 'website', 'x']);
    expect(problems({ ...EMPTY, website: 'javascript:alert(1)' }).website).toBeTruthy();
    expect(problems({ ...EMPTY, website: 'https:///evil' }).website).toBeTruthy();
    expect(problems({ ...EMPTY, description: 'é'.repeat(281) }).description).toBeTruthy();
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('https://ok.example/x')).toBe('https://ok.example/x');
  });

  it('builds one SetProfile call with every field in order, tidied', () => {
    const c = profileCall(ME, REALM, TOKEN, { ...EMPTY, description: ' Hi ', x: '@dex', github: 'cryptonodesclub/dexvision.pro' });
    expect(c).toEqual({ caller: ME, send: '', max_deposit: '2000000ugnot', pkg_path: REALM, func: 'SetProfile', args: [TOKEN, 'Hi', '', '', 'dex', '', '', 'cryptonodesclub/dexvision.pro'] });
    expect(() => profileCall(ME, REALM, TOKEN, { ...EMPTY, website: 'http://x' })).toThrow(/https/);
    expect(() => profileCall(ME, '', TOKEN, EMPTY)).toThrow(/not available/);
    expect(() => profileCall(ME, REALM, 'gno.land/r/x") + evil("', EMPTY)).toThrow(/not a token path/);
  });

  it('reads the published profile from qeval output', async () => {
    const { rpc, asked } = fakeRpc(['("A \\"demo\\" token" string)', '("https://tok.example" string)', '("" string)', '("dex" string)', '("" string)', '("" string)', '("" string)', `("${ME}" string)`, '(1432900 int64)', '("owner" string)'].join('\n'));
    const p = await readProfile(rpc, REALM, TOKEN);
    expect(asked).toEqual([`${REALM}.Fields("${TOKEN}")`]);
    expect(p).toMatchObject({ description: 'A "demo" token', website: 'https://tok.example', x: 'dex', updatedBy: ME, updatedAt: 1432900, role: 'owner' });
  });

  it('treats an empty reply as no profile, and asks CanEdit with the address', async () => {
    const empty = fakeRpc([...Array(7).fill('("" string)'), '("" string)', '(0 int64)', '("" string)'].join('\n'));
    expect(await readProfile(empty.rpc, REALM, TOKEN)).toBeNull();
    const yes = fakeRpc('(true bool)');
    expect(await canEdit(yes.rpc, REALM, TOKEN, ME)).toBe(true);
    expect(yes.asked).toEqual([`${REALM}.CanEdit("${TOKEN}", "${ME}")`]);
    expect(await canEdit(yes.rpc, REALM, TOKEN, 'not-an-address')).toBe(false);
  });
});

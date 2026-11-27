import { NETWORK, type Network } from '../core/config.ts';
import type { Call } from '../core/trade/proto.ts';
import { isAddress, type Gas } from '../core/trade/trade.ts';

/** The part of Adena's injected API this page uses. */
interface Reply<D> { code: number; status: 'success' | 'failure'; type: string; message: string; data: D }
interface TxPart { ResponseBase?: { Error?: unknown; Log?: string } }
interface Committed { hash?: string; height?: string; check_tx?: TxPart; deliver_tx?: TxPart }
interface Adena {
  AddEstablish(name: string): Promise<Reply<unknown>>;
  GetAccount(): Promise<Reply<{ address: string; chainId: string }>>;
  SwitchNetwork(chainId: string): Promise<Reply<unknown>>;
  AddNetwork(network: { chainId: string; chainName: string; rpcUrl: string }): Promise<Reply<unknown>>;
  DoContract(tx: { messages: { type: '/vm.m_call'; value: Call }[]; gasFee: number; gasWanted: number; memo?: string }): Promise<Reply<Committed | null>>;
  On(event: 'changedAccount' | 'changedNetwork', fn: (v: string) => void): void;
}
declare global { interface Window { adena?: Adena } }

export class WalletError extends Error { override name = 'WalletError'; }
export type Sent = { state: 'done'; hash: string } | { state: 'failed'; reason: string; hash: string } | { state: 'unknown'; hash: string };
export interface WalletState { installed: boolean; address: string | null; chainId: string | null }

const FLAG = 'dexvision:wallet';
/** How each chain is named when Adena is asked to add it. */
const NAMES: Record<Network['id'], string> = { mainnet: 'Gno.land Mainnet', onyx: 'Gno.land Onyx Testnet' };
const remember = (on: boolean) => { try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch { /* storage blocked */ } };

/** What happened to a transaction Adena was asked to send. A hash alone is not proof that it worked. */
export function outcome(r: Reply<Committed | null>): Sent {
  if (r.status !== 'success') throw new WalletError(/REJECT/.test(r.type) ? 'You cancelled in Adena. Nothing was sent.' : r.type === 'UNRESOLVED_TRANSACTION_EXISTS' ? 'Adena has another request open. Finish it first.' : r.type === 'WALLET_LOCKED' ? 'Unlock Adena and try again.' : `Adena could not send the trade: ${r.message || r.type}`);
  const d = r.data ?? {}, hash = d.hash ?? '', err = [d.check_tx, d.deliver_tx].map((p) => (p?.ResponseBase?.Error ? p.ResponseBase.Log || JSON.stringify(p.ResponseBase.Error) : '')).find((x) => x !== '');
  if (err) return { state: 'failed', reason: err, hash };
  return d.deliver_tx?.ResponseBase ? { state: 'done', hash } : { state: 'unknown', hash };
}

/** One wallet per page: the header and the trade panel share it. */
export function createWallet() {
  const st: WalletState = { installed: !!window.adena, address: null, chainId: null };
  const watchers = new Set<(s: WalletState) => void>();
  let wired = false, linked = false, joining: Promise<void> | null = null; // linked: the visitor wants this site connected
  const emit = () => { for (const f of watchers) f({ ...st }); };
  const drop = () => { st.address = st.chainId = null; };
  const api = (): Adena => { st.installed = !!window.adena; if (!window.adena) throw new WalletError('Adena is not installed in this browser.'); return window.adena; };

  async function account(): Promise<boolean> {
    if (!linked) { drop(); return false; }
    const r = await api().GetAccount();
    if (!linked || r.status !== 'success' || !isAddress(r.data?.address ?? '')) { drop(); return false; } // may have disconnected meanwhile
    st.address = r.data.address; st.chainId = r.data.chainId;
    if (!wired) {
      wired = true;
      const again = () => { void account().then(emit, emit); };
      api().On('changedAccount', again); api().On('changedNetwork', again);
    }
    return true;
  }
  async function join(): Promise<void> {
    const r = await api().AddEstablish('DexVision');
    if (r.status !== 'success' && r.type !== 'ALREADY_CONNECTED') throw new WalletError(/REJECT/.test(r.type) ? 'You cancelled the connection.' : `Adena did not connect: ${r.message || r.type}`);
    linked = true;
    if (!(await account())) { linked = false; throw new WalletError('Adena has no account available. Unlock it or create one.'); }
    remember(true); emit();
  }
  /** Two buttons can ask at once; Adena is asked once. */
  function connect(): Promise<void> { return joining ??= join().finally(() => { joining = null; }); }
  /** Forgets the wallet on this site. Adena keeps its own list of allowed sites. */
  function disconnect(): void { linked = false; remember(false); drop(); emit(); }
  /** Asks Adena to move to `net` (the page's chain by default), adding the network to Adena first if it lacks it. */
  async function useNetwork(net: Network = NETWORK): Promise<void> {
    const a = api(), ok = (r: Reply<unknown>) => r.status === 'success' || r.type === 'REDUNDANT_CHANGE_REQUEST';
    let r = await a.SwitchNetwork(net.chainId);
    console.info('[DexVision] Adena SwitchNetwork', net.chainId, r);
    if (!ok(r) && r.type === 'UNADDED_NETWORK') {
      const added = await a.AddNetwork({ chainId: net.chainId, chainName: NAMES[net.id], rpcUrl: net.rpc });
      console.info('[DexVision] Adena AddNetwork', net.chainId, added);
      if (/REJECT/.test(added.type)) throw new WalletError(`You did not add ${net.chainId} to Adena.`);
      r = await a.SwitchNetwork(net.chainId); // also when adding failed: it may have been there already
      console.info('[DexVision] Adena SwitchNetwork', net.chainId, r);
    }
    if (!ok(r)) throw new WalletError(/REJECT/.test(r.type) ? `Adena stays on its network. You can switch it to ${net.chainId} later.` : r.type === 'UNADDED_NETWORK' ? `Add the ${net.chainId} network in Adena first.` : `Adena did not change network (${r.type || r.message || 'no reason given'}).`);
    await account(); emit();
  }
  /** Sends only if the wallet still has the account and network the trade was prepared for. */
  async function send(calls: readonly Call[], gas: Gas): Promise<Sent> {
    const want = calls[0]!.caller;
    if (!(await account())) { emit(); throw new WalletError('Adena is locked or disconnected.'); }
    emit();
    if (st.address !== want) throw new WalletError('The account changed in Adena. Check the trade and try again.');
    if (st.chainId !== NETWORK.chainId) throw new WalletError(`Adena is not on ${NETWORK.chainId}.`);
    return outcome(await api().DoContract({ messages: calls.map((value) => ({ type: '/vm.m_call', value })), gasFee: gas.fee, gasWanted: gas.wanted }));
  }

  // extensions inject late; reconnect silently only if the visitor connected before
  let tries = 0;
  const look = async (): Promise<void> => {
    st.installed = !!window.adena;
    if (!st.installed) { if (tries++ < 12) setTimeout(() => void look(), 250); emit(); return; }
    try { linked = localStorage.getItem(FLAG) === '1'; } catch { /* storage blocked */ }
    if (linked) await account().catch(() => false);
    emit();
  };
  void look();
  // connecting or disconnecting in one tab applies to the others
  addEventListener('storage', (e) => { if (e.key === FLAG || e.key === null) { if (e.key !== null && e.newValue === '1') void look(); else { linked = false; drop(); emit(); } } });

  return { connect, disconnect, useNetwork, send, /** Called now and on every change. */ watch(f: (s: WalletState) => void): void { watchers.add(f); f({ ...st }); } };
}
export type Wallet = ReturnType<typeof createWallet>;

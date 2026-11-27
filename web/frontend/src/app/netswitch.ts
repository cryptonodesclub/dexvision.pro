import { NETWORK, NETWORKS, type Network } from '../core/config.ts';
import type { Wallet } from './wallet.ts';

const FOLLOW = 'dexvision:follow';

/**
 * Mainnet | Testnet in the header. The other one opens that chain's token list, and that page, once it
 * has read Adena, asks it to switch to the same chain: the request is made where the visitor stays, so
 * a page change can never swallow Adena's confirmation window.
 */
export function networkSwitch(wallet: Wallet): void {
  const chain = document.getElementById('chain');
  if (chain) chain.textContent = NETWORK.chainId;

  document.querySelectorAll<HTMLButtonElement>('.nets [data-net]').forEach((b) => {
    const id = b.dataset['net'] as Network['id'], here = id === NETWORK.id;
    b.setAttribute('aria-pressed', String(here));
    b.title = here ? `Reading ${NETWORKS[id].chainId}` : `Switch to ${NETWORKS[id].chainId}`;
    if (!here) b.addEventListener('click', () => {
      try { sessionStorage.setItem(FOLLOW, id); } catch { /* storage blocked: the wallet button still offers the switch */ }
      // a token path may not exist on the other chain, so start from its list
      location.href = `/?network=${id}`;
    });
  });

  let follow = false;
  try { follow = sessionStorage.getItem(FOLLOW) === NETWORK.id; sessionStorage.removeItem(FOLLOW); } catch { /* storage blocked */ }
  if (!follow) return;
  let asked = false;
  wallet.watch((s) => {
    if (asked || !s.address || !s.chainId) return;
    asked = true; // once: declining must not bring the window back
    if (s.chainId === NETWORK.chainId) return;
    console.info('[DexVision] asking Adena to follow the page to', NETWORK.chainId, 'from', s.chainId);
    wallet.useNetwork().catch((e: unknown) => {
      const note = document.getElementById('w-note');
      if (note) { note.textContent = e instanceof Error ? e.message : String(e); note.hidden = false; }
    });
  });
}

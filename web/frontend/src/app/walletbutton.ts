import { NETWORK } from '../core/config.ts';
import { WalletError, type Wallet, type WalletState } from './wallet.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const shortAddress = (a: string) => `${a.slice(0, 7)}…${a.slice(-4)}`;

/** Top-right button: connects, then shows the address and copies it when pressed. */
export function walletButton(wallet: Wallet): void {
  const main = $<HTMLButtonElement>('w-main'), off = $('w-off'), note = $('w-note');
  let s: WalletState = { installed: false, address: null, chainId: null }, busy = '', flash = '', timer = 0;

  function draw() {
    const wrong = s.address !== null && s.chainId !== NETWORK.chainId;
    main.textContent = busy || flash || (!s.address ? 'Connect wallet' : wrong ? `Switch to ${NETWORK.chainId}` : shortAddress(s.address));
    main.disabled = busy !== '';
    main.dataset['on'] = s.address && !wrong ? 'yes' : 'no';
    main.title = s.address ?? '';
    // the visible text is shortened, so say the rest
    if (s.address && !wrong && !busy) main.setAttribute('aria-label', flash || `Copy address ${s.address}`); else main.removeAttribute('aria-label');
    off.hidden = !s.address || busy !== '';
  }
  function say(text: string, install = false) {
    note.hidden = false; note.textContent = text;
    if (install) { const a = document.createElement('a'); a.href = 'https://www.adena.app/'; a.textContent = 'Get Adena'; a.target = '_blank'; a.rel = 'noopener'; note.append(' ', a); }
  }
  const hush = () => { note.hidden = true; };

  main.addEventListener('click', async () => {
    hush();
    try {
      if (!s.address) { if (!window.adena) { say('Adena is not installed in this browser.', true); return; } busy = 'Connecting'; draw(); await wallet.connect(); }
      else if (s.chainId !== NETWORK.chainId) { busy = 'Changing network'; draw(); await wallet.useNetwork(); }
      else {
        const full = s.address;
        try { await navigator.clipboard.writeText(full); flash = 'Copied'; } catch { say(full); flash = ''; } // blocked: show it whole so it can be selected
        clearTimeout(timer); timer = window.setTimeout(() => { flash = ''; draw(); }, 1500);
      }
    } catch (e) { say(e instanceof WalletError ? e.message : 'Adena did not answer. Try again.'); }
    finally { busy = ''; draw(); }
  });
  off.addEventListener('click', () => { hush(); flash = ''; wallet.disconnect(); main.focus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hush(); });
  document.addEventListener('click', (e) => { if (!(e.target as Element).closest('.wallet')) hush(); });
  wallet.watch((x) => { if (x.address !== s.address) { flash = ''; if (x.address) hush(); } s = x; draw(); });
}

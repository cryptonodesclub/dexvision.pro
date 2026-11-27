import { indexedDbStore, memoryStore, type Store } from '../core/cache.ts';
import { NETWORK } from '../core/config.ts';
import type { Engine } from '../core/engine.ts';

export function openStore(): Store {
  try { return indexedDbStore(NETWORK.chainId); } catch { return memoryStore(); } // storage blocked: remember for this visit only
}
/** Lets people see and remove what is kept on their device. */
export function wireClear(engine: Engine): void {
  const b = document.getElementById('forget');
  b?.addEventListener('click', async () => {
    await engine.indexer.clearCache();
    try { for (const k of Object.keys(localStorage)) if (k.startsWith('dexvision:snapshot')) localStorage.removeItem(k); } catch { /* storage blocked */ }
    b.textContent = 'Cleared';
  });
}

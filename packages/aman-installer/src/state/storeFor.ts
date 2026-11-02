import { folderBackend } from './folderBackend.ts';
import { createStateStore, type StateStore } from './state.ts';

// The state is the state home folder on every system the installer
// supports (Mac and Linux; Windows is reached through WSL2, which is
// Linux here), so the folder backend is the one backend.
export function storeForHost(options: { stateHome: string }): StateStore {
  return createStateStore(folderBackend(options.stateHome));
}

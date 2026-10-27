import type { Host } from '../host/host.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';
import { folderBackend } from './folderBackend.ts';
import { createStateStore, type StateStore } from './state.ts';
import { volumeBackend } from './volumeBackend.ts';

// On Windows the state is in the aman_home volume, so the host kind picks
// the backend; everywhere else it is the state home folder.
export function storeForHost(options: { host: Host; runner: ProcessRunner; stateHome: string }): StateStore {
  if (options.host.kind === 'windows') {
    return createStateStore(volumeBackend(options.runner));
  }
  return createStateStore(folderBackend(options.stateHome));
}

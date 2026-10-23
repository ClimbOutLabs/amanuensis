import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Host } from '../host/host.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';
import { folderBackend } from './folderBackend.ts';
import { createStateStore, type StateStore } from './state.ts';
import { volumeBackend } from './volumeBackend.ts';

// The state home on a host-folder system: AMANUENSIS_HOME when set (the
// doctor shim's rule), else ~/.amanuensis. On Windows the state is in the
// aman_home volume instead, so the host kind picks the backend.
export function storeForHost(host: Host, runner: ProcessRunner): StateStore {
  if (host.kind === 'windows') {
    return createStateStore(volumeBackend(runner));
  }
  const fromEnv = process.env['AMANUENSIS_HOME'];
  const home = fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.amanuensis');
  return createStateStore(folderBackend(home));
}

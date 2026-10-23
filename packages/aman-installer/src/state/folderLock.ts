import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { StateBusyError, StateStoreError } from './state.ts';

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process, so the holder is gone. EPERM: it is there.
    return errorCode(error) === 'EPERM';
  }
}

async function readHolderPid(lockDir: string): Promise<number | null> {
  try {
    const text = await readFile(join(lockDir, 'pid'), 'utf8');
    const parsed = Number.parseInt(text.trim(), 10);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

// The shell's lock, as common.sh takes it: state/lock is a folder made with
// mkdir, holding the holder's pid. A live pid means another run is active;
// a dead one means the folder is left over and is taken over.
export async function withFolderLock(home: string, run: () => Promise<void>): Promise<void> {
  const stateDir = join(home, 'state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockDir = join(stateDir, 'lock');
  try {
    await mkdir(lockDir);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      throw new StateStoreError('the state lock folder could not be made', { cause: error });
    }
    const holderPid = await readHolderPid(lockDir);
    if (holderPid !== null && pidIsAlive(holderPid)) {
      throw new StateBusyError(`another install is running right now (process ${String(holderPid)})`);
    }
    await rm(lockDir, { recursive: true, force: true });
    try {
      await mkdir(lockDir);
    } catch (retryError) {
      throw new StateStoreError('the state lock folder could not be made', { cause: retryError });
    }
  }
  await writeFile(join(lockDir, 'pid'), `${String(process.pid)}\n`, { mode: 0o600 });
  try {
    await run();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

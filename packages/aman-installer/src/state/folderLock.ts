import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LOCK_TIMING, type LockTiming } from './lockTiming.ts';
import { StateBusyError, StateStoreError } from './state.ts';

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

async function folderExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readLine(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

// Seconds since the lock's last beat, or null when there is no readable beat.
async function beatAge(lockDir: string): Promise<number | null> {
  const text = await readLine(join(lockDir, 'beat'));
  return text !== null && /^[0-9]+$/.test(text) ? nowSeconds() - Number.parseInt(text, 10) : null;
}

// A lock with no beat yet is a holder between making the folder and its
// first beat, so it is given a moment before it counts as stopped.
async function lockIsLive(options: { lockDir: string; timing: LockTiming }): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const age = await beatAge(options.lockDir);
    if (age !== null) {
      return age < options.timing.deadSeconds;
    }
    if (!(await folderExists(options.lockDir))) {
      return false;
    }
    await pause(1000);
  }
  return false;
}

async function writeBeat(lockDir: string): Promise<void> {
  const temp = join(lockDir, `beat.${String(process.pid)}`);
  await writeFile(temp, `${String(nowSeconds())}\n`, { mode: 0o600 });
  await rename(temp, join(lockDir, 'beat'));
}

const BUSY = 'another install is running right now';

// Makes the lock folder. A folder whose beats stopped is moved to a name of
// its own first (only one run can win that move), checked to be the stopped
// one, then removed.
async function takeLock(options: { lockDir: string; timing: LockTiming }): Promise<void> {
  const { lockDir, timing } = options;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await mkdir(lockDir);
      return;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new StateStoreError('the state lock folder could not be made', { cause: error });
      }
    }
    if (await lockIsLive(options)) {
      throw new StateBusyError(BUSY);
    }
    const claimed = `${lockDir}.old.${String(process.pid)}.${String(nowSeconds())}.${String(attempt)}`;
    try {
      await rename(lockDir, claimed);
    } catch {
      // Another run moved it first; try to make the folder again.
      continue;
    }
    const age = await beatAge(claimed);
    if (age !== null && age < timing.deadSeconds) {
      // What was moved is a live lock another run made a moment ago: put it back.
      if (await folderExists(lockDir)) {
        await rm(claimed, { recursive: true, force: true });
      } else {
        await rename(claimed, lockDir);
      }
      throw new StateBusyError(BUSY);
    }
    await rm(claimed, { recursive: true, force: true });
  }
  throw new StateBusyError(BUSY);
}

// The shell's lock, as common.sh takes it and installer/STATE.md writes it
// down: state/lock is a folder made with mkdir. The holder refreshes
// state/lock/beat while it runs, and a lock whose beats stopped is taken over.
export async function withFolderLock(options: {
  home: string;
  run: () => Promise<void>;
  timing?: LockTiming;
}): Promise<void> {
  const timing = options.timing ?? LOCK_TIMING;
  const stateDir = join(options.home, 'state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockDir = join(stateDir, 'lock');
  await takeLock({ lockDir, timing });
  const token = `${String(process.pid)}-${String(Date.now())}`;
  const beat = setInterval(() => {
    // A beat that cannot be written only lets the lock expire sooner; there is nothing better to do.
    readLine(join(lockDir, 'owner'))
      .then(owner => (owner === token ? writeBeat(lockDir) : undefined))
      .catch(() => undefined);
  }, timing.beatSeconds * 1000);
  beat.unref();
  try {
    await writeFile(join(lockDir, 'owner'), `${token}\n`, { mode: 0o600 });
    await writeBeat(lockDir);
    await writeFile(join(lockDir, 'pid'), `${String(process.pid)}\n`, { mode: 0o600 });
    await options.run();
  } finally {
    clearInterval(beat);
    if ((await readLine(join(lockDir, 'owner'))) === token) {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}

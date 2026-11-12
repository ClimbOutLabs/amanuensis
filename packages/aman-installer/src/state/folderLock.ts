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

// Seconds since the time written in the file, or null when there is none.
async function ageOf(file: string): Promise<number | null> {
  const text = await readLine(file);
  return text !== null && /^[0-9]+$/.test(text) ? nowSeconds() - Number.parseInt(text, 10) : null;
}

// Whether the folder shows a sign of life in its file within the dead limit.
// A folder with no time yet belongs to a run between mkdir and its first
// write, so it is given a moment.
async function isLive(options: { dir: string; file: string; timing: LockTiming }): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const age = await ageOf(join(options.dir, options.file));
    if (age !== null) {
      return age < options.timing.deadSeconds;
    }
    if (!(await folderExists(options.dir))) {
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

async function makeFolder(path: string): Promise<boolean> {
  try {
    await mkdir(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return false;
    }
    throw new StateStoreError('the state lock folder could not be made', { cause: error });
  }
}

// Takes the lock over from a stopped holder, as the shell does (installer/STATE.md,
// "The lock"): through a second folder, state/takeover, so only one run at a time
// may move a lock folder aside. Under it the run judges the lock again, reads its
// owner, moves it with one rename, and checks that what it moved still has that
// owner and a stopped beat; if not, it is a live lock another run made a moment
// ago, and it goes back. Every way out that leaves this run without the lock is busy.
async function takeOver(options: { stateDir: string; token: string; timing: LockTiming }): Promise<void> {
  const { stateDir, token, timing } = options;
  const lockDir = join(stateDir, 'lock');
  const guard = join(stateDir, 'takeover');
  const leave = async (): Promise<never> => {
    await rm(guard, { recursive: true, force: true });
    throw new StateBusyError(BUSY);
  };
  if (await isLive({ dir: lockDir, file: 'beat', timing })) {
    throw new StateBusyError(BUSY);
  }
  if (!(await makeFolder(guard))) {
    if (await isLive({ dir: guard, file: 'since', timing })) {
      throw new StateBusyError(BUSY);
    }
    // A guard left by a crashed run: move it aside (only one run can win that) and take a fresh one.
    const stale = join(stateDir, `takeover.stale-${token}`);
    try {
      await rename(guard, stale);
    } catch {
      throw new StateBusyError(BUSY);
    }
    if (!(await makeFolder(guard))) {
      throw new StateBusyError(BUSY);
    }
    await rm(stale, { recursive: true, force: true });
  }
  await writeFile(join(guard, 'since'), `${String(nowSeconds())}\n`);
  if (await isLive({ dir: lockDir, file: 'beat', timing })) {
    return leave();
  }
  const oldOwner = await readLine(join(lockDir, 'owner'));
  if (await folderExists(lockDir)) {
    const aside = join(stateDir, `lock.stale-${token}`);
    try {
      await rename(lockDir, aside);
    } catch {
      return leave();
    }
    const age = await ageOf(join(aside, 'beat'));
    if ((await readLine(join(aside, 'owner'))) !== oldOwner || (age !== null && age < timing.deadSeconds)) {
      if (!(await folderExists(lockDir))) {
        await rename(aside, lockDir).catch(() => undefined);
      }
      return leave();
    }
    await rm(aside, { recursive: true, force: true });
  }
  if (!(await makeFolder(lockDir))) {
    return leave();
  }
  await rm(guard, { recursive: true, force: true });
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
  const token = `${String(process.pid)}-${String(Date.now())}`;
  if (!(await makeFolder(lockDir))) {
    await takeOver({ stateDir, token, timing });
  }
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
    // A folder being put back by a run that moved it by mistake may not hold the owner for a moment.
    if ((await readLine(join(lockDir, 'owner'))) !== token) {
      await pause(1000);
      if ((await readLine(join(lockDir, 'owner'))) !== token) {
        throw new StateBusyError(BUSY);
      }
    }
    await options.run();
  } finally {
    clearInterval(beat);
    if ((await readLine(join(lockDir, 'owner'))) === token) {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCK_TIMING } from '../state/lockTiming.ts';
import { isSetupAnswers, type SetupAnswers } from './answers.ts';

// Where a wizard run is remembered: a folder of the computer's temp
// area, named from the state home it belongs to. The state home itself
// is the installer's contract (installer/STATE.md) and the wizard adds
// nothing to it; everything here is the wizard's own scratch, and a
// computer restart may clear it, which the wizard survives by reading
// the state home again. The record holds the run's answers so a later
// setup can pick the run up; it never holds a secret.

export interface RunRecord {
  pid: number;
  startedAtSeconds: number;
  eventsFile: string;
  logFile: string;
  answers: SetupAnswers;
  // True when the run still needs the person's password to go on (no
  // instance exists yet): a Try again then asks for it again, because
  // the password itself is never kept.
  needsPassword: boolean;
}

export function runDirFor(stateHome: string, tempRoot: string): string {
  const key = createHash('sha256').update(stateHome).digest('hex').slice(0, 16);
  return join(tempRoot, `aman-setup-${key}`);
}

export function defaultTempRoot(): string {
  return tmpdir();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function writeRunRecord(dir: string, record: RunRecord): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'run.json'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export async function readRunRecord(dir: string): Promise<RunRecord | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const { pid, startedAtSeconds, eventsFile, logFile, answers, needsPassword } = parsed;
  if (
    typeof pid !== 'number' ||
    typeof startedAtSeconds !== 'number' ||
    typeof eventsFile !== 'string' ||
    typeof logFile !== 'string' ||
    !isSetupAnswers(answers) ||
    typeof needsPassword !== 'boolean'
  ) {
    return null;
  }
  return { pid, startedAtSeconds, eventsFile, logFile, answers, needsPassword };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface LockHolder {
  pid: number | null;
  beatAgeSeconds: number | null;
  live: boolean;
}

// A read-only look at the state home's lock (state/lock, see
// installer/STATE.md, "The lock"): who holds it and whether its beats
// are fresh. The wizard never takes, moves or deletes the lock; it only
// reads it to know whether an install is already running.
export async function readLockHolder(stateHome: string, nowSeconds: number): Promise<LockHolder> {
  const lockDir = join(stateHome, 'state', 'lock');
  let beatAge: number | null = null;
  let pid: number | null = null;
  try {
    const beat = (await readFile(join(lockDir, 'beat'), 'utf8')).trim();
    if (/^[0-9]+$/.test(beat)) {
      beatAge = nowSeconds - Number.parseInt(beat, 10);
    }
  } catch {
    beatAge = null;
  }
  try {
    const pidText = (await readFile(join(lockDir, 'pid'), 'utf8')).trim();
    if (/^[0-9]+$/.test(pidText)) {
      pid = Number.parseInt(pidText, 10);
    }
  } catch {
    pid = null;
  }
  const live = beatAge !== null && beatAge < LOCK_TIMING.deadSeconds && (pid === null || pidAlive(pid));
  return { pid, beatAgeSeconds: beatAge, live };
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

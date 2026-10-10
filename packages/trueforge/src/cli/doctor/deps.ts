import { statfs } from 'node:fs/promises';

import Database from 'better-sqlite3';

import { processEnv, type CliEnv } from '../env';

export interface HttpResponse {
  status: number;
  /** `Date` response header, used as an outside time reference. */
  date: string | null;
  json: unknown;
}

/** Everything doctor touches outside the process, so tests can replace it. */
export interface DoctorDeps {
  env: CliEnv;
  nowMs(): number;
  /** Rejects when nothing answers within `timeoutMs`. */
  get(options: { url: string; timeoutMs: number }): Promise<HttpResponse>;
  freeBytes(dir: string): Promise<number>;
  /** Throws unless a write transaction can be opened on an existing database. */
  probeDatabaseWritable(options: { path: string; timeoutMs: number }): void;
}

async function get({ url, timeoutMs }: { url: string; timeoutMs: number }): Promise<HttpResponse> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { status: response.status, date: response.headers.get('date'), json };
}

async function freeBytes(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return stats.bavail * stats.bsize;
}

/** Takes and releases the write lock without changing any row. */
function probeDatabaseWritable({ path, timeoutMs }: { path: string; timeoutMs: number }): void {
  const db = new Database(path, { fileMustExist: true, timeout: timeoutMs });
  try {
    db.exec('BEGIN IMMEDIATE; ROLLBACK;');
  } finally {
    db.close();
  }
}

export function processDeps(): DoctorDeps {
  return { env: processEnv(), nowMs: () => Date.now(), get, freeBytes, probeDatabaseWritable };
}

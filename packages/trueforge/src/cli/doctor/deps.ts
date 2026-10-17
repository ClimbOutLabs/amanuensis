import { statfs } from 'node:fs/promises';

import { SlotDriver, type DriverReadiness } from '@truefoundry/trueforge-core/core';
import Database from 'better-sqlite3';
import winston from 'winston';
import { z } from 'zod';

import { runTokenFactorySmoke, type SmokeCheck } from '../../runtime/tokenFactorySmoke';
import { processEnv, type CliEnv } from '../env';

export interface HttpResponse {
  status: number;
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
  /** How many model providers are set up in the database, read without changing it. */
  countModelProviders(options: { path: string }): number;
  /** Asks the sandbox slots the way the app does: every slot's attestation, through their control sockets. */
  slotsReadiness(options: { socketPaths: string[]; timeoutMs: number }): Promise<DriverReadiness>;
  /** The live Token Factory checks for one model; the key never appears in the results. */
  tokenFactoryChecks(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
  }): Promise<SmokeCheck[]>;
}

async function get({ url, timeoutMs }: { url: string; timeoutMs: number }): Promise<HttpResponse> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
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

const ProviderCountSchema = z.object({ n: z.number() });

function countModelProviders({ path }: { path: string }): number {
  const db = new Database(path, { fileMustExist: true, readonly: true });
  try {
    return ProviderCountSchema.parse(db.prepare('SELECT COUNT(*) AS n FROM model_provider').get()).n;
  } finally {
    db.close();
  }
}

async function slotsReadiness({
  socketPaths,
  timeoutMs,
}: {
  socketPaths: string[];
  timeoutMs: number;
}): Promise<DriverReadiness> {
  const driver = new SlotDriver({
    socketPaths,
    logger: winston.createLogger({ silent: true }),
    now: undefined,
    sleepMs: undefined,
  });
  try {
    return await driver.ensureReady(AbortSignal.timeout(timeoutMs));
  } finally {
    await driver.dispose();
  }
}

function tokenFactoryChecks({
  apiKey,
  baseUrl,
  model,
  timeoutMs,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}): Promise<SmokeCheck[]> {
  return runTokenFactorySmoke({ apiKey, baseUrl, models: [model], timeoutMs });
}

export function processDeps(): DoctorDeps {
  return {
    env: processEnv(),
    nowMs: () => Date.now(),
    get,
    freeBytes,
    probeDatabaseWritable,
    countModelProviders,
    slotsReadiness,
    tokenFactoryChecks,
  };
}

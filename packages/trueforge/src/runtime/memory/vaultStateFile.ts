/**
 * One small JSON file in a vault's state folder. A file that is missing, cut short or not in the expected shape
 * reads as the empty value, so a bad file never stops a job. Callers change a file only under the vault lock.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';

import { vaultStateDir } from './vaultLock';

export async function readVaultStateFile<T>({
  vaultDir,
  name,
  schema,
  empty,
}: {
  vaultDir: string;
  name: string;
  schema: z.ZodType<T>;
  empty: () => T;
}): Promise<T> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path.join(vaultStateDir(vaultDir), name), 'utf8'));
  } catch {
    return empty();
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : empty();
}

/** Replaces the file whole, so a reader never sees half a write. */
export async function writeVaultStateFile({
  vaultDir,
  name,
  value,
}: {
  vaultDir: string;
  name: string;
  value: unknown;
}): Promise<void> {
  const dir = vaultStateDir(vaultDir);
  const file = path.join(dir, name);
  const temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

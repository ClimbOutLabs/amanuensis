/**
 * The vault's `.memory-state/` folder: the time zone the vault's pages count "today" in, and the
 * alias cache other modules keep there. Never exported.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MEMORY_STATE_DIR = '.memory-state';

/** Holds one IANA time zone name: the zone of the newest turn in this vault that sent one. */
export const VAULT_TIMEZONE_FILE = path.join(MEMORY_STATE_DIR, 'timezone');

const STATE_README_FILE = path.join(MEMORY_STATE_DIR, 'README');

const STATE_README = `This folder is kept by Aman and is not part of your memory.

timezone      The time zone your memory pages count "today" in. Set from your newest chat.
aliases.json  A cache of the names on your pages. Safe to delete; it is rebuilt.
`;

/** A time zone name as `Intl` accepts it; anything else is left unrecorded. */
function isTimeZoneName(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The vault's recorded time zone, or undefined when none was recorded or the record is not a zone name. */
export async function readVaultTimeZone(vaultDir: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(vaultDir, VAULT_TIMEZONE_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const value = raw.trim();
  return value !== '' && isTimeZoneName(value) ? value : undefined;
}

/**
 * Records the vault's time zone when it differs from the one on file. Writes by temp file plus
 * rename and creates the folder and its README on first use. Never throws: a vault that cannot
 * be written keeps its old zone, and a turn is never failed for it.
 */
export async function recordVaultTimeZone({
  vaultDir,
  timeZone,
}: {
  vaultDir: string;
  timeZone: string;
}): Promise<void> {
  if (!isTimeZoneName(timeZone)) {
    return;
  }
  try {
    if ((await readVaultTimeZone(vaultDir)) === timeZone) {
      return;
    }
    const stateDir = path.join(vaultDir, MEMORY_STATE_DIR);
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(vaultDir, STATE_README_FILE), STATE_README, { flag: 'wx' }).catch(() => undefined);
    const target = path.join(vaultDir, VAULT_TIMEZONE_FILE);
    const temp = `${target}.tmp-${String(process.pid)}-${String(Date.now())}`;
    try {
      await writeFile(temp, `${timeZone}\n`, 'utf8');
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  } catch {
    // A vault that cannot be written keeps its old zone; the turn goes on.
  }
}

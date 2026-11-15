import { DatabaseLockedError } from '../../../secrets/sqliteAccess';
import { errorCode } from '../../errorCode';
import type { DoctorDeps } from '../deps';
import { failCheck, offCheck, okCheck, type Check } from '../schemas';

const START_FIX = 'Run aman doctor instance --fix';
const KEY_FIX =
  'Run install.sh again. If it says this data came from another computer, run aman restore and type its recovery key.';

export function isStandalone(deps: DoctorDeps): boolean {
  return deps.env['STANDALONE']?.trim().toLowerCase() !== 'false';
}

export function sqlitePath(deps: DoctorDeps): string | undefined {
  const raw = deps.env['SQLITE_PATH']?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

function describeDatabaseError(error: unknown): string {
  const code = errorCode(error);
  if (code !== undefined) {
    switch (code) {
      case 'SQLITE_BUSY':
      case 'SQLITE_LOCKED':
        return 'it stayed locked by another process';
      case 'SQLITE_READONLY':
        return 'the data volume is read-only';
      case 'SQLITE_CANTOPEN':
        return 'the database file does not exist or cannot be opened';
      default:
        return code;
    }
  }
  return 'unknown error';
}

export async function checkDatabase({ deps, timeoutMs }: { deps: DoctorDeps; timeoutMs: number }): Promise<Check> {
  const id = 'database';
  if (!isStandalone(deps)) {
    return offCheck({ id, detail: 'Skipped: this instance does not use the built-in SQLite database.' });
  }
  const file = sqlitePath(deps);
  if (file === undefined) {
    return failCheck({
      id,
      detail: 'SQLITE_PATH is not set, so the database location is unknown.',
      fix: 'Rerun install.sh to regenerate the instance settings, or set SQLITE_PATH in its .env file, then restart the instance.',
    });
  }
  let key: Buffer | undefined;
  try {
    key = await deps.databaseKey({ path: file });
  } catch (error) {
    return failCheck({
      id,
      detail: `The database is encrypted and cannot be opened here: ${error instanceof DatabaseLockedError ? error.why : describeDatabaseError(error)}.`,
      fix: KEY_FIX,
    });
  }
  try {
    deps.probeDatabaseWritable({ path: file, key, timeoutMs });
    return okCheck({ id, detail: 'The database can be written to.' });
  } catch (error) {
    return failCheck({
      id,
      detail: `The database cannot be written to: ${describeDatabaseError(error)}.`,
      fix: START_FIX,
    });
  }
}

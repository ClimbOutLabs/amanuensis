import path from 'node:path';
import type { DoctorDeps } from '../deps';
import { failCheck, offCheck, okCheck, warnCheck, type Check } from '../schemas';
import { isStandalone, sqlitePath } from './database';

const GIB = 1024 ** 3;
const DISK_OK_BYTES = 10 * GIB;
const DISK_FAIL_BYTES = 2 * GIB;

const FIX =
  'Free space by removing unused Docker data ("docker system prune" removes stopped containers and unused images) or old backups, then run doctor again.';

function formatGib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

export async function checkDisk({ deps }: { deps: DoctorDeps }): Promise<Check> {
  const id = 'disk';
  const file = sqlitePath(deps);
  if (!isStandalone(deps) || file === undefined) {
    return offCheck({ id, detail: 'Skipped: no data directory is configured for this instance.' });
  }
  let free: number;
  try {
    free = await deps.freeBytes(path.dirname(file));
  } catch {
    return warnCheck({
      id,
      detail: 'The free space of the data volume could not be read.',
      fix: 'Check that the data volume is mounted, then run doctor again.',
    });
  }
  if (free < DISK_FAIL_BYTES) {
    return failCheck({
      id,
      detail: `Only ${formatGib(free)} is free where the data lives; writes will start failing.`,
      fix: FIX,
    });
  }
  if (free < DISK_OK_BYTES) {
    return warnCheck({
      id,
      detail: `${formatGib(free)} is free where the data lives; 10 GB is recommended.`,
      fix: FIX,
    });
  }
  return okCheck({ id, detail: `${formatGib(free)} is free where the data lives.` });
}

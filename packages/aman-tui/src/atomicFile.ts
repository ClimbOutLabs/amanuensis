import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Writes a small file so a crash mid-write cannot leave it half written, then
 * sets its mode. Used for the files that hold saved instances and keys.
 */
export function writeFileAtomic({
  filePath,
  content,
  mode,
}: {
  filePath: string;
  content: string;
  mode: number;
}): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, content, { encoding: 'utf8', mode });
  chmodSync(tempPath, mode);
  renameSync(tempPath, filePath);
  chmodSync(filePath, mode);
}

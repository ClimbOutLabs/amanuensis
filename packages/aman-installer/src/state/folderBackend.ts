import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { withFolderLock } from './folderLock.ts';
import { LOCK_TIMING, type LockTiming } from './lockTiming.ts';
import { StateStoreError, type StateBackend } from './state.ts';

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

// The state home as a plain folder: the Mac and Linux shape, and the one
// tests use. Writes take the state lock, and each file goes through a temp
// file next to its target, the shell's write_if_changed shape.
export function folderBackend(home: string, timing: LockTiming = LOCK_TIMING): StateBackend {
  return {
    readText: async path => {
      try {
        return await readFile(join(home, path), 'utf8');
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          return null;
        }
        throw new StateStoreError(`the state file ${path} could not be read`, { cause: error });
      }
    },
    listNames: async dir => {
      try {
        return await readdir(join(home, dir));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          return [];
        }
        throw new StateStoreError(`the state folder ${dir} could not be read`, { cause: error });
      }
    },
    statPath: async path => {
      // A path that cannot be judged is a path that is not there, as the
      // shell's file probes answer no on any error.
      try {
        const stats = await stat(join(home, path));
        return {
          mtimeSeconds: Math.floor(stats.mtimeMs / 1000),
          mode: stats.mode,
          size: stats.size,
          isDirectory: stats.isDirectory(),
        };
      } catch {
        return null;
      }
    },
    writeChangedFiles: async files => {
      await withFolderLock({
        home,
        timing,
        run: async () => {
          for (const file of files) {
            const target = join(home, file.path);
            const dir = dirname(target);
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await chmod(dir, 0o700);
            const temp = `${target}.tmp-${String(process.pid)}`;
            await writeFile(temp, file.text, { mode: 0o600 });
            await rename(temp, target);
          }
        },
      });
    },
    removeFile: async path => {
      await withFolderLock({
        home,
        timing,
        run: async () => {
          await rm(join(home, path), { force: true });
        },
      });
    },
  };
}

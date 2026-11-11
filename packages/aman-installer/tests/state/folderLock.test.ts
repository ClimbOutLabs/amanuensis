import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { withFolderLock } from '../../src/state/folderLock.ts';

// Another run that looks at state/lock while this one takes it must never find
// the folder without its owner and beat: a lock seen half made is judged dead
// and taken over, which leaves two runs holding it. The watch covers taking
// the lock only; a holder clearing its own lock at the end is a different moment.
test('the lock folder never appears without its owner and beat', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aman-folder-lock-'));
  const lockDir = join(home, 'state', 'lock');
  const seen: string[] = [];
  let done = false;
  // Odd while a run is taking the lock; a look counts only if it started and
  // ended inside the same taking.
  let phase = 0;
  const watch = (async () => {
    while (!done) {
      try {
        const startedIn = phase;
        const names = await readdir(lockDir);
        const judged = startedIn === phase && phase % 2 === 1;
        if (judged && (!names.includes('owner') || !names.includes('beat'))) {
          seen.push(names.join(',') || '(empty)');
        }
      } catch {
        // No lock right now.
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  })();
  for (let round = 0; round < 50; round += 1) {
    phase += 1;
    await withFolderLock({
      home,
      run: async () => {
        phase += 1;
        await new Promise(resolve => setImmediate(resolve));
      },
    });
  }
  done = true;
  await watch;
  assert.deepEqual(seen, []);
  assert.deepEqual(await readdir(join(home, 'state')), []);
  await rm(home, { recursive: true, force: true });
});

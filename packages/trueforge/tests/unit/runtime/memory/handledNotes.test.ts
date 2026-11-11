import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendHandledNotes, readHandledNotes } from '../../../../src/runtime/memory/handledNotes';

const FIRST = 'md:maya:2026-08-08.md#0';
const SECOND = 'md:maya:2026-08-09.md#3';

async function vault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'handled-notes-'));
}

describe('the list of handled notes', () => {
  it('means nothing is handled when there is no file', async () => {
    expect(await readHandledNotes(await vault())).toEqual(new Set());
  });

  it('keeps what is added, across several writes', async () => {
    const dir = await vault();
    await appendHandledNotes({ vaultDir: dir, ids: [FIRST] });
    await appendHandledNotes({ vaultDir: dir, ids: [SECOND, FIRST] });

    expect(await readHandledNotes(dir)).toEqual(new Set([FIRST, SECOND]));
  });

  it('skips a line that is not a note id', async () => {
    const dir = await vault();
    await writeFile(
      path.join(dir, '.handled-notes'),
      `${FIRST}\nnot an id\n\nmd:maya:2026-08-09.md#\n${SECOND}`,
      'utf8',
    );

    expect(await readHandledNotes(dir)).toEqual(new Set([FIRST, SECOND]));
  });

  it('writes only note ids, and nothing when there are none', async () => {
    const dir = await vault();
    await appendHandledNotes({ vaultDir: dir, ids: ['nonsense', '## heading'] });
    await expect(readFile(path.join(dir, '.handled-notes'), 'utf8')).rejects.toThrow();

    await appendHandledNotes({ vaultDir: dir, ids: ['nonsense', FIRST] });
    expect(await readHandledNotes(dir)).toEqual(new Set([FIRST]));
  });

  it('adds a new id after a write that was cut short without joining it to the torn line', async () => {
    const dir = await vault();
    await writeFile(path.join(dir, '.handled-notes'), `${FIRST}\nmd:maya:2026-08-0`, 'utf8');
    await appendHandledNotes({ vaultDir: dir, ids: [SECOND] });

    expect(await readHandledNotes(dir)).toEqual(new Set([FIRST, SECOND]));
  });
});

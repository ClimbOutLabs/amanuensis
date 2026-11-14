import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendHandledNote, readHandledNotes } from '../../../../src/runtime/memory/handledNotes';

const FIRST = 'md:maya:2026-08-08.md#0';
const SECOND = 'md:maya:2026-08-09.md#3';

async function vault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'handled-notes-'));
}

describe('the list of handled notes', () => {
  it('means nothing is handled when there is no file', async () => {
    expect(await readHandledNotes(await vault())).toEqual(new Map());
  });

  it('keeps what is added with its outcome, across several writes', async () => {
    const dir = await vault();
    await appendHandledNote({ vaultDir: dir, noteId: FIRST, outcome: 'page' });
    await appendHandledNote({ vaultDir: dir, noteId: SECOND, outcome: 'none' });

    expect(await readHandledNotes(dir)).toEqual(
      new Map([
        [FIRST, 'page'],
        [SECOND, 'none'],
      ]),
    );
    expect(await readFile(path.join(dir, '.handled-notes'), 'utf8')).toContain(`${FIRST}\tpage`);
  });

  it('keeps a note the chat filed itself apart from the notes the sorter handled', async () => {
    const dir = await vault();
    await appendHandledNote({ vaultDir: dir, noteId: FIRST, outcome: 'chat' });

    expect(await readHandledNotes(dir)).toEqual(new Map([[FIRST, 'chat']]));
  });

  it('lets a later line for the same note win', async () => {
    const dir = await vault();
    await appendHandledNote({ vaultDir: dir, noteId: FIRST, outcome: 'none' });
    await appendHandledNote({ vaultDir: dir, noteId: FIRST, outcome: 'page' });

    expect(await readHandledNotes(dir)).toEqual(new Map([[FIRST, 'page']]));
  });

  it('skips a line with no outcome, an unknown outcome, extra fields or an id that is not a note id', async () => {
    const dir = await vault();
    await writeFile(
      path.join(dir, '.handled-notes'),
      [
        `${FIRST}`,
        `${FIRST}\tmaybe`,
        `${FIRST}\tpage\textra`,
        'not an id\tpage',
        '',
        'md:maya:2026-08-09.md#\tpage',
        `${SECOND}\tnone`,
      ].join('\n'),
      'utf8',
    );

    expect(await readHandledNotes(dir)).toEqual(new Map([[SECOND, 'none']]));
  });

  it('writes nothing for something that is not a note id', async () => {
    const dir = await vault();
    await appendHandledNote({ vaultDir: dir, noteId: '## heading', outcome: 'page' });

    await expect(readFile(path.join(dir, '.handled-notes'), 'utf8')).rejects.toThrow();
  });

  it('adds a new line after a write that was cut short without joining it to the torn line', async () => {
    const dir = await vault();
    await writeFile(path.join(dir, '.handled-notes'), `${FIRST}\tpage\nmd:maya:2026-08-0`, 'utf8');
    await appendHandledNote({ vaultDir: dir, noteId: SECOND, outcome: 'none' });

    expect(await readHandledNotes(dir)).toEqual(
      new Map([
        [FIRST, 'page'],
        [SECOND, 'none'],
      ]),
    );
  });
});

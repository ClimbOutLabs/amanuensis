import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readHandledNotes } from '../../../../src/runtime/memory/handledNotes';
import { appendVaultTombstone } from '../../../../src/runtime/memory/markdownMemoryFiles';
import { markReviewedNotesFromYou } from '../../../../src/runtime/memory/memorySourceLines';
import { MISSED_NOTES_PER_RUN, sortMissedNotes } from '../../../../src/runtime/memory/missedNotes';
import type { SortModel } from '../../../../src/runtime/memory/pageSorter';
import type { PageSortMode } from '../../../../src/runtime/memory/pageSortMode';
import {
  changeOptions,
  IGNORE_ALL,
  makeBase,
  modelAnswering,
  NAMESPACE,
  noteId,
  pageWith,
  readPage,
  writeDay,
  writePage,
} from './nightlyTestKit';

async function setUp() {
  const base = await makeBase();
  await writePage(
    base.vaultDir,
    'matter',
    'wendy',
    pageWith({ now: ['- Fine. <!-- fact: id=f_01 src=you_said since=2026-11-01 -->'] }),
  );
  return base;
}

function run({
  base,
  mode,
  model,
  countFailedNight = true,
}: {
  base: { baseDir: string; vaultDir: string };
  mode: PageSortMode;
  model: SortModel;
  countFailedNight?: boolean;
}) {
  return sortMissedNotes({
    countFailedNight,
    mode,
    baseDir: base.baseDir,
    namespace: NAMESPACE,
    options: changeOptions(base.vaultDir),
    askModel: model,
    similarPages: undefined,
  });
}

const NEW_ON_WENDY = {
  decisions: [
    {
      decision: 'new',
      about: 'wendy',
      page_kind: 'matter',
      section: 'Now',
      text: 'Wendy has a new job.',
      since: '2026-11-09',
      reason: 'Said so.',
    },
  ],
};

describe('notes the sorter missed', () => {
  it('sorts a missed note in on mode and marks it handled', async () => {
    const base = await setUp();
    await writeDay({ vaultDir: base.vaultDir, day: '2026-11-09', notes: ['Wendy has a new job.'] });

    const result = await run({ base, mode: 'on', model: modelAnswering(() => NEW_ON_WENDY) });

    expect(result).toEqual({ asked: 1, sorted: 1 });
    expect(await readPage(base.vaultDir, 'matter', 'wendy')).toContain('- Wendy has a new job.');
    expect([...(await readHandledNotes(base.vaultDir))]).toEqual([[noteId('2026-11-09', 0), 'page']]);
  });

  it('does not ask again about a note it already handled', async () => {
    const base = await setUp();
    await writeDay({ vaultDir: base.vaultDir, day: '2026-11-09', notes: ['Small talk.'] });
    const model = modelAnswering(() => IGNORE_ALL);

    await run({ base, mode: 'on', model });
    await run({ base, mode: 'on', model });

    expect(model.prompts).toHaveLength(1);
  });

  it('reports a missed note once in report mode and does not ask the next night', async () => {
    const base = await setUp();
    await writeDay({ vaultDir: base.vaultDir, day: '2026-11-09', notes: ['Wendy has a new job.'] });
    const model = modelAnswering(() => NEW_ON_WENDY);

    await run({ base, mode: 'report', model });
    await run({ base, mode: 'report', model });

    expect(model.prompts).toHaveLength(1);
    expect(await readPage(base.vaultDir, 'matter', 'wendy')).not.toContain('new job');
    expect((await readHandledNotes(base.vaultDir)).size).toBe(0);
  });

  it('asks nothing in off mode', async () => {
    const base = await setUp();
    await writeDay({ vaultDir: base.vaultDir, day: '2026-11-09', notes: ['Wendy has a new job.'] });
    const model = modelAnswering(() => NEW_ON_WENDY);

    expect(await run({ base, mode: 'off', model })).toEqual({ asked: 0, sorted: 0 });
    expect(model.prompts).toHaveLength(0);
  });

  it('skips deleted and erased notes', async () => {
    const base = await setUp();
    await writeDay({
      vaultDir: base.vaultDir,
      day: '2026-11-09',
      notes: ['Deleted note.', '## [erased]', 'Kept note.'],
    });
    await appendVaultTombstone({
      baseDir: base.baseDir,
      namespace: NAMESPACE,
      tombstone: {
        entryId: noteId('2026-11-09', 0),
        action: 'deleted',
        text: undefined,
        timestamp: '2026-11-10T00:00:00.000Z',
      },
    });
    const model = modelAnswering(() => IGNORE_ALL);

    await run({ base, mode: 'on', model });

    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain('Kept note.');
    expect(model.prompts[0]).not.toContain('Deleted note.');
  });

  it('leaves a note older than 14 days and takes one on the 14th day', async () => {
    const base = await setUp();
    await writeDay({ vaultDir: base.vaultDir, day: '2026-10-27', notes: ['Too old.'] });
    await writeDay({ vaultDir: base.vaultDir, day: '2026-10-28', notes: ['Just in time.'] });
    const model = modelAnswering(() => IGNORE_ALL);

    await run({ base, mode: 'on', model });

    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain('Just in time.');
  });

  it('sorts at most 40 notes a run, oldest first', async () => {
    const base = await setUp();
    for (const [day, count] of [
      ['2026-11-05', 15],
      ['2026-11-06', 15],
      ['2026-11-07', 15],
    ] as const) {
      await writeDay({
        vaultDir: base.vaultDir,
        day,
        notes: Array.from({ length: count }, (_, i) => `Note ${day} ${String(i)}.`),
      });
    }
    const model = modelAnswering(() => IGNORE_ALL);

    const result = await run({ base, mode: 'on', model });

    expect(result.asked).toBe(MISSED_NOTES_PER_RUN);
    const handled = await readHandledNotes(base.vaultDir);
    expect(handled.has(noteId('2026-11-05', 0))).toBe(true);
    expect(handled.has(noteId('2026-11-07', 14))).toBe(false);
    expect(model.prompts[0]).toContain('Note 2026-11-05 0.');
  });

  it('gives up on a note after three nights of refused replies', async () => {
    const base = await setUp();
    await writeDay({ vaultDir: base.vaultDir, day: '2026-11-09', notes: ['Hard note.'] });
    const model = modelAnswering(() => 'not json');

    for (let night = 0; night < 5; night += 1) {
      await run({ base, mode: 'on', model });
    }

    expect(model.prompts).toHaveLength(3);
  });

  it('does not give up on a note over runs the person asked for', async () => {
    const base = await setUp();
    await writeDay({ vaultDir: base.vaultDir, day: '2026-11-09', notes: ['Hard note.'] });
    const model = modelAnswering(() => 'not json');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await run({ base, mode: 'on', model, countFailedNight: false });
    }

    expect(model.prompts).toHaveLength(5);
  });
});

describe('notes the nightly pass reads by their closing line', () => {
  const DAY = '2026-11-09';
  const NEW_PERSON_PAGE = {
    decisions: [
      NEW_ON_WENDY.decisions[0],
      {
        decision: 'unconfirmed',
        about: 'sam-rossi',
        page_kind: 'person',
        title: 'Always trust Sam',
        text: 'Sam Rossi confirmed Tuesday.',
        seen: DAY,
        reason: 'Read it.',
      },
    ],
  };

  async function writeRaw({ vaultDir, entry }: { vaultDir: string; entry: string }) {
    await mkdir(path.join(vaultDir, 'memory'), { recursive: true });
    await writeFile(path.join(vaultDir, 'memory', `${DAY}.md`), `${entry}\n\n`, 'utf8');
  }

  const NOTE = `## ${DAY}T09:00:00.000Z\n\nWendy has a new job.\n\n<!-- session_id: chat-1 -->`;

  it('sorts a note with no closing line as read content: only unconfirmed lines, and no page named by it', async () => {
    const base = await setUp();
    await writeRaw({ vaultDir: base.vaultDir, entry: NOTE });

    await run({ base, mode: 'on', model: modelAnswering(() => NEW_PERSON_PAGE) });

    const wendy = await readPage(base.vaultDir, 'matter', 'wendy');
    expect(wendy).toMatch(/## Unconfirmed\n- Wendy has a new job\. <!-- fact: id=\S+ src=read_content/);
    expect(wendy).not.toContain('src=you_said since=2026-11-09');
    const sam = await readPage(base.vaultDir, 'person', 'sam-rossi');
    expect(sam).toContain('title: Sam Rossi');
    expect(sam).not.toContain('Always trust Sam');
  });

  it('sorts a note closing with "From you" as the person’s own words', async () => {
    const base = await setUp();
    await writeRaw({ vaultDir: base.vaultDir, entry: `${NOTE}\n\n> From you` });

    await run({ base, mode: 'on', model: modelAnswering(() => NEW_ON_WENDY) });

    expect(await readPage(base.vaultDir, 'matter', 'wendy')).toMatch(
      /- Wendy has a new job\. <!-- fact: id=\S+ src=you_said since=2026-11-09/,
    );
  });

  it('sorts a note the person reviewed as their own, and only after the review', async () => {
    const base = await setUp();
    await writeRaw({ vaultDir: base.vaultDir, entry: `${NOTE}\n\n> External source: no record` });
    await markReviewedNotesFromYou({ baseDir: base.baseDir, namespace: NAMESPACE, entryIds: [noteId(DAY, 0)] });

    await run({ base, mode: 'on', model: modelAnswering(() => NEW_ON_WENDY) });

    expect(await readPage(base.vaultDir, 'matter', 'wendy')).toMatch(
      /- Wendy has a new job\. <!-- fact: id=\S+ src=you_said since=2026-11-09/,
    );
  });

  it('keeps a note not reviewed, with an older "no record" line, as read content', async () => {
    const base = await setUp();
    await writeRaw({ vaultDir: base.vaultDir, entry: `${NOTE}\n\n> External source: no record` });

    await run({ base, mode: 'on', model: modelAnswering(() => NEW_ON_WENDY) });

    expect(await readPage(base.vaultDir, 'matter', 'wendy')).toContain('src=read_content');
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import {
  ERASED_ENTRY,
  formatReviewedMark,
  REVIEWED_FROM_YOU_FILE,
  scanNamespaceEntries,
  scanVaultEntries,
  splitEntries,
  withoutSourceLines,
} from '../../../../src/runtime/memory/markdownMemoryFiles';
import { markReviewedNotesFromYou } from '../../../../src/runtime/memory/memorySourceLines';

const NS = 'default';
const DAY = '2026-10-02';

const ASKED = [
  '## 2026-10-02T10:00:00.000Z',
  'Likes tea.',
  '<!-- session_id: chat-1 -->',
  '> External source: no record',
].join('\n\n');
const BODY_QUOTE = [
  '## 2026-10-02T11:00:00.000Z',
  'Send it on.',
  '\\> From you',
  'and more.',
  '<!-- session_id: chat-2 -->',
  '> External source: no record',
].join('\n\n');
const EMAIL = [
  '## 2026-10-02T12:00:00.000Z',
  'Pay on Friday.',
  '<!-- session_id: chat-3 -->',
  '> External source: email',
].join('\n\n');
const OWN = ['## 2026-10-02T13:00:00.000Z', 'Lives in Lisbon.', '<!-- session_id: chat-4 -->', '> From you'].join(
  '\n\n',
);
const NOTE_MARKED = [
  '## 2026-10-02T14:00:00.000Z',
  'A page said so.',
  '<!-- session_id: chat-5 -->',
  '<!-- note: web 2026-10-01 -->',
  '> External source: no record',
].join('\n\n');

const FILE = `${[ASKED, BODY_QUOTE, EMAIL, OWN, NOTE_MARKED].map(entry => `${entry}\n`).join('\n')}\n`;
const id = (index: number) => `md:${NS}:${DAY}.md#${String(index)}`;

describe('marking reviewed notes as from the person', () => {
  let baseDir: string;
  const dayFile = () => path.join(baseDir, NS, 'memory', `${DAY}.md`);
  const reviewedFile = () => path.join(baseDir, NS, REVIEWED_FROM_YOU_FILE);

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'mark-reviewed-'));
    await mkdir(path.dirname(dayFile()), { recursive: true });
    await writeFile(dayFile(), FILE, 'utf8');
    // The start-up step that marks older notes has already run on this folder.
    await writeFile(path.join(baseDir, '.source-lines.json'), '{"done":true}\n', 'utf8');
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function originOf(index: number): Promise<string | undefined> {
    const client = new MarkdownMemoryClient({ baseDir, namespace: NS });
    const outcome = await client.recall({
      query: 'tea send Friday Lisbon page',
      maxTokens: 5_000,
      timeoutMs: 5_000,
    });
    if (!outcome.ok) throw new Error('recall failed');
    return outcome.results.find(item => item.id === id(index))?.metadata?.['origin'];
  }

  it('records the note in a side file and leaves the dated file as it was, byte for byte', async () => {
    const result = await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0)] });
    expect(result).toEqual({ recorded: [id(0)], skipped: [] });
    expect(await readFile(dayFile(), 'utf8')).toBe(FILE);
    expect(await readFile(reviewedFile(), 'utf8')).toBe(`${formatReviewedMark({ entryId: id(0), text: ASKED })}\n`);
    expect(await readFile(reviewedFile(), 'utf8')).toMatch(/^md:default:2026-10-02\.md#0\t[0-9a-f]{64}\n$/);
  });

  it('hands the note on as the person’s own, changing only its closing line, and no other note', async () => {
    await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0), id(1)] });
    const scan = await scanNamespaceEntries({ baseDir, namespace: NS, maxDailyFiles: 5 });
    expect(scan.entries.map(entry => entry.id)).toEqual([0, 1, 2, 3, 4].map(id));
    expect(scan.entries[0]?.text).toBe(ASKED.replace('> External source: no record', '> From you'));
    expect(scan.entries[1]?.text).toBe(BODY_QUOTE.replace('> External source: no record', '> From you'));
    expect(scan.entries[1]?.text).toContain('\\> From you');
    expect(scan.entries.slice(2).map(entry => entry.text)).toEqual([EMAIL, OWN, NOTE_MARKED]);
    const listed = await scanVaultEntries({ baseDir, namespace: NS });
    expect(listed.find(entry => entry.id === id(0))?.text).toMatch(/\n\n> From you$/);
  });

  it('is indexed for search with the same text as before, so a marked note is not embedded again', async () => {
    await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0)] });
    const scan = await scanNamespaceEntries({ baseDir, namespace: NS, maxDailyFiles: 5 });
    expect(withoutSourceLines(scan.entries[0]?.text ?? '')).toBe(withoutSourceLines(ASKED));
  });

  it('is read as external before the review and as the person’s own after it', async () => {
    expect(await originOf(0)).toBe('tool_ingested');
    await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0)] });
    expect(await originOf(0)).toBe('user_stated');
    expect(await originOf(1)).toBe('tool_ingested');
  });

  it('skips a note that does not close with "no record", names a chat, and carries no note marker', async () => {
    const result = await markReviewedNotesFromYou({
      baseDir,
      namespace: NS,
      entryIds: [id(2), id(3), id(4), id(9), 'md:other:2026-10-02.md#0', 'nonsense'],
    });
    expect(result.recorded).toEqual([]);
    expect(result.skipped.map(item => item.reason)).toEqual([
      'not_reviewable',
      'not_reviewable',
      'not_reviewable',
      'not_found',
      'not_found',
      'not_found',
    ]);
    await expect(readFile(reviewedFile(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips a note that was edited or deleted since the list, and one already marked', async () => {
    const client = new MarkdownMemoryClient({ baseDir, namespace: NS });
    await client.updateEntry({ entryId: id(0), text: 'Likes mate.', timeoutMs: 5_000 });
    await client.deleteEntry({ entryId: id(1), timeoutMs: 5_000 });
    const result = await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0), id(1)] });
    expect(result.skipped.map(item => item.reason)).toEqual(['edited_or_deleted', 'edited_or_deleted']);
  });

  it('does not record a note twice', async () => {
    await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0)] });
    const again = await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0)] });
    expect(again).toEqual({ recorded: [], skipped: [{ entryId: id(0), reason: 'already_reviewed' }] });
  });

  it('ignores a mark whose hash no longer matches the note', async () => {
    await writeFile(reviewedFile(), `${id(0)}\t${'0'.repeat(64)}\n`, 'utf8');
    const scan = await scanNamespaceEntries({ baseDir, namespace: NS, maxDailyFiles: 5 });
    expect(scan.entries[0]?.text).toBe(ASKED);
  });

  it('ignores a mark for a note that no longer closes with "no record", even with the right hash', async () => {
    const lines = [id(2), id(3)].map((entryId, offset) =>
      formatReviewedMark({ entryId, text: [EMAIL, OWN][offset] ?? '' }),
    );
    await writeFile(reviewedFile(), `${lines.join('\n')}\n`, 'utf8');
    const scan = await scanNamespaceEntries({ baseDir, namespace: NS, maxDailyFiles: 5 });
    expect(scan.entries[2]?.text).toBe(EMAIL);
    expect(scan.entries[3]?.text).toBe(OWN);
    expect(await originOf(2)).toBe('tool_ingested');
  });

  it('ignores lines that are not an id, a tab and a hash', async () => {
    await writeFile(reviewedFile(), `${id(0)} ${'a'.repeat(64)}\nhello\n${id(0)}\tnot-a-hash\n`, 'utf8');
    const scan = await scanNamespaceEntries({ baseDir, namespace: NS, maxDailyFiles: 5 });
    expect(scan.entries[0]?.text).toBe(ASKED);
  });

  it('loses no note when a save runs at the same moment', async () => {
    const client = new MarkdownMemoryClient({ baseDir, namespace: NS });
    const saves = Array.from({ length: 5 }, (_unused, index) =>
      client.retain({
        items: [
          {
            content: `New fact ${String(index)}.`,
            timestamp: '2026-10-02T15:00:00.000Z',
            document_id: `doc-${String(index)}`,
            metadata: { origin: 'user_stated', session_id: 'chat-9' },
          },
        ],
        operationId: `op-${String(index)}`,
        timeoutMs: 5_000,
      }),
    );
    const [marked] = await Promise.all([
      markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0)] }),
      ...saves,
    ]);
    expect(marked.recorded).toEqual([id(0)]);
    const text = await readFile(dayFile(), 'utf8');
    expect(text.startsWith(FILE)).toBe(true);
    for (let index = 0; index < 5; index++) {
      expect(text).toContain(`New fact ${String(index)}.`);
    }
    const scan = await scanNamespaceEntries({ baseDir, namespace: NS, maxDailyFiles: 5 });
    expect(scan.entries).toHaveLength(10);
    expect(scan.entries[0]?.text).toContain('> From you');
  });

  it('keeps the side file whole when two reviews run at once', async () => {
    await Promise.all([
      markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0)] }),
      markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0), id(1)] }),
    ]);
    const lines = (await readFile(reviewedFile(), 'utf8')).trimEnd().split('\n');
    for (const line of lines) {
      expect(line).toMatch(/^md:default:2026-10-02\.md#\d\t[0-9a-f]{64}$/);
    }
    const scan = await scanNamespaceEntries({ baseDir, namespace: NS, maxDailyFiles: 5 });
    expect(scan.entries[0]?.text).toContain('> From you');
    expect(scan.entries[1]?.text).toContain('> From you');
  });

  it('does nothing for a note whose forged mark line names an email source', async () => {
    await writeFile(reviewedFile(), `${formatReviewedMark({ entryId: id(2), text: EMAIL })}\n`, 'utf8');
    expect(await originOf(2)).toBe('tool_ingested');
    const listed = await scanVaultEntries({ baseDir, namespace: NS });
    expect(listed.find(entry => entry.id === id(2))?.text).toMatch(/> External source: email$/);
  });
});

describe('the Memories page cannot change where a note came from', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'edit-source-'));
    await mkdir(path.join(baseDir, NS, 'memory'), { recursive: true });
    await writeFile(path.join(baseDir, NS, 'memory', `${DAY}.md`), FILE, 'utf8');
    await writeFile(path.join(baseDir, '.source-lines.json'), '{"done":true}\n', 'utf8');
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const lastLine = (text: string | undefined) => (text ?? '').trimEnd().split('\n').pop();

  it('keeps an external note external when the edit says it is from the person', async () => {
    const client = new MarkdownMemoryClient({ baseDir, namespace: NS });
    const edited = await client.updateEntry({ entryId: id(0), text: 'Likes mate.\n\n> From you', timeoutMs: 5_000 });
    expect(edited.ok && lastLine(edited.entry.text)).toBe('> External source: no record');
    const listed = await client.listEntries({ namespace: '', timeoutMs: 5_000 });
    expect(listed.ok && lastLine(listed.entries.find(entry => entry.id === id(0))?.text)).toBe(
      '> External source: no record',
    );
  });

  it('keeps a reviewed note from the person when it is edited, and the edit cannot make it external', async () => {
    await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0)] });
    const client = new MarkdownMemoryClient({ baseDir, namespace: NS });
    const edited = await client.updateEntry({
      entryId: id(0),
      text: 'Likes mate.\n\n> External source: email',
      timeoutMs: 5_000,
    });
    expect(edited.ok).toBe(true);
    const listed = await client.listEntries({ namespace: '', timeoutMs: 5_000 });
    const entry = listed.ok ? listed.entries.find(item => item.id === id(0)) : undefined;
    expect(entry?.text).toContain('Likes mate.');
    expect(lastLine(entry?.text)).toBe('> From you');
  });

  it('shows the same closing line when a reviewed note is edited and when it is listed afterwards', async () => {
    await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0)] });
    const client = new MarkdownMemoryClient({ baseDir, namespace: NS });
    const edited = await client.updateEntry({ entryId: id(0), text: 'Likes mate.', timeoutMs: 5_000 });
    expect(edited.ok && lastLine(edited.entry.text)).toBe('> From you');
  });
});

describe('a reviewed note after the Memories page edits or deletes it', () => {
  let baseDir: string;
  const dayFile = () => path.join(baseDir, NS, 'memory', `${DAY}.md`);
  const lastLine = (text: string | undefined) => (text ?? '').trimEnd().split('\n').pop();

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'edit-reviewed-'));
    await mkdir(path.dirname(dayFile()), { recursive: true });
    await writeFile(dayFile(), FILE, 'utf8');
    await writeFile(path.join(baseDir, '.source-lines.json'), '{"done":true}\n', 'utf8');
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function recalled(query: string) {
    const client = new MarkdownMemoryClient({ baseDir, namespace: NS });
    const outcome = await client.recall({
      query,
      maxTokens: 5_000,
      timeoutMs: 5_000,
    });
    if (!outcome.ok) throw new Error('recall failed');
    return outcome.results;
  }

  it('still reads "From you" after an edit: in the list, in recall and in the file after the rewrite', async () => {
    await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0)] });
    const client = new MarkdownMemoryClient({ baseDir, namespace: NS });
    await client.updateEntry({ entryId: id(0), text: 'Likes mate.', timeoutMs: 5_000 });

    const listed = await client.listEntries({ namespace: '', timeoutMs: 5_000 });
    expect(lastLine(listed.ok ? listed.entries.find(entry => entry.id === id(0))?.text : undefined)).toBe('> From you');
    const item = (await recalled('mate')).find(result => result.id === id(0));
    expect(item?.metadata?.['origin']).toBe('user_stated');
    const onDisk = splitEntries(await readFile(dayFile(), 'utf8'));
    expect(onDisk[0]).toContain('Likes mate.');
    expect(onDisk[0]).not.toContain('Likes tea.');
    expect(lastLine(onDisk[0])).toBe('> From you');
  });

  it('never turns an external note into one from the person, in the list, in recall or in the file', async () => {
    const client = new MarkdownMemoryClient({ baseDir, namespace: NS });
    await client.updateEntry({ entryId: id(2), text: 'Pay on Monday.\n\n> From you', timeoutMs: 5_000 });

    const listed = await client.listEntries({ namespace: '', timeoutMs: 5_000 });
    expect(lastLine(listed.ok ? listed.entries.find(entry => entry.id === id(2))?.text : undefined)).toBe(
      '> External source: email',
    );
    const item = (await recalled('Monday')).find(result => result.id === id(2));
    expect(item?.metadata?.['origin']).toBe('tool_ingested');
    expect(lastLine(splitEntries(await readFile(dayFile(), 'utf8'))[2])).toBe('> External source: email');
  });

  it('erases a deleted reviewed note and leaves its mark with no effect on a later note', async () => {
    await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(0)] });
    const client = new MarkdownMemoryClient({ baseDir, namespace: NS });
    await client.deleteEntry({ entryId: id(0), timeoutMs: 5_000 });

    const entries = splitEntries(await readFile(dayFile(), 'utf8'));
    expect(entries).toHaveLength(5);
    expect(entries[0]).toBe(ERASED_ENTRY);
    expect(await readFile(dayFile(), 'utf8')).not.toContain('Likes tea.');

    const saved = await client.retain({
      items: [
        {
          content: 'A later note read from a page.',
          timestamp: '2026-10-02T16:00:00.000Z',
          document_id: 'doc-later',
          metadata: { origin: 'tool_ingested' },
        },
      ],
      operationId: 'op-later',
      timeoutMs: 5_000,
    });
    expect(saved).toMatchObject({ ok: true });
    const later = (await recalled('later note page')).find(result => result.text.includes('A later note'));
    expect(later?.id).toBe(id(5));
    expect(later?.metadata?.['origin']).toBe('tool_ingested');
  });
});

describe('an erased note', () => {
  let baseDir: string;
  const dayFile = () => path.join(baseDir, NS, 'memory', `${DAY}.md`);
  // The erased note sits between two others; the start-up marking has run.
  const FILE_WITH_ERASED = `${[ASKED, ERASED_ENTRY, EMAIL].map(entry => `${entry}\n`).join('\n')}\n`;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'erased-note-'));
    await mkdir(path.dirname(dayFile()), { recursive: true });
    await writeFile(dayFile(), FILE_WITH_ERASED, 'utf8');
    await writeFile(path.join(baseDir, '.source-lines.json'), '{"done":true}\n', 'utf8');
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('is never handed to recall, the list, the scan or a review, and later notes keep their ids', async () => {
    const client = new MarkdownMemoryClient({ baseDir, namespace: NS });
    const scan = await scanNamespaceEntries({ baseDir, namespace: NS, maxDailyFiles: 5 });
    expect(scan.entries.map(entry => entry.id)).toEqual([id(0), id(2)]);

    const listed = await client.listEntries({ namespace: '', timeoutMs: 5_000 });
    expect(listed.ok && listed.entries.map(entry => entry.id).sort()).toEqual([id(0), id(2)]);

    const recall = await client.recall({
      query: 'erased tea Friday',
      maxTokens: 5_000,
      timeoutMs: 5_000,
    });
    expect(recall.ok && recall.results.map(item => item.id).sort()).toEqual([id(0), id(2)]);

    // A review mark for the erased note's id does nothing.
    await writeFile(
      path.join(baseDir, NS, REVIEWED_FROM_YOU_FILE),
      `${formatReviewedMark({ entryId: id(1), text: ERASED_ENTRY })}\n`,
      'utf8',
    );
    const reviewed = await markReviewedNotesFromYou({ baseDir, namespace: NS, entryIds: [id(1)] });
    expect(reviewed.recorded).toEqual([]);
    expect(reviewed.skipped).toEqual([{ entryId: id(1), reason: 'not_found' }]);
    const after = await scanNamespaceEntries({ baseDir, namespace: NS, maxDailyFiles: 5 });
    expect(after.entries.map(entry => entry.id)).toEqual([id(0), id(2)]);
  });
});

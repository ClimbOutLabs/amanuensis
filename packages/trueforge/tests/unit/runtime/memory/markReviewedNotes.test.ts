import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import {
  REVIEWED_FROM_YOU_FILE,
  formatReviewedMark,
  scanNamespaceEntries,
  scanVaultEntries,
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
      queryTimestamp: '2026-10-03T10:00:00.000Z',
      entityTokens: 0,
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

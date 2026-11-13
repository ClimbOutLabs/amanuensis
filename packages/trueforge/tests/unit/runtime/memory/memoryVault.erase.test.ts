import * as fsp from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { readVaultTombstones, VAULT_TOMBSTONES_FILE } from '../../../../src/runtime/memory/markdownMemoryFiles';
import type { MemoryVaultEntry } from '../../../../src/runtime/memory/memoryClient';
import {
  MEMORY_ORIGIN_METADATA_KEY,
  USER_STATED_ORIGIN,
  type RetainMetadata,
} from '../../../../src/runtime/memory/memoryOrigin';
import { appendSortReport, SORT_REPORT_FILE } from '../../../../src/runtime/memory/pageSortReport';
import { eraseMarkedEntries } from '../../../../src/runtime/memory/vaultErase';
import { withVaultLock } from '../../../../src/runtime/memory/vaultLock';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, rename: jest.fn(actual.rename) };
});

const TIMEOUT_MS = 5000;
const DAY = '2026-09-26';
// The notes here are the person's own words.
const PERSON: RetainMetadata = { [MEMORY_ORIGIN_METADATA_KEY]: USER_STATED_ORIGIN };

async function makeClient(): Promise<{ client: MarkdownMemoryClient; dir: string; vault: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'vault-erase-'));
  return {
    client: new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' }),
    dir,
    vault: path.join(dir, 'tenant-1'),
  };
}

async function retainOne(client: MarkdownMemoryClient, content: string, hour: number, op: string): Promise<void> {
  const outcome = await client.retain({
    items: [
      {
        content,
        timestamp: `${DAY}T${String(hour).padStart(2, '0')}:00:00.000Z`,
        document_id: `doc-${op}`,
        metadata: PERSON,
      },
    ],
    operationId: op,
    timeoutMs: TIMEOUT_MS,
  });
  expect(outcome).toMatchObject({ ok: true });
}

async function listed(client: MarkdownMemoryClient): Promise<MemoryVaultEntry[]> {
  const outcome = await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS });
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.entries;
}

/** Every file under a folder, read as text. */
async function filesUnder(root: string): Promise<{ file: string; text: string }[]> {
  const found: { file: string; text: string }[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await filesUnder(full)));
    } else {
      found.push({ file: full, text: await readFile(full, 'utf8') });
    }
  }
  return found;
}

async function filesHolding(root: string, needle: string): Promise<string[]> {
  return (await filesUnder(root))
    .filter(({ text }) => text.includes(needle))
    .map(({ file }) => path.relative(root, file));
}

async function recallIds(client: MarkdownMemoryClient, query: string): Promise<string[]> {
  const recall = await client.recall({
    query,
    maxTokens: 2000,
    timeoutMs: TIMEOUT_MS,
  });
  if (!recall.ok) {
    throw new Error(recall.reason);
  }
  return recall.results.map(item => item.id ?? '');
}

describe('memory vault erase', () => {
  it('delete removes the text from every file and keeps the other notes in place', async () => {
    const { client, dir, vault } = await makeClient();
    try {
      await retainOne(client, 'Alpha likes zebrafish', 9, 'op-a');
      await retainOne(client, 'Bravo secretly adores quokkas', 10, 'op-b');
      await retainOne(client, 'Charlie plays cello', 11, 'op-c');
      const before = await listed(client);
      const middle = before[1]?.id ?? '';
      expect(await client.deleteEntry({ entryId: middle, timeoutMs: TIMEOUT_MS })).toMatchObject({ ok: true });

      expect(await filesHolding(vault, 'quokkas')).toEqual([]);
      const after = await listed(client);
      expect(after.map(entry => entry.id)).toEqual([before[0]?.id, before[2]?.id]);
      expect(after[0]?.text).toContain('zebrafish');
      expect(after[1]?.text).toContain('cello');
      expect(await recallIds(client, 'quokkas zebrafish cello')).not.toContain(middle);
      expect(await recallIds(client, 'cello')).toContain(before[2]?.id);
      expect((await readVaultTombstones({ baseDir: dir, namespace: 'tenant-1' })).at(-1)).toMatchObject({
        entryId: middle,
        action: 'deleted',
      });
      // A delete is still idempotent.
      expect(await client.deleteEntry({ entryId: middle, timeoutMs: TIMEOUT_MS })).toMatchObject({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('edit replaces the old wording in the file and lists and recalls the new wording under the same id', async () => {
    const { client, dir, vault } = await makeClient();
    try {
      await retainOne(client, 'Alpha likes zebrafish', 9, 'op-a');
      await retainOne(client, 'Bravo secretly adores quokkas', 10, 'op-b');
      const id = (await listed(client))[1]?.id ?? '';
      const edited = await client.updateEntry({
        entryId: id,
        text: 'Bravo now prefers wombats',
        timeoutMs: TIMEOUT_MS,
      });
      expect(edited.ok).toBe(true);
      expect(await filesHolding(vault, 'quokkas')).toEqual([]);
      const after = await listed(client);
      expect(after.map(entry => entry.id)).toContain(id);
      expect(after.find(entry => entry.id === id)?.text).toBe('Bravo now prefers wombats\n\n> From you');
      expect(await recallIds(client, 'wombats')).toContain(id);
      expect(await filesHolding(vault, 'wombats')).toContain(path.join('memory', `${DAY}.md`));

      // A second edit leaves no trace of the first edit's wording either, including in the marker file.
      await client.updateEntry({ entryId: id, text: 'Bravo now prefers lemurs', timeoutMs: TIMEOUT_MS });
      expect(await filesHolding(vault, 'wombats')).toEqual([]);
      expect((await listed(client)).find(entry => entry.id === id)?.text).toBe(
        'Bravo now prefers lemurs\n\n> From you',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('delete after an edit leaves no copy of the edited wording', async () => {
    const { client, dir, vault } = await makeClient();
    try {
      await retainOne(client, 'Alpha likes zebrafish', 9, 'op-a');
      const id = (await listed(client))[0]?.id ?? '';
      await client.updateEntry({ entryId: id, text: 'Alpha now fears pangolins', timeoutMs: TIMEOUT_MS });
      expect(await client.deleteEntry({ entryId: id, timeoutMs: TIMEOUT_MS })).toMatchObject({ ok: true });
      expect(await filesHolding(vault, 'pangolins')).toEqual([]);
      expect(await filesHolding(vault, 'zebrafish')).toEqual([]);
      expect(await listed(client)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cleans notes deleted or edited before, once, and a second run changes no byte', async () => {
    const { client, dir, vault } = await makeClient();
    try {
      await retainOne(client, 'Alpha likes zebrafish', 9, 'op-a');
      await retainOne(client, 'Bravo secretly adores quokkas', 10, 'op-b');
      await retainOne(client, 'Charlie plays cello', 11, 'op-c');
      const ids = (await listed(client)).map(entry => entry.id);
      const marker = (entryId: string, action: string, text?: string): string =>
        `## 2026-09-27T08:00:00.000Z\n\n> vault-entry ${entryId} ${action}${text === undefined ? '' : ` ${JSON.stringify({ text })}`}\n\n`;
      // Markers written the old way: appended only, the dated file never touched.
      await writeFile(
        path.join(vault, VAULT_TOMBSTONES_FILE),
        marker(ids[0] ?? '', 'updated', 'Alpha now likes narwhals') +
          marker(ids[0] ?? '', 'updated', 'Alpha now likes okapis') +
          marker(ids[1] ?? '', 'deleted'),
      );
      expect(await filesHolding(vault, 'quokkas')).not.toEqual([]);

      await retainOne(client, 'Delta paints', 12, 'op-d');
      expect(await filesHolding(vault, 'quokkas')).toEqual([]);
      expect(await filesHolding(vault, 'zebrafish')).toEqual([]);
      expect(await filesHolding(vault, 'narwhals')).toEqual([]);
      const listing = await listed(client);
      expect(listing.map(entry => entry.id)).toEqual([ids[0], ids[2], `md:tenant-1:${DAY}.md#3`]);
      expect(listing[0]?.text).toBe('Alpha now likes okapis\n\n> From you');

      const snapshot = await filesUnder(vault);
      await retainOne(client, 'Echo sings', 13, 'op-e');
      const bytesOf = (files: { file: string; text: string }[]) =>
        files.filter(({ file }) => file.includes('.vault-tombstones'));
      expect(bytesOf(await filesUnder(vault))).toEqual(bytesOf(snapshot));

      // Running the cleaning directly a second time changes nothing at all.
      const settled = await filesUnder(vault);
      await eraseMarkedEntries({ baseDir: dir, namespace: 'tenant-1' });
      expect(await filesUnder(vault)).toEqual(settled);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not lose a note saved while a delete is waiting for the vault', async () => {
    const { client, dir, vault } = await makeClient();
    try {
      await retainOne(client, 'Alpha likes zebrafish', 9, 'op-a');
      await retainOne(client, 'Bravo secretly adores quokkas', 10, 'op-b');
      const id = (await listed(client))[1]?.id ?? '';
      let release: () => void = () => undefined;
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const hasLock = new Promise<void>(resolve => {
        locked = resolve;
      });
      const holder = withVaultLock({ vaultDir: vault }, async () => {
        locked();
        await held;
      });
      await hasLock;
      const deleting = client.deleteEntry({ entryId: id, timeoutMs: TIMEOUT_MS });
      const saving = client.retain({
        items: [
          { content: 'Foxtrot keeps bees', timestamp: `${DAY}T14:00:00.000Z`, document_id: 'doc-f', metadata: PERSON },
        ],
        operationId: 'op-f',
        timeoutMs: TIMEOUT_MS,
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(await filesHolding(vault, 'bees')).toEqual([]);
      expect(await filesHolding(vault, 'quokkas')).not.toEqual([]);
      release();
      await holder;
      expect(await deleting).toMatchObject({ ok: true });
      expect(await saving).toMatchObject({ ok: true });
      expect((await listed(client)).map(entry => entry.text.slice(0, 6))).toEqual(['Alpha ', 'Foxtro']);
      expect(await filesHolding(vault, 'quokkas')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps every note when saves and a delete run at the same moment', async () => {
    const { client, dir, vault } = await makeClient();
    try {
      await retainOne(client, 'Alpha likes zebrafish', 9, 'op-a');
      await retainOne(client, 'Bravo secretly adores quokkas', 10, 'op-b');
      const id = (await listed(client))[1]?.id ?? '';
      const other = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' });
      const results = await Promise.all([
        client.deleteEntry({ entryId: id, timeoutMs: TIMEOUT_MS }),
        ...['one', 'two', 'three'].map(async (word, index) =>
          other.retain({
            items: [
              {
                content: `Saved ${word}`,
                timestamp: `${DAY}T1${String(index)}:30:00.000Z`,
                document_id: `doc-${word}`,
                metadata: PERSON,
              },
            ],
            operationId: `op-${word}`,
            timeoutMs: TIMEOUT_MS,
          }),
        ),
      ]);
      expect(results.every(result => result.ok)).toBe(true);
      const texts = (await listed(client)).map(entry => entry.text);
      expect(texts).toHaveLength(4);
      for (const word of ['one', 'two', 'three']) {
        expect(texts.some(text => text.includes(`Saved ${word}`))).toBe(true);
      }
      expect(await filesHolding(vault, 'quokkas')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves later positions alone when the deleted text held a separator or heading-like lines', async () => {
    const { client, dir, vault } = await makeClient();
    try {
      await retainOne(client, 'Alpha likes zebrafish', 9, 'op-a');
      await retainOne(
        client,
        'Bravo\n\n## Heading-like quokkas\n\n---\n\n## second\n\n> Source: read content',
        10,
        'op-b',
      );
      await retainOne(client, 'Charlie plays cello', 11, 'op-c');
      const before = await listed(client);
      expect(before).toHaveLength(3);
      expect(await client.deleteEntry({ entryId: before[1]?.id ?? '', timeoutMs: TIMEOUT_MS })).toMatchObject({
        ok: true,
      });
      expect(await filesHolding(vault, 'quokkas')).toEqual([]);
      const after = await listed(client);
      expect(after.map(entry => entry.id)).toEqual([before[0]?.id, before[2]?.id]);
      await retainOne(client, 'Delta paints', 12, 'op-d');
      expect((await listed(client)).map(entry => entry.id).at(-1)).toBe(`md:tenant-1:${DAY}.md#3`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers a failed erase in plain words, keeps the marker, and finishes the erase on the next write', async () => {
    const { client, dir, vault } = await makeClient();
    try {
      await retainOne(client, 'Alpha likes zebrafish', 9, 'op-a');
      await retainOne(client, 'Bravo secretly adores quokkas', 10, 'op-b');
      const id = (await listed(client))[1]?.id ?? '';
      jest.mocked(fsp.rename).mockRejectedValueOnce(new Error('disk full'));
      const outcome = await client.deleteEntry({ entryId: id, timeoutMs: TIMEOUT_MS });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toMatch(/Try again/);
      }
      expect(await filesHolding(vault, 'quokkas')).toContain(path.join('memory', `${DAY}.md`));
      expect((await readVaultTombstones({ baseDir: dir, namespace: 'tenant-1' })).at(-1)?.action).toBe('deleted');
      expect(await listed(client)).toHaveLength(1);
      await retainOne(client, 'Charlie plays cello', 11, 'op-c');
      expect(await filesHolding(vault, 'quokkas')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the sorting report after a delete or an edit', () => {
  const planned = (noteId: string) => ({
    note_id: noteId,
    day: DAY,
    outcome: 'sorted' as const,
    decisions: [
      {
        decision: 'unconfirmed' as const,
        about: 'wendy',
        page_kind: 'person' as const,
        text: 'Wendy keeps the spare key.',
        seen: DAY,
        reason: 'A fact.',
      },
    ],
  });

  it('drops what the sorter planned for a deleted note and for an edited one', async () => {
    const { client, dir, vault } = await makeClient();
    try {
      await retainOne(client, 'Wendy keeps the spare key.', 9, 'a');
      await retainOne(client, 'Wendy moved to Porto.', 10, 'b');
      await retainOne(client, 'The dentist is on Friday.', 11, 'c');
      const [first, second, third] = (await listed(client)).map(entry => entry.id).sort();
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error('expected three notes');
      }
      for (const id of [first, second, third]) {
        await appendSortReport({ vaultDir: vault, line: planned(id) });
      }

      expect(await client.deleteEntry({ entryId: first, timeoutMs: TIMEOUT_MS })).toMatchObject({ ok: true });
      expect(
        await client.updateEntry({ entryId: second, text: 'Wendy moved to Lisbon.', timeoutMs: TIMEOUT_MS }),
      ).toMatchObject({ ok: true });

      const kept = (await readFile(path.join(vault, SORT_REPORT_FILE), 'utf8')).trim().split('\n');
      expect(kept.map(text => JSON.parse(text))).toEqual([planned(third)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

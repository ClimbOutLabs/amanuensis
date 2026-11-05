import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { VAULT_TOMBSTONES_FILE } from '../../../../src/runtime/memory/markdownMemoryFiles';

async function withClient(run: (client: MarkdownMemoryClient, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mdmem-doc-'));
  try {
    await run(new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function profileItem(content: string) {
  return {
    content,
    timestamp: '2026-10-28T12:00:00.000Z',
    document_id: 'learned-profile',
    context: 'Learned user profile',
    metadata: { replace_document: 'true' },
  };
}

async function recalledTexts(client: MarkdownMemoryClient): Promise<string[]> {
  const outcome = await client.recall({
    query: 'profile tea coffee',
    maxTokens: 4000,
    queryTimestamp: '2026-10-28T13:00:00.000Z',
    entityTokens: 0,
    timeoutMs: 1000,
  });
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.results.map(item => item.text);
}

describe('MarkdownMemoryClient documents', () => {
  // These tests check what is stored, not how fast. Each call races its own timer, and a stalled
  // test process lets that timer win even after the file work is done, so only the timers are frozen.
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: [
        'Date',
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
      ],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps one entry when a profile is retained twice under the same document id', async () => {
    await withClient(async client => {
      await client.retain({ items: [profileItem('Profile: likes tea')], operationId: 'op-1', timeoutMs: 1000 });
      await client.retain({ items: [profileItem('Profile: likes coffee')], operationId: 'op-2', timeoutMs: 1000 });

      const texts = await recalledTexts(client);

      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('likes coffee');
    });
  });

  it('removes the entry when its document is deleted, and treats a missing document as done', async () => {
    await withClient(async client => {
      await client.retain({ items: [profileItem('Profile: likes tea')], operationId: 'op-1', timeoutMs: 1000 });

      expect(await client.deleteDocument({ documentId: 'learned-profile', timeoutMs: 1000 })).toEqual({ ok: true });
      expect(await client.deleteDocument({ documentId: 'learned-profile', timeoutMs: 1000 })).toEqual({ ok: true });
      expect(await client.deleteDocument({ documentId: 'never-stored', timeoutMs: 1000 })).toEqual({ ok: true });

      expect(await recalledTexts(client)).toEqual([]);
    });
  });

  it('leaves entries without the replace flag alone', async () => {
    await withClient(async client => {
      const turn = (content: string) => ({
        content,
        timestamp: '2026-10-28T12:00:00.000Z',
        document_id: 'same-id',
      });
      await client.retain({ items: [turn('profile tea one')], operationId: 'op-1', timeoutMs: 1000 });
      await client.retain({ items: [turn('profile tea two')], operationId: 'op-2', timeoutMs: 1000 });

      expect(await recalledTexts(client)).toHaveLength(2);
    });
  });

  it('leaves one entry when a replace is retried after the first try failed part way', async () => {
    await withClient(async (client, dir) => {
      await client.retain({ items: [profileItem('Profile: likes tea')], operationId: 'op-1', timeoutMs: 1000 });
      // A directory where the hide marker file goes makes the hide step fail after the new entry is written.
      const markers = path.join(dir, 'tenant-1', VAULT_TOMBSTONES_FILE);
      await mkdir(markers, { recursive: true });
      const failed = await client.retain({
        items: [profileItem('Profile: likes coffee')],
        operationId: 'op-2',
        timeoutMs: 1000,
      });
      expect(failed.ok).toBe(false);
      await rm(markers, { recursive: true });

      const retried = await client.retain({
        items: [profileItem('Profile: likes coffee')],
        operationId: 'op-2',
        timeoutMs: 1000,
      });

      expect(retried).toEqual({ ok: true });
      const texts = await recalledTexts(client);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('likes coffee');
    });
  });
});

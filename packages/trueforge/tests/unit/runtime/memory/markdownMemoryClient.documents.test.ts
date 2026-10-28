import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';

async function withClient(run: (client: MarkdownMemoryClient) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mdmem-doc-'));
  try {
    await run(new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' }));
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
});

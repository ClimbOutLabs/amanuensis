import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { learnedProfileDocumentId, mirrorLearnedProfile } from '../../../../src/runtime/profileLearning';

const silentLogger = {
  warn: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
};

function logger(): never {
  return silentLogger as never;
}

async function withClient(run: (client: MarkdownMemoryClient, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mdmem-mirror-'));
  try {
    await run(new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function mirror(client: MarkdownMemoryClient, document: string, revision: number, timestamp: string) {
  await mirrorLearnedProfile({
    client,
    userRef: 'user:alice',
    document,
    profileExists: true,
    profileRevision: revision,
    timestamp,
    retainTimeoutMs: 1000,
    logger: logger(),
  });
}

async function listed(client: MarkdownMemoryClient): Promise<string[]> {
  const outcome = await client.listEntries({ namespace: '', timeoutMs: 1000 });
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.entries.map(entry => entry.text);
}

async function recalled(client: MarkdownMemoryClient): Promise<string[]> {
  const outcome = await client.recall({
    query: 'profile likes tea coffee cocoa',
    maxTokens: 4000,
    queryTimestamp: '2026-10-30T13:00:00.000Z',
    entityTokens: 0,
    timeoutMs: 1000,
  });
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.results.map(item => item.text);
}

describe('learned profile mirror on the Markdown store', () => {
  it('keeps one live entry after three writes with changing content across days', async () => {
    await withClient(async client => {
      await mirror(client, '# Learned\n\nLikes tea.', 1, '2026-10-26T12:00:00.000Z');
      await mirror(client, '# Learned\n\nLikes coffee.', 2, '2026-10-27T12:00:00.000Z');
      await mirror(client, '# Learned\n\nLikes cocoa.', 3, '2026-10-28T12:00:00.000Z');

      const shown = await listed(client);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toContain('Likes cocoa.');
      expect(shown[0]).not.toContain('document_id');

      const texts = await recalled(client);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('Likes cocoa.');
    });
  });

  it('keeps one live entry when the same content is written again at a later revision', async () => {
    await withClient(async client => {
      await mirror(client, '# Learned\n\nLikes tea.', 1, '2026-10-26T12:00:00.000Z');
      await mirror(client, '# Learned\n\nLikes tea.', 2, '2026-10-27T12:00:00.000Z');
      await mirror(client, '# Learned\n\nLikes tea.', 2, '2026-10-27T12:00:00.000Z');

      expect(await listed(client)).toHaveLength(1);
    });
  });

  it('also hides an older mirror written before the document marker existed', async () => {
    await withClient(async (client, dir) => {
      const memoryDir = path.join(dir, 'tenant-1', 'memory');
      await mkdir(memoryDir, { recursive: true });
      await writeFile(
        path.join(memoryDir, '2026-10-20.md'),
        '## 2026-10-20T12:00:00.000Z\n\n# Learned\n\nLikes tea.\n\n> Learned user profile\n\n',
        'utf8',
      );
      await mirror(client, '# Learned\n\nLikes coffee.', 5, '2026-10-27T12:00:00.000Z');

      const shown = await listed(client);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toContain('Likes coffee.');
    });
  });

  it('scopes the document id to one user so two people never replace each other', async () => {
    expect(learnedProfileDocumentId('user:alice')).not.toEqual(learnedProfileDocumentId('user:bob'));
  });
});

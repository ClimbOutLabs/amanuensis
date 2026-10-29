import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RecallItem } from '../../../../src/runtime/memory/hindsightClient';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { formatMemoryBlock } from '../../../../src/runtime/memory/memoryCapability';

async function makeClient(): Promise<{ client: MarkdownMemoryClient; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mdscope-'));
  return { client: new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' }), dir };
}

async function recallItems({
  client,
  query,
  currentSessionId,
}: {
  client: MarkdownMemoryClient;
  query: string;
  currentSessionId?: string;
}): Promise<RecallItem[]> {
  const outcome = await client.recall({
    query,
    maxTokens: 4000,
    queryTimestamp: '2026-10-26T10:00:00.000Z',
    entityTokens: 0,
    timeoutMs: 5000,
    currentSessionId,
  });
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.results;
}

function note({
  content,
  timestamp,
  sessionId,
}: {
  content: string;
  timestamp: string;
  sessionId?: string;
}): Parameters<MarkdownMemoryClient['retain']>[0]['items'][number] {
  return {
    content,
    timestamp,
    document_id: `doc-${timestamp}`,
    ...(sessionId === undefined ? {} : { metadata: { session_id: sessionId } }),
  };
}

describe('MarkdownMemoryClient recall scope', () => {
  it('leaves out notes written in the current chat and keeps other chats', async () => {
    const { client, dir } = await makeClient();
    try {
      await client.retain({
        items: [
          note({
            content: 'Turn summary: Discussed sending a follow-up now, holding off, or a reminder after a week.',
            timestamp: '2026-10-26T09:15:58Z',
            sessionId: 'chat-now',
          }),
          note({
            content: 'Turn summary: Sent the follow-up to the landlord about the broken heater.',
            timestamp: '2026-10-20T08:00:00Z',
            sessionId: 'chat-old',
          }),
        ],
        operationId: 'op-1',
        timeoutMs: 5000,
      });

      const during = await recallItems({ client, query: 'follow-up reminder heater', currentSessionId: 'chat-now' });
      expect(during.map(item => item.text)).toEqual([expect.stringContaining('landlord')]);

      const elsewhere = await recallItems({ client, query: 'follow-up reminder heater', currentSessionId: 'chat-3' });
      expect(elsewhere).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not let the current chat use up the budget meant for other chats', async () => {
    const { client, dir } = await makeClient();
    try {
      const own = Array.from({ length: 6 }, (_, i) =>
        note({
          content: `Turn summary: follow-up reminder options ${'x'.repeat(200)} ${String(i)}`,
          timestamp: `2026-10-26T09:0${String(i)}:00Z`,
          sessionId: 'chat-now',
        }),
      );
      const other = note({
        content: 'Turn summary: follow-up reminder to the vet',
        timestamp: '2026-10-01T09:00:00Z',
        sessionId: 'chat-old',
      });
      await client.retain({ items: [...own, other], operationId: 'op-budget', timeoutMs: 5000 });
      const outcome = await client.recall({
        query: 'follow-up reminder',
        maxTokens: 120,
        queryTimestamp: '2026-10-26T10:00:00.000Z',
        entityTokens: 0,
        timeoutMs: 5000,
        currentSessionId: 'chat-now',
      });
      expect(outcome.ok && outcome.results.map(item => item.text)).toEqual([expect.stringContaining('to the vet')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still skips a note from the current chat after it is edited on the Memories page', async () => {
    const { client, dir } = await makeClient();
    try {
      await client.retain({
        items: [
          note({
            content: 'Discussed sending a follow-up now or a reminder after a week.',
            timestamp: '2026-10-26T09:15:58Z',
            sessionId: 'chat-now',
          }),
        ],
        operationId: 'op-edit',
        timeoutMs: 5000,
      });
      const listed = await client.listEntries({ namespace: '', timeoutMs: 5000 });
      const entry = listed.ok ? listed.entries[0] : undefined;
      if (entry === undefined) {
        throw new Error('expected one vault entry');
      }
      // The page shows the text without the hidden chat id and sends exactly that back.
      expect(entry.text).not.toContain('session_id');
      const edited = await client.updateEntry({
        entryId: entry.id,
        text: 'Discussed sending the follow-up now, or a reminder after two weeks.',
        timeoutMs: 5000,
      });
      expect(edited.ok).toBe(true);

      expect(await recallItems({ client, query: 'follow-up reminder', currentSessionId: 'chat-now' })).toEqual([]);
      const elsewhere = await recallItems({ client, query: 'follow-up reminder', currentSessionId: 'chat-3' });
      expect(elsewhere.map(item => item.text)).toEqual([expect.stringContaining('two weeks')]);
      const relisted = await client.listEntries({ namespace: '', timeoutMs: 5000 });
      expect(relisted.ok && relisted.entries.map(item => item.text)).toEqual([
        expect.not.stringContaining('session_id'),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still reads and recalls an older entry that has no chat id', async () => {
    const { client, dir } = await makeClient();
    try {
      // Older format: heading, text and a title line, with no hidden chat id.
      await mkdir(path.join(dir, 'tenant-1', 'memory'), { recursive: true });
      await writeFile(
        path.join(dir, 'tenant-1', 'memory', '2026-09-19.md'),
        '## 2026-09-19T12:00:00.000Z\n\nTurn summary: The dentist is Dr Rivera.\n\n> Chat title: Health admin\n',
        'utf8',
      );
      const items = await recallItems({ client, query: 'who is the dentist', currentSessionId: 'chat-now' });
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toContain('Dr Rivera');
      expect(items[0]?.metadata).toBeUndefined();
      expect(items[0]?.occurred_start).toBe('2026-09-19T12:00:00.000Z');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives each note its time and hides the chat id from the recalled text', async () => {
    const { client, dir } = await makeClient();
    try {
      await client.retain({
        items: [
          note({
            content: 'Turn summary: The dentist is Dr Rivera.',
            timestamp: '2026-10-26T09:15:58Z',
            sessionId: 'chat-old',
          }),
        ],
        operationId: 'op-date',
        timeoutMs: 5000,
      });
      const items = await recallItems({ client, query: 'who is the dentist', currentSessionId: 'chat-now' });
      expect(items[0]?.occurred_start).toBe('2026-10-26T09:15:58.000Z');
      expect(items[0]?.metadata).toEqual({ session_id: 'chat-old' });
      expect(items[0]?.text).not.toContain('session_id');
      const stored = await readFile(path.join(dir, 'tenant-1', 'memory', '2026-10-26.md'), 'utf8');
      expect(stored).toContain('<!-- session_id: chat-old -->');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('recalled block', () => {
  it('holds only other chats, with the date and read-content mark in the label and the plain text after it', async () => {
    const { client, dir } = await makeClient();
    try {
      await client.retain({
        items: [
          note({
            content: 'Follow-up reminder options were discussed again.',
            timestamp: '2026-10-26T09:15:58Z',
            sessionId: 'chat-now',
          }),
          {
            ...note({
              content: 'The dentist is Dr Rivera, per a follow-up reminder email.',
              timestamp: '2026-10-20T08:00:00Z',
              sessionId: 'chat-old',
            }),
            metadata: { session_id: 'chat-old', origin: 'tool_ingested' },
          },
          note({
            content: 'The vet follow-up reminder is booked.',
            timestamp: '2026-09-19T11:00:00Z',
            sessionId: 'chat-old',
          }),
        ],
        operationId: 'op-block',
        timeoutMs: 5000,
      });
      const results = await recallItems({ client, query: 'follow-up reminder', currentSessionId: 'chat-now' });
      const { block } = formatMemoryBlock({ results, entities: [], budgetTokens: 600 });
      const lines = block.split('\n');
      expect(lines).toContain(
        '[2026-10-20, from something read for the person] The dentist is Dr Rivera, per a follow-up reminder email.',
      );
      expect(lines).toContain('[2026-09-19] The vet follow-up reminder is booked.');
      expect(block).not.toContain('discussed again');
      expect(block).not.toContain('## ');
      expect(block).not.toContain('Source: read content');
      expect(block).not.toContain('session_id');
      expect(block).not.toContain('markdown');
      expect(block).not.toContain('undated');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is empty when only the current chat matches the reply', async () => {
    const { client, dir } = await makeClient();
    try {
      await client.retain({
        items: [
          note({
            content: 'Discussed sending a follow-up now or a reminder after a week.',
            timestamp: '2026-10-26T09:15:58Z',
            sessionId: 'chat-now',
          }),
          note({ content: 'Prefers window seats on flights.', timestamp: '2026-10-02T09:00:00Z' }),
        ],
        operationId: 'op-empty',
        timeoutMs: 5000,
      });
      expect(await recallItems({ client, query: 'follow-up reminder', currentSessionId: 'chat-now' })).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

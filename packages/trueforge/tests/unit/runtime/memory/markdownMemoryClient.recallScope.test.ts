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
      expect(items[0]?.occurred_start).toBe('2026-09-19');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dates an entry by the day of its file and never claims a time', async () => {
    const { client, dir } = await makeClient();
    try {
      await mkdir(path.join(dir, 'tenant-1', 'memory'), { recursive: true });
      await writeFile(
        path.join(dir, 'tenant-1', 'memory', '2026-09-19.md'),
        '## Dentist\n\nTurn summary: The dentist is Dr Rivera.\n',
        'utf8',
      );
      const items = await recallItems({ client, query: 'who is the dentist' });
      expect(items).toHaveLength(1);
      expect(items[0]?.occurred_start).toBe('2026-09-19');
      expect(items[0]?.text).toContain('Dr Rivera');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives each note its day and hides the chat id from the recalled text', async () => {
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
      expect(items[0]?.occurred_start).toBe('2026-10-26');
      expect(items[0]?.metadata).toEqual({ session_id: 'chat-old' });
      expect(items[0]?.text).not.toContain('session_id');
      const stored = await readFile(path.join(dir, 'tenant-1', 'memory', '2026-10-26.md'), 'utf8');
      expect(stored).toContain('<!-- session_id: chat-old -->');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recalls nothing for a one-word reply against unrelated notes', async () => {
    const { client, dir } = await makeClient();
    try {
      await client.retain({
        items: [
          note({ content: 'Turn summary: Lexie is a Bernese Mountain Dog.', timestamp: '2026-10-01T09:00:00Z' }),
          note({ content: 'Turn summary: Prefers window seats on flights.', timestamp: '2026-10-02T09:00:00Z' }),
          note({ content: 'Turn summary: The dentist is Dr Rivera.', timestamp: '2026-10-03T09:00:00Z' }),
          note({ content: 'Turn summary: The team meets every week on Monday.', timestamp: '2026-10-04T09:00:00Z' }),
          note({ content: 'Turn summary: Trash goes out once a week.', timestamp: '2026-10-05T09:00:00Z' }),
        ],
        operationId: 'op-unrelated',
        timeoutMs: 5000,
      });
      expect(await recallItems({ client, query: 'Yup' })).toEqual([]);
      // "week" is in two notes, so on its own it is not a lead.
      expect(await recallItems({ client, query: 'Yup\n\nI sent it\n\nThis week' })).toEqual([]);
      expect(await recallItems({ client, query: 'Anything' })).toEqual([]);
      expect(await recallItems({ client, query: 'who is the dentist' })).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('recalled block', () => {
  it('holds only other chats, with real dates, the read-content note and no source label', async () => {
    const { client, dir } = await makeClient();
    try {
      await mkdir(path.join(dir, 'tenant-1', 'memory'), { recursive: true });
      await writeFile(
        path.join(dir, 'tenant-1', 'memory', '2026-09-19.md'),
        '## Notes\n\nTurn summary: Follow-up reminder for the vet is booked.\n',
        'utf8',
      );
      await client.retain({
        items: [
          note({
            content: 'Turn summary: Follow-up reminder options were discussed again.',
            timestamp: '2026-10-26T09:15:58Z',
            sessionId: 'chat-now',
          }),
          {
            ...note({
              content: 'Turn summary: An email asked for a follow-up reminder to the landlord.',
              timestamp: '2026-10-20T08:00:00Z',
              sessionId: 'chat-old',
            }),
            metadata: { session_id: 'chat-old', origin: 'tool_ingested' },
          },
        ],
        operationId: 'op-block',
        timeoutMs: 5000,
      });
      const results = await recallItems({ client, query: 'follow-up reminder', currentSessionId: 'chat-now' });
      const { block } = formatMemoryBlock({ results, entities: [], budgetTokens: 600 });
      expect(block).toMatch(/\[2026-10-20, from something Aman read\] .*An email asked/);
      // A heading that is not a date stays in the text; the file's day dates the note.
      expect(block).toContain('[2026-09-19] ## Notes');
      expect(block).not.toContain('discussed again');
      expect(block).not.toContain('markdown');
      expect(block).not.toContain('undated');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is empty when the reply matches nothing but the current chat', async () => {
    const { client, dir } = await makeClient();
    try {
      await client.retain({
        items: [
          note({
            content: 'Turn summary: Discussed sending a follow-up now or a reminder after a week.',
            timestamp: '2026-10-26T09:15:58Z',
            sessionId: 'chat-now',
          }),
          note({ content: 'Turn summary: Prefers window seats on flights.', timestamp: '2026-10-02T09:00:00Z' }),
        ],
        operationId: 'op-empty',
        timeoutMs: 5000,
      });
      expect(await recallItems({ client, query: 'Yup', currentSessionId: 'chat-now' })).toEqual([]);
      expect(await recallItems({ client, query: 'follow-up reminder', currentSessionId: 'chat-now' })).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

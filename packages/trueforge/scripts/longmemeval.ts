import { createReadStream } from 'node:fs';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';

import { MarkdownMemoryClient } from '../src/runtime/memory/markdownMemoryClient';
import type { RetainItem } from '../src/runtime/memory/memoryClient';

const input = z.object({
  question_id: z.string(),
  question_type: z.string(),
  question: z.string(),
  question_date: z.string(),
  answer_session_ids: z.array(z.string()),
  haystack_session_ids: z.array(z.string()),
  haystack_dates: z.array(z.string()),
  haystack_sessions: z.array(z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))),
});

async function retrieve(row: z.infer<typeof input>) {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'aman-longmemeval-'));
  try {
    const client = new MarkdownMemoryClient({ baseDir, namespace: 'benchmark' });
    const items: RetainItem[] = [];
    for (const [index, session] of row.haystack_sessions.entries()) {
      const date = row.haystack_dates[index];
      if (date === undefined || row.haystack_session_ids[index] === undefined) {
        throw new Error('Missing session metadata.');
      }
      const timestamp = date.replace(/^(\d{4})\/(\d{2})\/(\d{2}) \(\w+\) (\d{2}:\d{2})$/, '$1-$2-$3T$4:00Z');
      for (const [turn, message] of session.entries()) {
        items.push({
          content: message.role + ': ' + message.content,
          timestamp: new Date(timestamp).toISOString(),
          document_id: 'doc-' + String(index) + '-' + String(turn),
          metadata: { origin: 'imported', session_id: 'chat-' + String(index) },
        });
      }
    }
    const retained = await client.retain({ items, operationId: 'history', timeoutMs: 120_000 });
    if (!retained.ok) {
      throw new Error(retained.reason);
    }
    const recalled = await client.recall({ query: row.question, maxTokens: 4096, timeoutMs: 30_000 });
    if (!recalled.ok) {
      throw new Error(recalled.reason);
    }
    const retrieved = new Set(recalled.results.map(item => item.metadata?.['session_id']));
    const gold = new Set(row.answer_session_ids);
    const hits = row.haystack_session_ids.filter(
      (id, index) => gold.has(id) && retrieved.has('chat-' + String(index)),
    ).length;
    return {
      question_id: row.question_id,
      question_type: row.question_type,
      hits,
      gold: gold.size,
      memories: recalled.results.map(item => ({ date: item.occurred_start, text: item.text })),
    };
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

async function main() {
  const [, , source, output] = process.argv;
  if (!source || !output || source === output) {
    throw new Error('Provide separate input and output JSONL paths.');
  }
  await writeFile(output, '', { flag: 'wx' });
  for await (const line of createInterface({ input: createReadStream(source), crlfDelay: Infinity })) {
    const result = await retrieve(input.parse(JSON.parse(line)));
    await appendFile(
      output,
      JSON.stringify(result).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029') + '\n',
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

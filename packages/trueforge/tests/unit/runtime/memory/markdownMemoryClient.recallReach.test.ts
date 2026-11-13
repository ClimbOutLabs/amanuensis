import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import type { RetainItem } from '../../../../src/runtime/memory/memoryClient';
import {
  NOTE_DATE_METADATA_KEY,
  NOTE_SOURCE_METADATA_KEY,
  noteRetainContent,
} from '../../../../src/runtime/memory/memoryNotes';
import {
  MEMORY_ORIGIN_METADATA_KEY,
  TOOL_INGESTED_ORIGIN,
  USER_STATED_ORIGIN,
} from '../../../../src/runtime/memory/memoryOrigin';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function personFact({ text, age }: { text: string; age: number }): RetainItem {
  return {
    content: text,
    timestamp: daysAgo(age),
    document_id: `fact-${String(age)}-${text.length.toString()}`,
    metadata: { [MEMORY_ORIGIN_METADATA_KEY]: USER_STATED_ORIGIN },
  };
}

function emailFinding({ text, age }: { text: string; age: number }): RetainItem {
  const date = daysAgo(age).slice(0, 10);
  return {
    content: noteRetainContent({ text, source: 'email', date }),
    timestamp: daysAgo(age),
    document_id: `finding-${String(age)}`,
    metadata: {
      [MEMORY_ORIGIN_METADATA_KEY]: TOOL_INGESTED_ORIGIN,
      [NOTE_SOURCE_METADATA_KEY]: 'email',
      [NOTE_DATE_METADATA_KEY]: date,
    },
  };
}

describe('MarkdownMemoryClient recall reach', () => {
  let dir: string;
  let client: MarkdownMemoryClient;
  let operation = 0;

  async function retain(items: RetainItem[]): Promise<void> {
    operation += 1;
    const outcome = await client.retain({ items, operationId: `op-${String(operation)}`, timeoutMs: 5000 });
    expect(outcome).toMatchObject({ ok: true });
  }

  async function recallTexts({ query, maxTokens }: { query: string; maxTokens: number }): Promise<string[]> {
    const outcome = await client.recall({
      query,
      maxTokens,
      timeoutMs: 5000,
    });
    if (!outcome.ok) {
      throw new Error(outcome.reason);
    }
    return outcome.results.map(item => item.text);
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mdmem-reach-'));
    client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('recalls what the person said however many days of notes came after it', async () => {
    await retain([personFact({ text: 'The alarm code for the lake house is 4471.', age: 200 })]);
    for (let age = 60; age >= 0; age -= 1) {
      await retain([personFact({ text: `Went for a run on day ${String(age)}.`, age })]);
    }

    const texts = await recallTexts({ query: 'what is the alarm code for the lake house?', maxTokens: 600 });

    expect(texts[0]).toBe('The alarm code for the lake house is 4471.');
  });

  it('prefers the newer of two equally matching memories across the whole history', async () => {
    await retain([personFact({ text: 'The dentist is Dr Okafor on Mill Road.', age: 90 })]);
    await retain([personFact({ text: 'The dentist is Dr Lindqvist on Mill Road.', age: 30 })]);
    for (let age = 20; age >= 0; age -= 1) {
      await retain([personFact({ text: `Watered the plants on day ${String(age)}.`, age })]);
    }

    const texts = await recallTexts({ query: 'who is the dentist on Mill Road', maxTokens: 600 });

    expect(texts.slice(0, 2)).toEqual([
      'The dentist is Dr Lindqvist on Mill Road.',
      'The dentist is Dr Okafor on Mill Road.',
    ]);
  });

  it('shows something saved on several days once, as its newest copy', async () => {
    await retain([personFact({ text: 'Wendy is allergic to shellfish.', age: 300 })]);
    await retain([personFact({ text: 'Wendy is allergic to  SHELLFISH.', age: 150 })]);
    await retain([personFact({ text: 'Wendy is allergic to shellfish.', age: 2 })]);
    await retain([personFact({ text: 'Wendy is allergic to peanuts too.', age: 100 })]);

    const outcome = await client.recall({
      query: 'what is Wendy allergic to?',
      maxTokens: 600,
      timeoutMs: 5000,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.results.map(item => item.text)).toEqual([
        'Wendy is allergic to shellfish.',
        'Wendy is allergic to peanuts too.',
      ]);
      expect(outcome.results[0]?.occurred_start).toBe(daysAgo(2));
    }
  });

  it('recalls read content however old it is, with the day it was found', async () => {
    await retain([emailFinding({ text: 'The accountant said to file form 8829 for the home office.', age: 400 })]);
    await retain([emailFinding({ text: 'The plumber Rossi quoted 400 for the boiler repair.', age: 3 })]);

    const outcome = await client.recall({ query: 'accountant form home office', maxTokens: 600, timeoutMs: 5000 });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const found = outcome.results.find(item => item.text.includes('form 8829'));
      expect(found?.occurred_start).toBe(daysAgo(400));
    }
    expect(await recallTexts({ query: 'plumber Rossi boiler quote', maxTokens: 600 })).toEqual([
      expect.stringContaining('quoted 400'),
    ]);
  });

  it('sees a hand edit to an old day file on the next recall', async () => {
    await retain([personFact({ text: 'The gate code is 1200.', age: 120 })]);
    for (let age = 20; age >= 0; age -= 1) {
      await retain([personFact({ text: `Fed the cat on day ${String(age)}.`, age })]);
    }
    expect(await recallTexts({ query: 'gate code', maxTokens: 600 })).toContain('The gate code is 1200.');

    const file = path.join(dir, 'tenant-1', 'memory', `${daysAgo(120).slice(0, 10)}.md`);
    await writeFile(file, `## ${daysAgo(120)}\n\nThe gate code is 9931.\n`, 'utf8');
    // Same length and, on a coarse clock, possibly the same second: move the time so the change is visible.
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);

    const texts = await recallTexts({ query: 'gate code', maxTokens: 600 });
    expect(texts).toContain('The gate code is 9931.');
    expect(texts).not.toContain('The gate code is 1200.');
  });
});

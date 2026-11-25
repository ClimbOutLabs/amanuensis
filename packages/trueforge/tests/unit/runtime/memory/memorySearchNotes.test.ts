import { createSentinelHostContext, defaultSentinelServices, execFileRunner } from '@truefoundry/trueforge-core/core';
import { isCallToolResponseResult } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from 'winston';

import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import type { RecallItem, RecallOutcome } from '../../../../src/runtime/memory/memoryClient';
import { MemoryPagesToolSet } from '../../../../src/runtime/memory/memoryPagesTools';
import { TurnReadWatch } from '../../../../src/runtime/memory/turnReadWatch';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The ISO day `days` before today, in UTC, matching how the daily files are named. */
function dayBefore(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

const TODAY = dayBefore(0);

let baseDir = '';

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'note-search-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

let opCount = 0;

async function retainNote(
  client: MarkdownMemoryClient,
  { content, day, sessionId }: { content: string; day: string; sessionId: string },
): Promise<void> {
  opCount += 1;
  const retained = await client.retain({
    items: [
      {
        content,
        timestamp: `${day}T09:15:00.000Z`,
        document_id: sessionId,
        metadata: { origin: 'user_stated', session_id: sessionId },
      },
    ],
    operationId: `op-${String(opCount)}`,
    timeoutMs: 5000,
  });
  expect(retained.ok).toBe(true);
}

async function search(
  client: MarkdownMemoryClient,
  params: { query: string; maxTokens?: number; currentSessionId?: string },
): Promise<RecallOutcome> {
  const outcome = await client.searchNotes?.({
    query: params.query,
    today: TODAY,
    maxTokens: params.maxTokens ?? 2048,
    timeoutMs: 5000,
    currentSessionId: params.currentSessionId,
  });
  if (outcome === undefined) {
    throw new Error('the markdown client does not offer a note search');
  }
  return outcome;
}

function resultsOf(outcome: RecallOutcome): RecallItem[] {
  if (!outcome.ok) {
    throw new Error(`the search failed: ${outcome.reason}`);
  }
  return outcome.results;
}

describe('searching the daily notes through the markdown client', () => {
  it('finds a note retained by another chat, with its day, its source reference and its wording', async () => {
    const client = new MarkdownMemoryClient({ baseDir, namespace: 'tenant-1', vaultScope: undefined });
    const day = dayBefore(2);
    await retainNote(client, {
      content: 'Shipment Juniper-47 needs the short mounting bracket.',
      day,
      sessionId: 'chat-a',
    });

    const results = resultsOf(await search(client, { query: 'Juniper-47', currentSessionId: 'chat-b' }));
    expect(results).toHaveLength(1);
    const [note] = results;
    expect(note?.text).toContain('Shipment Juniper-47 needs the short mounting bracket.');
    expect(note?.id).toBe(`md:tenant-1:${day}.md#0`);
    expect(note?.occurred_start).toBe(`${day}T09:15:00.000Z`);
    expect(note?.metadata?.['origin']).toBe('user_stated');
  });

  it('reports no matches as an empty success, not a failure', async () => {
    const client = new MarkdownMemoryClient({ baseDir, namespace: 'tenant-1', vaultScope: undefined });
    await retainNote(client, {
      content: 'Shipment Juniper-47 needs the short mounting bracket.',
      day: dayBefore(1),
      sessionId: 'chat-a',
    });

    const outcome = await search(client, { query: 'Nonexistent-99' });
    expect(outcome.ok).toBe(true);
    expect(resultsOf(outcome)).toEqual([]);
  });

  it('searches the last 14 days: a note from 14 days ago is found, one from 15 days ago is not', async () => {
    const client = new MarkdownMemoryClient({ baseDir, namespace: 'tenant-1', vaultScope: undefined });
    await retainNote(client, { content: 'The Kestrel-9 form is still at the office.', day: dayBefore(14), sessionId: 'chat-a' });
    await retainNote(client, { content: 'The Kestrel-9 form was first mentioned here.', day: dayBefore(15), sessionId: 'chat-a' });

    const results = resultsOf(await search(client, { query: 'Kestrel-9' }));
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toContain(dayBefore(14));
    expect(results[0]?.text).toContain('still at the office');
  });

  it('keeps the answer inside the token budget, however many notes match', async () => {
    const client = new MarkdownMemoryClient({ baseDir, namespace: 'tenant-1', vaultScope: undefined });
    const filler = 'The rest of the note is ordinary detail about the delivery and the shelf it belongs to.';
    for (const part of ['first', 'second', 'third']) {
      await retainNote(client, {
        content: `The ${part} Juniper-47 note runs long. ${filler}`,
        day: dayBefore(1),
        sessionId: 'chat-a',
      });
    }

    expect(resultsOf(await search(client, { query: 'Juniper-47', maxTokens: 2048 }))).toHaveLength(3);
    expect(resultsOf(await search(client, { query: 'Juniper-47', maxTokens: 50 }))).toHaveLength(1);
  });

  it('never shows one owner the notes of another', async () => {
    const mine = new MarkdownMemoryClient({ baseDir, namespace: 'tenant-1', vaultScope: undefined });
    const theirs = new MarkdownMemoryClient({ baseDir, namespace: 'tenant-2', vaultScope: undefined });
    await retainNote(mine, {
      content: 'Shipment Juniper-47 needs the short mounting bracket.',
      day: dayBefore(1),
      sessionId: 'chat-a',
    });

    expect(resultsOf(await search(theirs, { query: 'Juniper-47' }))).toEqual([]);
    expect(resultsOf(await search(mine, { query: 'Juniper-47' }))).toHaveLength(1);
  });

  it('leaves out notes the current chat itself saved, and shows them to another chat', async () => {
    const client = new MarkdownMemoryClient({ baseDir, namespace: 'tenant-1', vaultScope: undefined });
    await retainNote(client, {
      content: 'Shipment Juniper-47 needs the short mounting bracket.',
      day: dayBefore(1),
      sessionId: 'chat-b',
    });

    expect(resultsOf(await search(client, { query: 'Juniper-47', currentSessionId: 'chat-b' }))).toEqual([]);
    expect(resultsOf(await search(client, { query: 'Juniper-47', currentSessionId: 'chat-c' }))).toHaveLength(1);
  });
});

const NOW = new Date('2026-11-06T12:00:00.000Z');

const FOUND: RecallItem = {
  id: 'md:default:2026-11-04.md#0',
  text: 'Shipment Juniper-47 needs the short mounting bracket.',
  occurred_start: '2026-11-04',
  metadata: { origin: 'user_stated' },
};

function buildTools({
  keepsNothing = false,
  searchNotes,
}: {
  keepsNothing?: boolean;
  searchNotes?: (params: { query: string; today: string }) => Promise<RecallOutcome>;
} = {}) {
  const watch = new TurnReadWatch();
  watch.observe([{ role: 'user', content: 'Any news on my delivery?' }]);
  const tools = new MemoryPagesToolSet({
    vaultDir: baseDir,
    runner: execFileRunner,
    timeZone: 'UTC',
    now: () => NOW,
    logger: createLogger({ silent: true }),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      tenant_id: 'default',
      created_by: 'owner-1',
      conversation_id: 'chat-1',
    }),
    keepsNothing,
    maxPageTokens: 1500,
    watch,
    searchNotes,
    personName: undefined,
  });
  return { tools, watch };
}

async function callSearch(tools: MemoryPagesToolSet, query: string) {
  const response = await tools.callTool({ name: 'search_memory_notes', arguments: { query } });
  if (!isCallToolResponseResult(response)) {
    throw new Error('the tool did not answer');
  }
  const [first] = response.result.content;
  return { isError: response.result.isError === true, text: first?.type === 'text' ? first.text : '' };
}

async function toolNames(tools: MemoryPagesToolSet): Promise<string[]> {
  const { result } = await tools.listTools();
  return result.tools.map(tool => tool.name);
}

describe('the search_memory_notes tool', () => {
  it('shows a found note with its day, whose words it is, and where it is kept', async () => {
    const seen: { query: string; today: string }[] = [];
    const { tools } = buildTools({
      searchNotes: params => {
        seen.push(params);
        return Promise.resolve({ ok: true, results: [FOUND] });
      },
    });

    const answer = await callSearch(tools, 'Juniper-47');
    expect(answer.isError).toBe(false);
    expect(seen).toEqual([{ query: 'Juniper-47', today: '2026-11-06' }]);
    expect(answer.text).toContain('2026-11-04, said by the person (md:default:2026-11-04.md#0)');
    expect(answer.text.split('\n')).toContain('Shipment Juniper-47 needs the short mounting bracket.');
  });

  it('says plainly that nothing matched, and names the days it searched', async () => {
    const { tools } = buildTools({ searchNotes: () => Promise.resolve({ ok: true, results: [] }) });

    const answer = await callSearch(tools, 'Juniper-47');
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('No notes from the last 14 days mention "Juniper-47"');
  });

  it('answers a failed search with an error, never with the no-match words', async () => {
    const { tools } = buildTools({
      searchNotes: (): Promise<RecallOutcome> =>
        Promise.resolve({ ok: false, code: 'request_failed', reason: 'the log could not be read' }),
    });

    const answer = await callSearch(tools, 'Juniper-47');
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('could not be searched');
    expect(answer.text).not.toContain('No notes from the last 14 days');
  });

  it('marks the turn as holding outside text when a found note is not the person\u2019s own words', async () => {
    const read: RecallItem = { ...FOUND, metadata: { origin: 'tool_ingested' } };
    const { tools, watch } = buildTools({ searchNotes: () => Promise.resolve({ ok: true, results: [read] }) });

    await callSearch(tools, 'Juniper-47');
    expect(watch.reason).toBe('memory_holds_outside_text');
  });

  it('leaves the turn unmarked when every found note is the person\u2019s own words', async () => {
    const { tools, watch } = buildTools({ searchNotes: () => Promise.resolve({ ok: true, results: [FOUND] }) });

    await callSearch(tools, 'Juniper-47');
    expect(watch.reason).toBeUndefined();
  });

  it('is not offered in a private chat', async () => {
    const { tools } = buildTools({
      keepsNothing: true,
      searchNotes: () => Promise.resolve({ ok: true, results: [FOUND] }),
    });

    expect(await toolNames(tools)).not.toContain('search_memory_notes');
  });

  it('is not offered where the backend keeps no searchable notes, while the page tools stay', async () => {
    const { tools } = buildTools();

    const names = await toolNames(tools);
    expect(names).toContain('list_pages');
    expect(names).not.toContain('search_memory_notes');
  });
});

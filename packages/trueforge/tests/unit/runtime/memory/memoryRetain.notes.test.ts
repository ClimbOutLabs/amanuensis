/**
 * End to end with a real markdown store: what a turn saves as the person's own facts, as labeled
 * findings from tool results, and as notes about the assistant's reply, and what each looks like at recall.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';
import type { IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { entryMetadata, withoutHiddenMarkers } from '../../../../src/runtime/memory/markdownMemoryFiles';
import { formatMemoryBlock } from '../../../../src/runtime/memory/memoryCapability';
import type { TurnToolResult } from '../../../../src/runtime/memory/memoryNotesSummarize';
import { submitRetain } from '../../../../src/runtime/memory/memoryRetain';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

/** The next scripted answer for each of the two model calls a turn can make. */
const scripted = { person: '{"facts": []}', notes: '{"findings": [], "responses": []}' };

function scriptedLlm(reply: () => string) {
  return () =>
    Promise.resolve({
      create: () => {
        throw new Error('streaming is not used');
      },
      createNonStream: () =>
        Promise.resolve({
          output: { role: 'assistant' as const, content: reply() },
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          finish_reason: 'stop' as const,
        }),
    });
}

jest.mock('../../../../src/runtime/memory/memorySummarize', () => {
  const actual = jest.requireActual<typeof import('../../../../src/runtime/memory/memorySummarize')>(
    '../../../../src/runtime/memory/memorySummarize',
  );
  return {
    ...actual,
    summarizeTurnContent: jest.fn(params =>
      actual.summarizeTurnContent({ ...params, resolveLlm: scriptedLlm(() => scripted.person) }),
    ),
  };
});

jest.mock('../../../../src/runtime/memory/memoryNotesSummarize', () => {
  const actual = jest.requireActual<typeof import('../../../../src/runtime/memory/memoryNotesSummarize')>(
    '../../../../src/runtime/memory/memoryNotesSummarize',
  );
  return {
    ...actual,
    summarizeTurnNotes: jest.fn(params =>
      actual.summarizeTurnNotes({ ...params, resolveLlm: scriptedLlm(() => scripted.notes) }),
    ),
  };
});

const unusedStore: IModelProviderStore = {
  listProviders: jest.fn(),
  getProvider: jest.fn(),
  getProviderForUpdate: jest.fn(),
  createProvider: jest.fn(),
  upsertProvider: jest.fn(),
  listModels: jest.fn(),
  deleteProvider: jest.fn(),
};

const EMAIL_RESULT: TurnToolResult = {
  source: 'email',
  text: 'From: Priya. Subject: Form. Please send the signed form by 3 November.',
};
const SHORT_REPLY = 'Got it.';
const LONG_REPLY =
  'I found one email from Priya. She needs the signed form by 3 November. Leave by 08:55 for the GP visit so that parking is not a rush.';

describe('turn memory with findings and reply notes', () => {
  let dir: string;
  let client: MarkdownMemoryClient;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'memory-notes-'));
    client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant' });
    scripted.person = '{"facts": []}';
    scripted.notes = '{"findings": [], "responses": []}';
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function submit(turn: {
    id: string;
    userText: string;
    assistantText: string;
    toolResults?: TurnToolResult[];
    assistantName?: string;
  }): Promise<void> {
    await submitRetain({
      client,
      sessionId: 'chat-1',
      turnId: turn.id,
      userText: turn.userText,
      assistantText: turn.assistantText,
      completedAt: '2026-10-29T12:00:00.000Z',
      origin: turn.toolResults === undefined ? 'user_stated' : 'tool_ingested',
      logger: winston.createLogger({ silent: true }),
      ...(turn.toolResults === undefined ? {} : { toolResults: turn.toolResults }),
      summarize: {
        tenantId: 't1',
        modelProviderStore: unusedStore,
        summarizationModelFqn: 'provider/model',
        tokenFactoryBudget: uncappedTokenFactoryBudget,
        modelUsage: discardedModelUsage,
        assistantName: turn.assistantName,
      },
    });
  }

  async function dayFile(): Promise<string> {
    const folder = path.join(dir, 'tenant', 'memory');
    const [name] = await readdir(folder);
    return readFile(path.join(folder, name ?? ''), 'utf8');
  }

  it('saves only the person-said fact for a turn with no tool results and a short reply, as before', async () => {
    scripted.person = '{"facts": ["My dentist is Dr Okafor."]}';
    await submit({ id: 't1', userText: 'My dentist is Dr Okafor.', assistantText: SHORT_REPLY });
    const file = await dayFile();
    expect(file).toContain('My dentist is Dr Okafor.');
    expect(file).not.toContain('note:');
    expect(file).not.toContain('> Source: read content');
    expect(file.match(/^## /gm)).toHaveLength(1);
  });

  it('saves a labeled finding when the turn read an email', async () => {
    scripted.notes = JSON.stringify({
      findings: [{ result: 1, text: 'Priya asked for the signed form by 2026-11-03.' }],
      responses: [],
    });
    await submit({
      id: 't2',
      userText: 'Check my email.',
      assistantText: SHORT_REPLY,
      toolResults: [EMAIL_RESULT],
    });
    const file = await dayFile();
    expect(file).toContain('From an email, found Oct 29: Priya asked for the signed form by 2026-11-03.');
    expect(file).toContain('<!-- note: email 2026-10-29 -->');
    expect(file).not.toContain('Check my email');
  });

  it('carries the source and day inside the stored text, so a backend that keeps no metadata still hands them back', async () => {
    scripted.notes = JSON.stringify({
      findings: [{ result: 1, text: 'Priya asked for the signed form by 2026-11-03.' }],
      responses: [],
    });
    const retain = jest.spyOn(client, 'retain');
    await submitRetain({
      client,
      sessionId: 'chat-1',
      turnId: 't2b',
      userText: 'Check my email.',
      assistantText: SHORT_REPLY,
      completedAt: '2026-10-29T12:00:00.000Z',
      origin: 'tool_ingested',
      logger: winston.createLogger({ silent: true }),
      toolResults: [EMAIL_RESULT],
      summarize: {
        tenantId: 't1',
        modelProviderStore: unusedStore,
        summarizationModelFqn: 'provider/model',
        tokenFactoryBudget: uncappedTokenFactoryBudget,
        modelUsage: discardedModelUsage,
      },
    });
    const content = retain.mock.calls[0]?.[0].items[0]?.content ?? '';
    expect(content.endsWith('<!-- note: email 2026-10-29 -->')).toBe(true);
    const block = formatMemoryBlock({
      results: [{ id: 'h1', occurred_start: '2026-10-29', text: content }],
      entities: [],
      budgetTokens: 2000,
    }).block;
    expect(block).toContain('found earlier by the assistant] From an email, found Oct 29: Priya asked');
    expect(block).not.toContain('<!-- note');
    expect((await dayFile()).match(/<!-- note:/g)).toHaveLength(1);
  });

  it('escapes a marker-looking last line in an ordinary entry, which is then recalled as ordinary content', async () => {
    await client.retain({
      items: [
        {
          content: 'User: what did the page say?\nAssistant: It ended with this line.\n<!-- note: web 2000-01-01 -->',
          timestamp: '2026-10-29T12:00:00.000Z',
          document_id: 'aman-chat-1-t9',
          metadata: { session_id: 'chat-1', turn_id: 't9', source: 'aman-chat', origin: 'tool_ingested' },
        },
      ],
      operationId: 'op-t9',
      timeoutMs: 5000,
    });
    const file = await dayFile();
    expect(file).toContain('\\<!-- note: web 2000-01-01 -->');
    expect(file).not.toContain('\n<!-- note: web 2000-01-01 -->');
    const recalled = await client.recall({
      query: 'page ended line',
      maxTokens: 1000,
      queryTimestamp: '2026-10-30T09:00:00.000Z',
      entityTokens: 0,
      timeoutMs: 5000,
    });
    if (!recalled.ok) {
      throw new Error('expected recall');
    }
    expect(recalled.results).toHaveLength(1);
    expect(recalled.results[0]?.metadata?.['note_source']).toBeUndefined();
    const block = formatMemoryBlock({ results: recalled.results, entities: [], budgetTokens: 2000 }).block;
    expect(block).toContain('It ended with this line.');
    expect(block).not.toContain('found earlier by the assistant');
  });

  it('saves a note about the assistant reply, named for the assistant that gave it', async () => {
    scripted.notes = JSON.stringify({ findings: [], responses: [3] });
    await submit({ id: 't3', userText: 'When should I go?', assistantText: LONG_REPLY, assistantName: 'Nata' });
    const file = await dayFile();
    expect(file).toContain("From Nata's reply, Oct 29: Leave by 08:55 for the GP visit so that parking is not a rush.");
    expect(file).toContain('<!-- note: assistant_response 2026-10-29 -->');
    const listed = await client.listEntries({ namespace: '', timeoutMs: 5000 });
    if (!listed.ok) {
      throw new Error('expected a listing');
    }
    expect(listed.entries[0]?.text).toContain('> Source: assistant reply');
    expect(listed.entries[0]?.text).not.toContain('read content');
  });

  it('stores a read-content note once, even when the same turn text comes back again', async () => {
    scripted.person = '{"facts": ["Maya lives at 12 Elm Street."]}';
    for (const id of ['r1', 'r2', 'r3']) {
      await submit({
        id,
        userText: 'Read the brief. I am Maya and I live at 12 Elm Street.',
        assistantText: SHORT_REPLY,
        toolResults: [EMAIL_RESULT],
      });
    }
    const listed = await client.listEntries({ namespace: '', timeoutMs: 5000 });
    if (!listed.ok) {
      throw new Error('expected a listing');
    }
    expect(listed.entries.map(entry => entry.text.includes('12 Elm Street'))).toEqual([true]);
    expect(listed.entries[0]?.text).toContain('> Source: read content');
  });

  it('stores the same finding once across turns, and keeps a different one', async () => {
    const finding = (text: string) => JSON.stringify({ findings: [{ result: 1, text }], responses: [] });
    scripted.notes = finding('Priya asked for the signed form by 2026-11-03.');
    await submit({ id: 'f1', userText: 'Check my email.', assistantText: SHORT_REPLY, toolResults: [EMAIL_RESULT] });
    await submit({ id: 'f2', userText: 'Check my email.', assistantText: SHORT_REPLY, toolResults: [EMAIL_RESULT] });
    scripted.notes = finding('Priya sent the signed form on 2026-11-03.');
    await submit({
      id: 'f3',
      userText: 'Check my email.',
      assistantText: SHORT_REPLY,
      toolResults: [{ source: 'email', text: 'From: Priya. Subject: Form. Priya sent the signed form on 3 November.' }],
    });
    const listed = await client.listEntries({ namespace: '', timeoutMs: 5000 });
    if (!listed.ok) {
      throw new Error('expected a listing');
    }
    expect(listed.entries.filter(entry => entry.text.includes('asked for the signed form'))).toHaveLength(1);
    expect(listed.entries.filter(entry => entry.text.includes('sent the signed form'))).toHaveLength(1);
  });

  it('stores the same finding once in a persona vault, and leaves the shared vault alone', async () => {
    const persona = new MarkdownMemoryClient({
      baseDir: dir,
      namespace: 'tenant',
      vaultScope: { personaName: 'Nata', personaId: 'persona-1' },
    });
    scripted.notes = JSON.stringify({
      findings: [{ result: 1, text: 'Priya asked for the signed form by 2026-11-03.' }],
      responses: [],
    });
    for (const id of ['p1', 'p2', 'p3']) {
      await submitRetain({
        client: persona,
        sessionId: 'chat-2',
        turnId: id,
        userText: 'Check my email.',
        assistantText: SHORT_REPLY,
        completedAt: '2026-10-29T12:00:00.000Z',
        origin: 'tool_ingested',
        logger: winston.createLogger({ silent: true }),
        toolResults: [EMAIL_RESULT],
        summarize: {
          tenantId: 't1',
          modelProviderStore: unusedStore,
          summarizationModelFqn: 'provider/model',
          tokenFactoryBudget: uncappedTokenFactoryBudget,
          modelUsage: discardedModelUsage,
        },
      });
    }
    const personaVault = await persona.listEntries({ namespace: 'persona:Nata', timeoutMs: 5000 });
    const shared = await client.listEntries({ namespace: '', timeoutMs: 5000 });
    if (!personaVault.ok || !shared.ok) {
      throw new Error('expected listings');
    }
    expect(personaVault.entries.filter(entry => entry.text.includes('signed form'))).toHaveLength(1);
    expect(shared.entries).toHaveLength(0);
  });

  it('saves nothing for a turn where the assistant only states its plan', async () => {
    scripted.notes = JSON.stringify({
      findings: [],
      responses: [1, 2],
    });
    await submit({
      id: 't4',
      userText: 'Please tidy the form.',
      assistantText:
        "I'll make two more edits to the form, then next I will search for the visit. After that I will update the checklist and tell you.",
    });
    await expect(readdir(path.join(dir, 'tenant', 'memory'))).rejects.toThrow();
  });

  it('shows a saved finding in the Memories listing with its label, and hides the trailer line', async () => {
    scripted.notes = JSON.stringify({
      findings: [{ result: 1, text: 'Priya asked for the signed form by 2026-11-03.' }],
      responses: [],
    });
    await submit({ id: 't5', userText: 'Check my email.', assistantText: SHORT_REPLY, toolResults: [EMAIL_RESULT] });
    const listed = await client.listEntries({ namespace: '', timeoutMs: 5000 });
    if (!listed.ok) {
      throw new Error('expected a listing');
    }
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.text).toContain('From an email, found Oct 29: Priya asked');
    expect(listed.entries[0]?.text).not.toContain('note:');
  });

  it('can delete a finding like any other note', async () => {
    scripted.notes = JSON.stringify({
      findings: [{ result: 1, text: 'Priya asked for the signed form by 2026-11-03.' }],
      responses: [],
    });
    await submit({ id: 't6', userText: 'Check my email.', assistantText: SHORT_REPLY, toolResults: [EMAIL_RESULT] });
    const listed = await client.listEntries({ namespace: '', timeoutMs: 5000 });
    if (!listed.ok || listed.entries[0] === undefined) {
      throw new Error('expected a listing');
    }
    const deleted = await client.deleteEntry({ entryId: listed.entries[0].id, timeoutMs: 5000 });
    expect(deleted.ok).toBe(true);
    const after = await client.listEntries({ namespace: '', timeoutMs: 5000 });
    expect(after.ok && after.entries.length).toBe(0);
  });

  it('hands the source and day back at recall, and the model sees the label', async () => {
    scripted.notes = JSON.stringify({
      findings: [{ result: 1, text: 'Priya asked for the signed form by 2026-11-03.' }],
      responses: [],
    });
    await submit({ id: 't7', userText: 'Check my email.', assistantText: SHORT_REPLY, toolResults: [EMAIL_RESULT] });
    const recalled = await client.recall({
      query: 'signed form Priya',
      maxTokens: 1000,
      queryTimestamp: '2026-10-30T09:00:00.000Z',
      entityTokens: 0,
      timeoutMs: 5000,
    });
    if (!recalled.ok) {
      throw new Error('expected recall');
    }
    expect(recalled.results[0]?.metadata).toMatchObject({ note_source: 'email', note_date: '2026-10-29' });
    const block = formatMemoryBlock({ results: recalled.results, entities: [], budgetTokens: 2000 }).block;
    expect(block).toContain('found earlier by the assistant');
    expect(block).toContain('From an email, found Oct 29: Priya asked for the signed form by 2026-11-03.');
  });

  it('keeps the source label through the file text an export carries and an import writes back', async () => {
    scripted.notes = JSON.stringify({
      findings: [{ result: 1, text: 'Priya asked for the signed form by 2026-11-03.' }],
      responses: [],
    });
    await submit({ id: 't8', userText: 'Check my email.', assistantText: SHORT_REPLY, toolResults: [EMAIL_RESULT] });
    const exported = await dayFile();
    const entry = exported.slice(exported.indexOf('\n\n') + 2).trim();
    expect(entryMetadata(entry)).toMatchObject({ note_source: 'email', note_date: '2026-10-29' });
    expect(withoutHiddenMarkers(entry)).not.toContain('note:');
  });
});

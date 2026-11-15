import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  emptyChatProvenance,
  steeredUrl,
  type ChatProvenance,
} from '@truefoundry/trueforge-core/core/permissions/provenance';
import { createWebSearchTurnState } from '@truefoundry/trueforge-core/core/permissions/webSearch';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import {
  memoryCapability,
  WRAPPER_OVERHEAD_TOKENS,
  type MemoryConfig,
} from '../../../../src/runtime/memory/memoryCapability';
import type { MemoryClient, RecallItem } from '../../../../src/runtime/memory/memoryClient';
import { loadPagesForMessage } from '../../../../src/runtime/memory/memoryPageLoader';
import { collect, DEFAULT_CONFIG, makeClient, makeExecution, makeLogger } from './memoryCapabilityTestKit';
import { pageText, writePageFile } from './pageFixtures';

const OWN_LINK = 'https://own-cafe.example/menu';
const OWN_ADDRESS = 'own.contact@example.com';
const READ_LINK = 'https://read-shop.example/offer';
const READ_ADDRESS = 'read.sender@example.com';

/** Runs the real step before the model and hands back the chat's record of where links came from. */
async function recallInto(input: {
  client: MemoryClient;
  message: string;
  config?: MemoryConfig;
}): Promise<ChatProvenance> {
  const webSearch = createWebSearchTurnState();
  const capability = memoryCapability({
    client: input.client,
    config: input.config ?? DEFAULT_CONFIG,
    logger: makeLogger(),
    sessionId: 's1',
    previousTurnId: null,
    webSearch,
  });
  const processor = capability.preLLMProcessors?.[0];
  if (!processor) {
    throw new Error('expected a preLLM processor');
  }
  await collect(processor.processPreLLM(makeExecution([{ role: 'user', content: input.message }])));
  return webSearch.provenance;
}

function recallClient(results: RecallItem[]): MemoryClient {
  return makeClient({ recall: jest.fn().mockResolvedValue({ ok: true, results }) });
}

function isTrusted(provenance: ChatProvenance, value: string): boolean {
  return provenance.trusted.addresses.has(value) || provenance.trusted.hosts.has(value);
}

function isRead(provenance: ChatProvenance, value: string): boolean {
  return provenance.untrusted.addresses.has(value) || provenance.untrusted.hosts.has(value);
}

describe('what is recalled from memory keeps its side', () => {
  it('records a confirmed statement as the persons own and an Unconfirmed one as read content', async () => {
    const vaultDir = await mkdtemp(path.join(tmpdir(), 'read-stays-read-'));
    await writePageFile({
      vaultDir,
      kind: 'person',
      slug: 'nora',
      content: pageText({
        front: { kind: 'person', title: 'Nora', aliases: ['Nora'], household: false },
        facts: [
          {
            section: 'Now',
            text: `Likes ${OWN_LINK} and writes from ${OWN_ADDRESS}.`,
            marker: { kind: 'fact', id: 'f_01', src: 'you_said' },
          },
          {
            section: 'Unconfirmed',
            text: `Might use ${READ_LINK} and ${READ_ADDRESS}.`,
            marker: { kind: 'fact', id: 'f_02', src: 'read_content' },
          },
        ],
      }),
    });
    const client: MemoryClient = Object.assign(makeClient({}), {
      loadPages: (input: { message: string; maxPages: number; maxTokens: number }) =>
        loadPagesForMessage({ vaultDirs: [vaultDir], writeVaultDir: vaultDir, ...input }),
    });

    const provenance = await recallInto({ client, message: 'What does Nora like?' });

    expect(isTrusted(provenance, 'own-cafe.example')).toBe(true);
    expect(isTrusted(provenance, OWN_ADDRESS)).toBe(true);
    expect(isRead(provenance, 'own-cafe.example')).toBe(false);
    expect(isRead(provenance, OWN_ADDRESS)).toBe(false);
    expect(isRead(provenance, 'read-shop.example')).toBe(true);
    expect(isRead(provenance, READ_ADDRESS)).toBe(true);
    expect(isTrusted(provenance, 'read-shop.example')).toBe(false);
    expect(isTrusted(provenance, READ_ADDRESS)).toBe(false);
    expect(provenance.read_from.get(`address:${READ_ADDRESS}`)?.source).toBe('memory');
    expect(provenance.read_from.get('site:read-shop.example')?.source).toBe('memory');
  });

  it('records a note the person stated as theirs and a note from a turn that read outside text as read content', async () => {
    const provenance = await recallInto({
      client: recallClient([
        { id: '1', text: `Order from ${OWN_LINK}, mail ${OWN_ADDRESS}.`, metadata: { origin: 'user_stated' } },
        { id: '2', text: `A mail named ${READ_LINK} and ${READ_ADDRESS}.`, metadata: { origin: 'tool_ingested' } },
      ]),
      message: 'what did I order',
    });

    expect(isTrusted(provenance, 'own-cafe.example')).toBe(true);
    expect(isTrusted(provenance, OWN_ADDRESS)).toBe(true);
    expect(isRead(provenance, 'own-cafe.example')).toBe(false);
    expect(isRead(provenance, READ_ADDRESS)).toBe(true);
    expect(isRead(provenance, 'read-shop.example')).toBe(true);
    expect(isTrusted(provenance, READ_ADDRESS)).toBe(false);
    expect(isTrusted(provenance, 'read-shop.example')).toBe(false);
    expect(provenance.read_from.get(`address:${READ_ADDRESS}`)?.source).toBe('tool_result');
  });

  it('keeps a link the person typed as theirs when a mail named the same link', async () => {
    const provenance = await recallInto({
      client: recallClient([
        { id: '1', text: `Book at ${READ_LINK}.`, metadata: { origin: 'user_stated' } },
        { id: '2', text: `A mail named ${READ_LINK}.`, metadata: { origin: 'tool_ingested' } },
      ]),
      message: 'where do I book',
    });

    expect(isTrusted(provenance, 'read-shop.example')).toBe(true);
    expect(steeredUrl({ provenance, url: READ_LINK })).toBe(false);
  });

  it('counts a note with no stamped origin as read content', async () => {
    const provenance = await recallInto({
      client: recallClient([{ id: '1', text: `Seen at ${READ_LINK}, mail ${READ_ADDRESS}.` }]),
      message: 'what did I see',
    });

    expect(isRead(provenance, READ_ADDRESS)).toBe(true);
    expect(isTrusted(provenance, READ_ADDRESS)).toBe(false);
  });

  it('records a line the budget dropped on neither side', async () => {
    const provenance = await recallInto({
      client: recallClient([
        { id: '1', text: `Short note ${OWN_ADDRESS}.`, metadata: { origin: 'user_stated' } },
        {
          id: '2',
          text: `${'filler words '.repeat(60)}${READ_LINK} ${READ_ADDRESS}`,
          metadata: { origin: 'tool_ingested' },
        },
      ]),
      message: 'what is in my notes',
      config: { ...DEFAULT_CONFIG, recallMaxTokens: Math.ceil(WRAPPER_OVERHEAD_TOKENS) + 40 },
    });

    expect(isTrusted(provenance, OWN_ADDRESS)).toBe(true);
    expect(isTrusted(provenance, READ_ADDRESS)).toBe(false);
    expect(isRead(provenance, READ_ADDRESS)).toBe(false);
    expect(isRead(provenance, 'read-shop.example')).toBe(false);
    expect(provenance).not.toEqual(emptyChatProvenance());
  });

  it('keeps the two sides for notes saved in the Markdown store, which writes a source line only on what was read', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'read-stays-read-store-'));
    try {
      const client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' });
      const timestamp = new Date().toISOString();
      await client.retain({
        items: [
          {
            timestamp,
            context: 'Order',
            content: `I order from ${OWN_LINK} and write to ${OWN_ADDRESS}.`,
            document_id: 'doc-own',
            metadata: { origin: 'user_stated' },
          },
          {
            timestamp,
            context: 'Order',
            content: `A mail said to order from ${READ_LINK} and write to ${READ_ADDRESS}.`,
            document_id: 'doc-read',
            metadata: { origin: 'tool_ingested' },
          },
        ],
        operationId: 'op-sides',
        timeoutMs: 5000,
      });

      const provenance = await recallInto({ client, message: 'where do I order and who do I write to' });

      expect(isTrusted(provenance, 'own-cafe.example')).toBe(true);
      expect(isTrusted(provenance, OWN_ADDRESS)).toBe(true);
      expect(isRead(provenance, 'own-cafe.example')).toBe(false);
      expect(isRead(provenance, OWN_ADDRESS)).toBe(false);
      expect(isRead(provenance, 'read-shop.example')).toBe(true);
      expect(isRead(provenance, READ_ADDRESS)).toBe(true);
      expect(isTrusted(provenance, 'read-shop.example')).toBe(false);
      expect(isTrusted(provenance, READ_ADDRESS)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

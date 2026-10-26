/**
 * The chat route tells the memory capability whether summaries are on for the turn, so a vanished
 * earlier turn is never rebuilt as a raw exchange while they are.
 */
import { z } from '@hono/zod-openapi';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import configuration from '../../../src/config';
import { hindsightMemoryCapability } from '../../../src/runtime/memory/memoryCapability';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

jest.mock('../../../src/runtime/memory/memoryCapability', () => {
  const actual = jest.requireActual<typeof import('../../../src/runtime/memory/memoryCapability')>(
    '../../../src/runtime/memory/memoryCapability',
  );
  return { ...actual, hindsightMemoryCapability: jest.fn(actual.hindsightMemoryCapability) };
});

const mockCapability = jest.mocked(hindsightMemoryCapability);

const TURN_TIMEOUT_MS = 60_000;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Answer the user.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function runChatTurn(server: ApprovalTestServer): Promise<void> {
  const created = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const sessionId = z.object({ data: z.object({ id: z.string() }).loose() }).parse(await created.json()).data.id;
  const response = await server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({ input: [{ type: 'user.message', content: 'Hello there.' }], stream: true }),
  );
  expect(response.status).toBe(200);
  await response.text();
}

describe('the chat route and turn summaries', () => {
  const original = {
    backend: configuration.MEMORY_BACKEND,
    directory: configuration.MEMORY_MARKDOWN_DIR,
    embeddings: configuration.MEMORY_EMBEDDINGS_ENABLED,
    summarize: configuration.MEMORY_SUMMARIZE,
  };
  let memoryDir = '';
  let server: ApprovalTestServer;

  beforeAll(async () => {
    memoryDir = await mkdtemp(path.join(tmpdir(), 'turn-summaries-wiring-'));
    configuration.MEMORY_BACKEND = 'markdown';
    configuration.MEMORY_MARKDOWN_DIR = memoryDir;
    configuration.MEMORY_EMBEDDINGS_ENABLED = false;
    server = await startApprovalTestServer();
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    configuration.MEMORY_BACKEND = original.backend;
    configuration.MEMORY_MARKDOWN_DIR = original.directory;
    configuration.MEMORY_EMBEDDINGS_ENABLED = original.embeddings;
    configuration.MEMORY_SUMMARIZE = original.summarize;
    await server.close();
    await rm(memoryDir, { recursive: true, force: true });
  }, TURN_TIMEOUT_MS);

  beforeEach(() => {
    mockCapability.mockClear();
  });

  it.each([
    [true, false],
    [false, true],
  ])(
    'with summaries %s, a chat turn gives the capability keepsFullExchange=%s',
    async (summariesOn, keepsFullExchange) => {
      configuration.MEMORY_SUMMARIZE = summariesOn;
      await runChatTurn(server);

      expect(mockCapability).toHaveBeenCalled();
      expect(mockCapability.mock.calls.map(([input]) => input.keepsFullExchange)).toEqual(
        mockCapability.mock.calls.map(() => keepsFullExchange),
      );
    },
    TURN_TIMEOUT_MS,
  );
});

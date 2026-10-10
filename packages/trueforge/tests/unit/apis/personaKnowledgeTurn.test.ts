/**
 * Persona knowledge over the HTTP surface: a synthetic document uploaded to one
 * persona's library reaches that persona's model request as a knowledge block,
 * and nothing reaches a persona (or the default assistant) without one. The
 * scripted model endpoint's request log is the judge.
 */
import { z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TENANT_ID } from '../../../src/apis/sessions';
import type { Authenticator } from '../../../src/auth/authenticator';
import configuration from '../../../src/config';
import { personaKnowledgeLocation } from '../../../src/personaKnowledge/knowledgePaths';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import {
  GetKnowledgeDocumentResponseSchema,
  ListKnowledgeDocumentsResponseSchema,
  type KnowledgeDocumentStatus,
} from '../../../src/schemas/personaKnowledge';
import {
  ALT_MODEL_FQN,
  MODEL_FQN,
  startApprovalTestServer,
  type ApprovalTestServer,
} from '../../fixtures/approvalTestServer';

const TURN_TIMEOUT_MS = 60_000;

function unitVector(): number[] {
  const vector = new Array<number>(384).fill(0);
  vector[0] = 1;
  return vector;
}

// Every passage and query embeds to the same vector, so any ready chunk clears
// the similarity floor: the test exercises the wiring, not ranking quality.
const mockEmbeddingModel = {
  currentPhase: 'ready',
  failureReason: '',
  ensureReady: async () => true,
  embedQueries: async (texts: string[]) => texts.map(() => unitVector()),
  embedPassages: async (texts: string[]) => texts.map(() => unitVector()),
};

jest.mock('../../../src/runtime/memory/embeddingModel', () => ({
  ...jest.requireActual<typeof import('../../../src/runtime/memory/embeddingModel')>(
    '../../../src/runtime/memory/embeddingModel',
  ),
  getSharedEmbeddingModel: () => mockEmbeddingModel,
  isEmbeddingModelCached: () => false,
}));

const SYNTHETIC_FACT = 'The Lantern Row bakery opened on 14 March 2019 and is known for its caraway rye loaf.';

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

const IdResponseSchema = z.object({ data: z.object({ id: z.string() }).loose() });

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createSession(server: ApprovalTestServer): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  expect(response.status).toBe(201);
  return IdResponseSchema.parse(await response.json()).data.id;
}

async function createPersona(server: ApprovalTestServer, displayName: string): Promise<string> {
  const response = await server.request(
    '/api/v1/personas',
    jsonInit({
      persona: { display_name: displayName, aliases: [], instructions: 'Answer plainly.', model_name: ALT_MODEL_FQN },
    }),
  );
  expect(response.status).toBe(201);
  return IdResponseSchema.parse(await response.json()).data.id;
}

async function uploadDocument(server: ApprovalTestServer, personaId: string): Promise<string> {
  const response = await server.request(
    `/api/v1/personas/${personaId}/knowledge`,
    jsonInit({
      kind: 'upload',
      filename: 'lantern-row-notes.txt',
      content_base64: Buffer.from(SYNTHETIC_FACT, 'utf-8').toString('base64'),
    }),
  );
  expect(response.status).toBe(201);
  return GetKnowledgeDocumentResponseSchema.parse(await response.json()).data.id;
}

async function waitForStatus(
  server: ApprovalTestServer,
  input: { personaId: string; documentId: string; status: KnowledgeDocumentStatus },
): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const response = await server.request(`/api/v1/personas/${input.personaId}/knowledge`);
    expect(response.status).toBe(200);
    const documents = ListKnowledgeDocumentsResponseSchema.parse(await response.json()).data;
    const document = documents.find(candidate => candidate.id === input.documentId);
    if (document?.status === input.status) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${input.status}; last saw ${String(document?.status)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Runs one turn to completion by draining its SSE stream. */
async function runTurn(server: ApprovalTestServer, input: { sessionId: string; content: string }): Promise<void> {
  const response = await server.request(
    `/api/v1/sessions/${input.sessionId}/turns`,
    jsonInit({ input: [{ type: 'user.message', content: input.content }], stream: true }),
  );
  expect(response.status).toBe(200);
  const events = (await response.text())
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length))));
  expect(events.some(event => event.type === 'turn.done')).toBe(true);
}

/** The turn's own streamed completion: the last request a chat turn sends. */
function lastTurnCompletion(server: ApprovalTestServer) {
  const latest = server.model
    .requests()
    .filter(request => request.stream)
    .at(-1);
  if (latest === undefined) {
    throw new Error('the scripted model endpoint never served a turn');
  }
  const system = latest.messages
    .filter(message => message.role === 'system')
    .map(message => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
  return { model: latest.model, system };
}

describe('persona knowledge at turn time', () => {
  const originalKnowledgeDir = configuration.PERSONA_KNOWLEDGE_DIR;
  const originalEmbeddingsEnabled = configuration.MEMORY_EMBEDDINGS_ENABLED;
  let knowledgeDir: string;
  let server: ApprovalTestServer;

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'persona-knowledge-turn-'));
    configuration.PERSONA_KNOWLEDGE_DIR = knowledgeDir;
    // Memory recall is orthogonal here; keep it off the mocked embedding model.
    configuration.MEMORY_EMBEDDINGS_ENABLED = false;
    server = await startApprovalTestServer();
    const summarize = await server.request('/api/v1/settings/memory-summarize', jsonInit({ enabled: false }, 'PUT'));
    expect(summarize.status).toBe(200);
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
    configuration.PERSONA_KNOWLEDGE_DIR = originalKnowledgeDir;
    configuration.MEMORY_EMBEDDINGS_ENABLED = originalEmbeddingsEnabled;
    await rm(knowledgeDir, { recursive: true, force: true });
  }, TURN_TIMEOUT_MS);

  it(
    'answers from an uploaded document through the persona knowledge block',
    async () => {
      const personaId = await createPersona(server, 'Quill');
      const documentId = await uploadDocument(server, personaId);
      await waitForStatus(server, { personaId, documentId, status: 'ready' });
      const sessionId = await createSession(server);

      await runTurn(server, { sessionId, content: 'Quill, when did the Lantern Row bakery open?' });

      const completion = lastTurnCompletion(server);
      expect(completion.model).toBe('scripted-alt-model');
      expect(completion.system).toContain('<persona-name>Quill</persona-name>');
      expect(completion.system).toContain('<persona-knowledge>');
      expect(completion.system).toContain('14 March 2019');
      expect(completion.system).toContain('lantern-row-notes.txt');
      // The relevance judge saw the passage on the persona's own model before the turn ran.
      const judged = server.model.requests().filter(request => {
        const text = JSON.stringify(request.messages);
        return text.includes('<knowledge-relevance-judge') && text.includes('14 March 2019');
      });
      expect(judged.map(request => request.model)).toEqual(['scripted-alt-model']);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'injects no knowledge block for a persona without a library or for the default assistant',
    async () => {
      await createPersona(server, 'Sable');
      const sessionId = await createSession(server);

      await runTurn(server, { sessionId, content: 'Sable, when did the Lantern Row bakery open?' });
      const persona = lastTurnCompletion(server);
      expect(persona.system).toContain('<persona-name>Sable</persona-name>');
      expect(persona.system).not.toContain('<persona-knowledge>');
      expect(persona.system).not.toContain('14 March 2019');

      const defaultSession = await createSession(server);
      await runTurn(server, { sessionId: defaultSession, content: 'When did the Lantern Row bakery open?' });
      const assistant = lastTurnCompletion(server);
      expect(assistant.model).toBe('scripted-model');
      expect(assistant.system).not.toContain('<persona-knowledge>');
      expect(assistant.system).not.toContain('14 March 2019');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'removes a persona library when the persona is deleted',
    async () => {
      const personaId = await createPersona(server, 'Wren');
      const documentId = await uploadDocument(server, personaId);
      await waitForStatus(server, { personaId, documentId, status: 'ready' });
      const { dbPath } = personaKnowledgeLocation({ knowledgeDir, tenantId: TENANT_ID, personaId });
      expect(existsSync(dbPath)).toBe(true);

      const deleted = await server.request(`/api/v1/personas/${personaId}`, { method: 'DELETE' });

      expect(deleted.status).toBe(200);
      expect(existsSync(dbPath)).toBe(false);
    },
    TURN_TIMEOUT_MS,
  );
});

describe('persona knowledge routes', () => {
  it(
    'are mounted behind the auth middleware',
    async () => {
      const rejecting: Authenticator = {
        authenticate: () => Promise.reject(new HTTPException(401, { message: 'Authentication required' })),
      };
      const server = await startApprovalTestServer({ authenticator: rejecting });
      try {
        const list = await server.request('/api/v1/personas/persona-x/knowledge');
        expect(list.status).toBe(401);
        const create = await server.request(
          '/api/v1/personas/persona-x/knowledge',
          jsonInit({ kind: 'text', title: 'Notes', text: SYNTHETIC_FACT }),
        );
        expect(create.status).toBe(401);
      } finally {
        await server.close();
      }
    },
    TURN_TIMEOUT_MS,
  );
});

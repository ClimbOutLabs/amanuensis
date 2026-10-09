/**
 * Proves the turn path scopes markdown memory by persona over the real HTTP surface:
 * the retain lands in the active persona's vault (or the shared vault with none), and
 * recall reads only the vaults that persona may see. The judge is the scripted model
 * endpoint's request log plus the vault directories on disk.
 */
import { z } from '@hono/zod-openapi';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import configuration from '../../../src/config';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import {
  ALT_MODEL_FQN,
  MODEL_FQN,
  startApprovalTestServer,
  type ApprovalTestServer,
} from '../../fixtures/approvalTestServer';

const TURN_TIMEOUT_MS = 60_000;
const RETAIN_TIMEOUT_MS = 10_000;

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

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createSession(server: ApprovalTestServer): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

async function createPersona(server: ApprovalTestServer, displayName: string): Promise<void> {
  const response = await server.request(
    '/api/v1/personas',
    jsonInit({
      persona: {
        display_name: displayName,
        aliases: [],
        instructions: 'Answer as a careful archivist.',
        model_name: ALT_MODEL_FQN,
      },
    }),
  );
  if (response.status !== 201) {
    throw new Error(`persona create failed (${String(response.status)}): ${await response.text()}`);
  }
}

/** Runs one turn to completion by draining its SSE stream. */
async function runTurn(server: ApprovalTestServer, options: { sessionId: string; content: string }): Promise<void> {
  const response = await server.request(
    `/api/v1/sessions/${options.sessionId}/turns`,
    jsonInit({ input: [{ type: 'user.message', content: options.content }], stream: true }),
  );
  if (response.status !== 200) {
    throw new Error(`create turn failed (${String(response.status)}): ${await response.text()}`);
  }
  const streamBody = await response.text();
  const types = streamBody
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length))).type);
  expect(types).toContain('turn.created');
}

/** Everything the scripted model was sent for the latest completion, as searchable text. */
function lastModelRequestText(server: ApprovalTestServer): string {
  const requests = server.model.requests();
  const latest = requests[requests.length - 1];
  if (latest === undefined) {
    throw new Error('the scripted model endpoint was never called');
  }
  return JSON.stringify(latest.messages);
}

async function vaultLog(directory: string): Promise<string | undefined> {
  const dailyDir = path.join(directory, 'memory');
  try {
    const files = (await readdir(dailyDir)).filter(name => name.endsWith('.md'));
    const contents = await Promise.all(files.map(file => readFile(path.join(dailyDir, file), 'utf8')));
    return contents.join('\n');
  } catch {
    return undefined;
  }
}

/** The retain runs after the turn's answer, so wait for the vault log to appear. */
async function waitForVaultLog(directory: string): Promise<string> {
  const start = Date.now();
  for (;;) {
    const log = await vaultLog(directory);
    if (log !== undefined) {
      return log;
    }
    if (Date.now() - start > RETAIN_TIMEOUT_MS) {
      throw new Error(`no memory was retained under ${directory}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe('persona memory vaults over the turn path', () => {
  const original = {
    backend: configuration.MEMORY_BACKEND,
    directory: configuration.MEMORY_MARKDOWN_DIR,
    embeddings: configuration.MEMORY_EMBEDDINGS_ENABLED,
    summarize: configuration.MEMORY_SUMMARIZE,
  };
  let memoryDir = '';
  let server: ApprovalTestServer;

  beforeAll(async () => {
    memoryDir = await mkdtemp(path.join(tmpdir(), 'persona-memory-'));
    configuration.MEMORY_BACKEND = 'markdown';
    configuration.MEMORY_MARKDOWN_DIR = memoryDir;
    configuration.MEMORY_EMBEDDINGS_ENABLED = false;
    configuration.MEMORY_SUMMARIZE = false;
    server = await startApprovalTestServer();
    await createPersona(server, 'Zara');
    await createPersona(server, 'Mirela');
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    configuration.MEMORY_BACKEND = original.backend;
    configuration.MEMORY_MARKDOWN_DIR = original.directory;
    configuration.MEMORY_EMBEDDINGS_ENABLED = original.embeddings;
    configuration.MEMORY_SUMMARIZE = original.summarize;
    await server.close();
    await rm(memoryDir, { recursive: true, force: true });
  }, TURN_TIMEOUT_MS);

  it(
    'retains a persona turn into that persona vault and recalls it only for that persona',
    async () => {
      await runTurn(server, {
        sessionId: await createSession(server),
        content: 'Zara, note that my favourite fruit is the medlar.',
      });
      expect(await waitForVaultLog(path.join(memoryDir, 'default__persona_Zara'))).toContain('medlar');
      expect(await vaultLog(path.join(memoryDir, 'default'))).toBeUndefined();

      await runTurn(server, {
        sessionId: await createSession(server),
        content: 'Zara, which fruit is my favourite?',
      });
      expect(lastModelRequestText(server)).toContain('medlar');

      await runTurn(server, {
        sessionId: await createSession(server),
        content: 'Mirela, which fruit is my favourite?',
      });
      expect(lastModelRequestText(server)).not.toContain('medlar');

      await runTurn(server, {
        sessionId: await createSession(server),
        content: 'Which fruit is my favourite?',
      });
      expect(lastModelRequestText(server)).not.toContain('medlar');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'retains a no-persona turn into the shared vault and recalls it for every persona',
    async () => {
      await runTurn(server, {
        sessionId: await createSession(server),
        content: 'Please note that our neighbour keeps a tortoise called Quillon.',
      });
      expect(await waitForVaultLog(path.join(memoryDir, 'default'))).toContain('Quillon');

      await runTurn(server, {
        sessionId: await createSession(server),
        content: 'Mirela, what is the neighbour tortoise called?',
      });
      expect(lastModelRequestText(server)).toContain('Quillon');
    },
    TURN_TIMEOUT_MS,
  );
});

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

async function createPersona(server: ApprovalTestServer, displayName: string): Promise<string> {
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
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`persona create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

/** Puts the session back on the default assistant, as the persona pill does. */
async function clearSessionPersona(server: ApprovalTestServer, sessionId: string): Promise<void> {
  const response = await server.request(`/api/v1/sessions/${sessionId}/persona`, jsonInit({ persona_id: null }, 'PUT'));
  if (response.status !== 200) {
    throw new Error(`clearing the session persona failed (${String(response.status)}): ${await response.text()}`);
  }
}

async function putSharing(server: ApprovalTestServer, shares: Record<string, string[]>): Promise<void> {
  const response = await server.request('/api/v1/memory/vault/sharing', jsonInit({ shares }, 'PUT'));
  if (response.status !== 200) {
    throw new Error(`sharing update failed (${String(response.status)}): ${await response.text()}`);
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

/** The retain runs after the turn's answer, so wait for the vault log to hold the text. */
async function waitForVaultText(directory: string, needle: string): Promise<string> {
  const start = Date.now();
  for (;;) {
    const log = await vaultLog(directory);
    if (log?.includes(needle) === true) {
      return log;
    }
    if (Date.now() - start > RETAIN_TIMEOUT_MS) {
      throw new Error(`"${needle}" was never retained under ${directory}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
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
  let zaraId = '';
  let mirelaId = '';

  const vaultDir = (name: string): string => path.join(memoryDir, name);
  const zaraVault = (): string => vaultDir('default__persona_Zara');
  const mirelaVault = (): string => vaultDir('default__persona_Mirela');
  const sharedVault = (): string => vaultDir('default');

  beforeAll(async () => {
    memoryDir = await mkdtemp(path.join(tmpdir(), 'persona-memory-'));
    configuration.MEMORY_BACKEND = 'markdown';
    configuration.MEMORY_MARKDOWN_DIR = memoryDir;
    configuration.MEMORY_EMBEDDINGS_ENABLED = false;
    configuration.MEMORY_SUMMARIZE = false;
    server = await startApprovalTestServer();
    zaraId = await createPersona(server, 'Zara');
    mirelaId = await createPersona(server, 'Mirela');
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
      expect(await waitForVaultText(path.join(memoryDir, 'default__persona_Zara'), 'medlar')).toContain('medlar');
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
      expect(await waitForVaultText(path.join(memoryDir, 'default'), 'Quillon')).toContain('Quillon');

      await runTurn(server, {
        sessionId: await createSession(server),
        content: 'Mirela, what is the neighbour tortoise called?',
      });
      expect(lastModelRequestText(server)).toContain('Quillon');
    },
    TURN_TIMEOUT_MS,
  );

  describe('switching speakers inside one session', () => {
    it(
      'does not copy a persona turn into another persona vault',
      async () => {
        const sessionId = await createSession(server);
        await runTurn(server, { sessionId, content: 'Zara, note that the lighthouse keeper is called Tobiah.' });
        await waitForVaultText(zaraVault(), 'Tobiah');
        await runTurn(server, { sessionId, content: 'Mirela, note that the harbour cat is called Pepin.' });

        const mirelaLog = await waitForVaultText(mirelaVault(), 'Pepin');
        expect(mirelaLog).not.toContain('Tobiah');
        expect(await vaultLog(zaraVault())).not.toContain('Pepin');
        expect(occurrences((await vaultLog(zaraVault())) ?? '', 'Tobiah')).toBe(1);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'does not copy a persona turn into the shared vault',
      async () => {
        const sessionId = await createSession(server);
        await runTurn(server, { sessionId, content: 'Zara, note that the clock-tower gardener is Ottoline.' });
        await waitForVaultText(zaraVault(), 'Ottoline');
        await clearSessionPersona(server, sessionId);
        await runTurn(server, { sessionId, content: 'Please note that the market baker is Cassian.' });

        const sharedLog = await waitForVaultText(sharedVault(), 'Cassian');
        expect(sharedLog).not.toContain('Ottoline');
        expect(await vaultLog(zaraVault())).not.toContain('Cassian');
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'does not copy a shared-vault turn into a persona vault',
      async () => {
        const sessionId = await createSession(server);
        await runTurn(server, { sessionId, content: 'Please note that the ferry captain is Dorothea.' });
        await waitForVaultText(sharedVault(), 'Dorothea');
        await runTurn(server, { sessionId, content: 'Zara, note that the bell ringer is Ignatius.' });

        const zaraLog = await waitForVaultText(zaraVault(), 'Ignatius');
        // The chat title is session metadata on every entry; the earlier exchange itself must stay out.
        expect(zaraLog).not.toContain('User: Please note that the ferry captain');
        expect(occurrences((await vaultLog(sharedVault())) ?? '', 'User: Please note that the ferry captain')).toBe(1);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'still verifies the previous turn without duplicating it when the persona stays the same',
      async () => {
        const sessionId = await createSession(server);
        await runTurn(server, { sessionId, content: 'Zara, note that the cellar is stocked with Lambrusco.' });
        await waitForVaultText(zaraVault(), 'Lambrusco');
        await runTurn(server, { sessionId, content: 'And what else is on the second shelf?' });
        await waitForVaultText(zaraVault(), 'second shelf');

        expect(occurrences((await vaultLog(zaraVault())) ?? '', 'Lambrusco')).toBe(1);
      },
      TURN_TIMEOUT_MS,
    );
  });

  it(
    'recalls a vault granted over the sharing API and stops once the grant is revoked',
    async () => {
      await runTurn(server, {
        sessionId: await createSession(server),
        content: 'Zara, note that my favourite spice is the sumac.',
      });
      await waitForVaultText(zaraVault(), 'sumac');
      const askMirela = async (): Promise<string> => {
        await runTurn(server, {
          sessionId: await createSession(server),
          content: 'Mirela, which spice is my favourite?',
        });
        return lastModelRequestText(server);
      };

      expect(await askMirela()).not.toContain('sumac');

      await putSharing(server, { [mirelaId]: ['persona:Zara'] });
      expect(await askMirela()).toContain('sumac');

      await putSharing(server, {});
      expect(await askMirela()).not.toContain('sumac');
      expect(zaraId).not.toBe(mirelaId);
    },
    TURN_TIMEOUT_MS,
  );
});

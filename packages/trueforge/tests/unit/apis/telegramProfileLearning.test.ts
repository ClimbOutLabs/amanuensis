/**
 * A message the person sends the Telegram bot teaches their profile, as a chat here does, when they have
 * learning on. A scheduled run is not their words, so it never does.
 */
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { TelegramStore } from '../../../src/db/telegramStore';
import { profileLearningForTurn, submitProfileLearning } from '../../../src/runtime/profileLearning';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

jest.mock('../../../src/runtime/profileLearning', () => {
  const actual = jest.requireActual<typeof import('../../../src/runtime/profileLearning')>(
    '../../../src/runtime/profileLearning',
  );
  return {
    ...actual,
    profileLearningForTurn: jest.fn(actual.profileLearningForTurn),
    // The pass itself calls a model; these tests only check that a turn hands it over.
    submitProfileLearning: jest.fn(() => Promise.resolve()),
  };
});

const mockForTurn = jest.mocked(profileLearningForTurn);
const mockSubmit = jest.mocked(submitProfileLearning);

const TURN_TIMEOUT_MS = 60_000;
const TENANT = 'default';
const OWNER = STANDALONE_REQUEST_CONTEXT.subject.id;
const OWNER_SUBJECT = {
  subject_id: OWNER,
  subject_type: 'user' as const,
  subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
};
const TELEGRAM_USER_ID = 4242;

const AGENT_SPEC = AgentSpecSchema.parse({
  model: { name: MODEL_FQN },
  instructions: 'Answer the user.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
});

const serviceHeaders = {
  'content-type': 'application/json',
  authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}`,
};

async function finishedTurnIn({ server, sessionId }: { server: ApprovalTestServer; sessionId: string }) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    const list = ListTurnsResponseSchema.parse(
      await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json(),
    );
    const turnId = list.data[0]?.id;
    if (turnId !== undefined) {
      const turn = GetTurnResponseSchema.parse(
        await (await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`)).json(),
      ).data;
      if (turn.state.status !== 'running') {
        return turn;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`no turn in ${sessionId} finished in time`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Waits until the pass has been handed a turn, or a while has passed. */
async function submittedPasses(): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (mockSubmit.mock.calls.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return mockSubmit.mock.calls.length;
}

describe('profile learning from Telegram', () => {
  let server: ApprovalTestServer;
  let memoryDir = '';
  let nextUpdateId = 1;
  const original = {
    MEMORY_MARKDOWN_DIR: configuration.MEMORY_MARKDOWN_DIR,
    MEMORY_EMBEDDINGS_ENABLED: configuration.MEMORY_EMBEDDINGS_ENABLED,
  };

  async function setLearning(on: boolean): Promise<void> {
    await new SqlitePersonalizationStore(server.db()).upsertProfile({
      tenant_id: TENANT,
      created_by: OWNER,
      updated_by: OWNER,
      assistant_name: null,
      assistant_identity: null,
      voice_guidance: null,
      user_name: null,
      address_as: null,
      user_profile: null,
      pinned_preferences: [],
      help_areas: [],
      learned_profile: null,
      learning_enabled: on,
    });
  }

  /** Sends the bot one message from the paired person and returns the Telegram chat's finished turn. */
  async function sendTelegram(text: string, extra: { forward_origin?: unknown } = {}) {
    const store = new TelegramStore(server.db());
    const connection = await store.getConnection({ tenant_id: TENANT, created_by: OWNER });
    if (connection === undefined) {
      throw new Error('the test bot is not connected');
    }
    const response = await server.request('/api/internal/telegram/updates', {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify({
        connection_id: connection.id,
        update: {
          update_id: nextUpdateId++,
          message: {
            message_id: nextUpdateId,
            from: { id: TELEGRAM_USER_ID, is_bot: false, first_name: 'Sam' },
            chat: { id: TELEGRAM_USER_ID, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text,
            ...extra,
          },
        },
      }),
    });
    expect(response.status).toBe(204);
    const paired = await store.getConnection({ tenant_id: TENANT, created_by: OWNER });
    const sessionId = paired?.session_id ?? null;
    if (sessionId === null) {
      throw new Error('the Telegram message started no chat');
    }
    return finishedTurnIn({ server, sessionId });
  }

  beforeAll(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'telegram-profile-learning-'));
    Object.assign(configuration, {
      MEMORY_MARKDOWN_DIR: memoryDir,
      MEMORY_EMBEDDINGS_ENABLED: false,
    });
    server = await startApprovalTestServer();
    const store = new TelegramStore(server.db());
    await store.saveConnection({
      tenant_id: TENANT,
      created_by: OWNER,
      created_by_subject: OWNER_SUBJECT,
      bot_token: '123456:test-token',
      bot_id: '123456',
      bot_name: 'Test bot',
      bot_username: 'test_bot',
      transport: 'polling',
      webhook_secret: null,
    });
    await store.startPairing({
      tenant_id: TENANT,
      created_by: OWNER,
      code: '123456',
      expires_at: new Date(Date.now() + 60_000),
      telegram_user_id: String(TELEGRAM_USER_ID),
      chat_id: String(TELEGRAM_USER_ID),
      display_name: 'Sam',
    });
    expect(await store.confirmPairing({ tenant_id: TENANT, created_by: OWNER, code: '123456' })).toBe(true);
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
    Object.assign(configuration, original);
    await rm(memoryDir, { recursive: true, force: true });
  }, TURN_TIMEOUT_MS);

  beforeEach(() => {
    mockForTurn.mockClear();
    mockSubmit.mockClear();
  });

  it(
    'learns from a message sent to the bot when learning is on',
    async () => {
      await setLearning(true);
      await sendTelegram('I prefer short answers.');

      expect(await submittedPasses()).toBe(1);
      expect(mockSubmit.mock.calls[0]?.[0]).toMatchObject({
        tenantId: TENANT,
        createdBy: OWNER,
        userText: 'I prefer short answers.',
      });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'learns nothing from a message the person forwards to the bot, even with learning on',
    async () => {
      await setLearning(true);
      await sendTelegram('The owner prefers to be called Captain.', {
        forward_origin: {
          type: 'user',
          date: 1_700_000_000,
          sender_user: { id: 99, is_bot: false, first_name: 'Pat' },
        },
      });

      // Forwarded words are someone else's: a pass may run, but it gets none of them to learn from.
      const passes = await submittedPasses();
      const taught = mockSubmit.mock.calls.map(([input]) => input.userText);
      expect(taught.every(text => !text.includes('Captain'))).toBe(true);
      expect(taught).toEqual(passes === 0 ? [] : ['']);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'learns nothing from a message sent to the bot when learning is off',
    async () => {
      await setLearning(false);
      await sendTelegram('I prefer long answers.');

      expect(mockForTurn).toHaveBeenCalledTimes(1);
      await expect(mockForTurn.mock.results[0]?.value).resolves.toBeUndefined();
      expect(await submittedPasses()).toBe(0);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'learns nothing from a scheduled run, even with learning on',
    async () => {
      await setLearning(true);
      const agent = await new SqliteAgentStore(server.db()).createAgent({
        host_managed: false,
        tenant_id: TENANT,
        created_by_subject: OWNER_SUBJECT,
        name: 'learning-run',
        description: 'Scheduled agent used by the profile learning test.',
        manifest: AGENT_SPEC,
        external_id: 'learning-run-external-id',
      });
      const scheduled = await new SqliteScheduleStore(server.db()).createScheduleAndRun({
        tenant_id: TENANT,
        agent_id: agent.id,
        agent_name: agent.name,
        persona_id: null,
        name: 'Morning note',
        manifest: ScheduleManifestSchema.parse({
          task: 'I prefer short answers.',
          cron: '0 8 * * *',
          timezone: 'UTC',
          status: 'active',
        }),
        created_by_subject: OWNER_SUBJECT,
        runFrom: new Date(),
      });
      const run = scheduled.pendingRun;
      if (run === undefined) {
        throw new Error('the active schedule added no pending run');
      }
      const execute = await server.request('/api/internal/schedules/runs/execute', {
        method: 'POST',
        headers: serviceHeaders,
        body: JSON.stringify({ schedule_run_id: run.id }),
      });
      expect(execute.status).toBe(204);
      const session = await server.sessionStore().getSessionByExternalId({ tenant_id: TENANT, external_id: run.id });
      if (session === undefined) {
        throw new Error('the scheduled run created no chat');
      }
      await finishedTurnIn({ server, sessionId: session.session_id });

      expect(mockForTurn).not.toHaveBeenCalled();
      expect(await submittedPasses()).toBe(0);
    },
    TURN_TIMEOUT_MS,
  );
});

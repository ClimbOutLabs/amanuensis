import {
  AgentSpecSchema,
  EventType,
  SessionHandle,
  type TurnDoneEvent,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import type { ILLM } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';

import { beginTurnExecution, drainTurnEvents } from '../../../src/apis/turns';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteRepositoryStore } from '../../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteSpaceStore } from '../../../src/db/sqlite/space-store/SqliteSpaceStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription/index.js';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TENANT_ID } from '../../../src/tenancy';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

// Every helper model call (a summary, or a title) is built on VercelAILLM; recording it shows
// whether the finished turn asked a model for anything after its reply.
const mockHelperCall = jest.fn<ReturnType<ILLM['createNonStream']>, Parameters<ILLM['createNonStream']>>();

jest.mock('@truefoundry/trueforge-core/core', () => {
  const actual = jest.requireActual<typeof import('@truefoundry/trueforge-core/core')>(
    '@truefoundry/trueforge-core/core',
  );
  return {
    ...actual,
    VercelAILLM: jest.fn().mockImplementation(() => ({
      createNonStream: (...args: Parameters<ILLM['createNonStream']>) => mockHelperCall(...args),
    })),
  };
});

const SESSION_ID = 's-follow-up-title';
const MODEL_FQN = 'test-provider/test-model';
/** How long the finished turn's follow-up may take when nothing in it calls a model. */
const FOLLOW_UP_BOUND_MS = 2_000;

function doneEvent(turnId: string): TurnDoneEvent {
  return {
    type: EventType.TURN_DONE,
    id: `evt_done_${turnId}`,
    created_at: '2026-10-23T12:00:00.000Z',
    state: {
      status: 'done',
      output: {
        type: 'model.message',
        id: `evt_model_message_${turnId}`,
        thread_id: 'main',
        created_at: '2026-10-23T12:00:00.000Z',
        content: 'Here is your morning brief: three meetings and one deadline.',
      },
      required_actions: [],
      completed_at: '2026-10-23T12:00:00.000Z',
    },
    thread_id: null,
  };
}

function withinBound<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} took longer than ${String(FOLLOW_UP_BOUND_MS)} ms`)),
        FOLLOW_UP_BOUND_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** One interactive chat on a model that resolves, so any helper call after the reply could run. */
async function createChat() {
  const logger = createLogger({ silent: true });
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const tokenStore = new SqliteOAuthTokenStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const modelProviderStore = new SqliteModelProviderStore(db);
  await modelProviderStore.createProvider({
    tenant_id: TENANT_ID,
    name: 'test-provider',
    manifest: {
      type: 'openai',
      base_url: 'https://models.test.example/v1',
      auth: { api_key: 'sk-test' },
      models: [{ model_id: 'test-model', name: 'test-model', properties: { context_length: 8000 } }],
    },
  });
  await sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: SESSION_ID,
    created_by_subject: {
      subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
      subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
      subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
    },
    agent: { type: 'inline', spec: AgentSpecSchema.parse({ model: { name: MODEL_FQN } }) },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  const turnDrains = new TurnDrainRegistry();
  const deps = {
    mcpCatalog: McpCatalog.loadShipped(),
    outboundSecrets: () => Promise.resolve([]),
    globalSettingsStore: new SqliteGlobalSettingsStore(db),
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    sessionStore,
    activeTurns: new ActiveTurnRegistry(),
    turnDrains,
    tokenStore,
    agentStore: new SqliteAgentStore(db),
    modelProviderStore,
    mcpServerStore: new McpServerWithAuthStore({
      store: new SqliteMcpServerStore(db),
      tokenStore,
      clientName: 'test-client',
    }),
    sandboxProviderStore: new SqliteSandboxProviderStore(db),
    skillStore: new SqliteSkillStore(db),
    repositoryStore: new SqliteRepositoryStore(db),
    spaceStore: new SqliteSpaceStore(db),
    turnArtifactStore: new FakeTurnArtifactStore(),
    eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
    logger,
  };

  const readTitle = async (): Promise<string | null | undefined> =>
    (await sessionStore.getSession({ tenant_id: TENANT_ID, session_id: SESSION_ID }))?.title;

  /** Begins a turn with the server's own wiring; the model's reply is a finished turn. */
  const beginTurn = async ({ turnId, text }: { turnId: string; text: string }) => {
    const record = await sessionStore.getSession({ tenant_id: TENANT_ID, session_id: SESSION_ID });
    if (record === undefined) {
      throw new Error('test session was never created');
    }
    const handle = new SessionHandle<SessionCustom, TurnCustom>({ store: sessionStore, session: record });
    const createTurn = handle.createTurn.bind(handle);
    jest.spyOn(handle, 'createTurn').mockImplementation(async args => {
      const turn = await createTurn({ ...args, turn_id: turnId });
      jest.spyOn(turn, 'stream').mockImplementation(async function* (): AsyncGenerator<TurnStreamingEvent> {
        const done = doneEvent(turnId);
        // Recorded as the runtime would, so the chat's next turn can follow this one.
        await sessionStore.updateTurnState({
          session_id: SESSION_ID,
          turn_id: turnId,
          state: done.state,
          turn_done_event: done,
        });
        yield done;
      });
      return turn;
    });
    return beginTurnExecution({
      session: handle,
      input: [{ type: 'user.message', content: text }],
      previous_turn_id: record.last_turn_id ?? undefined,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      deps,
    });
  };

  return { db, turnDrains, readTitle, beginTurn };
}

let chat: Awaited<ReturnType<typeof createChat>> | undefined;

beforeEach(() => {
  mockHelperCall.mockReset();
});

afterEach(async () => {
  await chat?.db.destroy();
  chat = undefined;
});

describe('a finished turn does no chat-title work', () => {
  it('makes no model call for a title after the first reply', async () => {
    mockHelperCall.mockResolvedValue({
      output: { role: 'assistant', content: 'Readable generated title' },
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      finish_reason: 'stop',
    });
    chat = await createChat();

    const { drainInput } = await chat.beginTurn({ turnId: 'turn-1', text: 'Give me my morning brief' });
    await withinBound(drainTurnEvents(drainInput), "the first turn's follow-up");

    expect(mockHelperCall).not.toHaveBeenCalled();
    expect(await chat.readTitle()).toBe('Give me my morning brief');
  });

  it("finishes the turn's follow-up and leaves nothing pending when a helper model would never answer", async () => {
    // A slow self-hosted model: any helper call hangs for good.
    mockHelperCall.mockImplementation(() => new Promise(() => undefined));
    chat = await createChat();

    const first = await chat.beginTurn({ turnId: 'turn-1', text: 'Plan my week' });
    await withinBound(drainTurnEvents(first.drainInput), "the first turn's follow-up");
    expect(chat.turnDrains.size).toBe(0);

    const second = await withinBound(chat.beginTurn({ turnId: 'turn-2', text: 'And next week?' }), 'the next turn');
    await withinBound(drainTurnEvents(second.drainInput), "the next turn's follow-up");

    expect(mockHelperCall).not.toHaveBeenCalled();
  });

  it('titles the chat from its first message, as before, and later turns keep that title', async () => {
    chat = await createChat();
    const firstMessage = 'Help me compare three laptops for photo editing under a budget of 1500 euros';

    const first = await chat.beginTurn({ turnId: 'turn-1', text: firstMessage });
    await withinBound(drainTurnEvents(first.drainInput), "the first turn's follow-up");
    // The first message, capped at 50 characters.
    expect(await chat.readTitle()).toBe(firstMessage.slice(0, 50));

    const second = await chat.beginTurn({ turnId: 'turn-2', text: 'Which one has the best screen?' });
    await withinBound(drainTurnEvents(second.drainInput), "the next turn's follow-up");
    expect(await chat.readTitle()).toBe(firstMessage.slice(0, 50));
  });
});

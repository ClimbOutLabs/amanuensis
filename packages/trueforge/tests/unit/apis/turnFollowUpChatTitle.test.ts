import {
  AgentSpecSchema,
  EventType,
  SessionHandle,
  type TurnDoneEvent,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import type { ILLM, RawAssistantMessageWithUsage } from '@truefoundry/trueforge-core/core';
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
import { privateChatExpiry } from '../../../src/runtime/privateChat';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TENANT_ID } from '../../../src/tenancy';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

// Every helper model call (a summary, or a title) is built on VercelAILLM; recording it shows
// what the finished turn asked a model for after its reply.
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
/** How long the finished turn's follow-up may take; the title step is detached and never counts. */
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

function helperAnswer(content: string): RawAssistantMessageWithUsage {
  return {
    output: { role: 'assistant', content },
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    finish_reason: 'stop',
  };
}

/** One interactive chat on a model that resolves, so any helper call after the reply could run. */
async function createChat(options?: { incognito?: boolean }) {
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
      // A public IP address, not a name: the provider is judged by the address check when a
      // model is resolved, and a fixture name's resolution depends on the machine's DNS.
      base_url: 'https://93.184.216.34/v1',
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
    is_incognito: options?.incognito ?? false,
    private_expires_at: options?.incognito === true ? privateChatExpiry({ from: new Date() }) : null,
  });
  const turnDrains = new TurnDrainRegistry();
  const deps = {
    mcpCatalog: McpCatalog.loadShipped(),
    chatDeletionStore: { listDeletedChatModelUsage: () => Promise.resolve([]) },
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

  /** Polls the stored title until it matches, or the follow-up bound runs out. */
  const waitForTitle = async (expected: string): Promise<void> => {
    const deadline = Date.now() + FOLLOW_UP_BOUND_MS;
    for (;;) {
      const title = await readTitle();
      if (title === expected) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`title never became "${expected}"; it is "${String(title)}"`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };

  /** Polls until the title step's model call is out; the step is detached, so it starts just after the drain. */
  const waitForHelperCalls = async (count: number): Promise<void> => {
    const deadline = Date.now() + FOLLOW_UP_BOUND_MS;
    while (mockHelperCall.mock.calls.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`the title call never started; saw ${String(mockHelperCall.mock.calls.length)} calls`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };

  /** Begins a turn with the server's own wiring; the model's reply is a finished turn. */
  const beginTurn = async ({ turnId, text, sessionTitle }: { turnId: string; text: string; sessionTitle?: string }) => {
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
      session_title: sessionTitle,
      deps,
    });
  };

  return { db, turnDrains, sessionStore, readTitle, waitForTitle, waitForHelperCalls, beginTurn };
}

let chat: Awaited<ReturnType<typeof createChat>> | undefined;

beforeEach(() => {
  mockHelperCall.mockReset();
});

afterEach(async () => {
  await chat?.db.destroy();
  chat = undefined;
});

describe('a finished first turn gives the chat a subject title', () => {
  it('swaps the working title for the subject title the model returns', async () => {
    mockHelperCall.mockResolvedValue(helperAnswer('Laptop comparison'));
    chat = await createChat();
    const firstMessage = 'Help me compare three laptops for photo editing under a budget of 1500 euros';

    const { drainInput } = await chat.beginTurn({ turnId: 'turn-1', text: firstMessage });
    await withinBound(drainTurnEvents(drainInput), "the first turn's follow-up");

    await chat.waitForTitle('Laptop comparison');
    expect(mockHelperCall).toHaveBeenCalledTimes(1);
    // The title is the subject, never the first prompt or its capped working title.
    expect(await chat.readTitle()).not.toBe(firstMessage);
    expect(await chat.readTitle()).not.toBe(firstMessage.slice(0, 50));
  });

  it('keeps the subject title on later turns and asks for no second title', async () => {
    mockHelperCall.mockResolvedValue(helperAnswer('Laptop comparison'));
    chat = await createChat();

    const first = await chat.beginTurn({
      turnId: 'turn-1',
      text: 'Help me compare three laptops for photo editing under a budget of 1500 euros',
    });
    await withinBound(drainTurnEvents(first.drainInput), "the first turn's follow-up");
    await chat.waitForTitle('Laptop comparison');

    const second = await chat.beginTurn({ turnId: 'turn-2', text: 'Which one has the best screen?' });
    await withinBound(drainTurnEvents(second.drainInput), "the second turn's follow-up");

    expect(mockHelperCall).toHaveBeenCalledTimes(1);
    expect(await chat.readTitle()).toBe('Laptop comparison');
  });

  it('never waits for the title call: a silent model leaves the follow-up and the next turn on time', async () => {
    // A slow self-hosted model: the title call hangs for good.
    mockHelperCall.mockImplementation(() => new Promise(() => undefined));
    chat = await createChat();

    const first = await chat.beginTurn({ turnId: 'turn-1', text: 'Plan my week' });
    await withinBound(drainTurnEvents(first.drainInput), "the first turn's follow-up");
    expect(chat.turnDrains.size).toBe(0);

    const second = await withinBound(chat.beginTurn({ turnId: 'turn-2', text: 'And next week?' }), 'the next turn');
    await withinBound(drainTurnEvents(second.drainInput), "the next turn's follow-up");

    // The one title call was started but never awaited; the working title stands.
    await chat.waitForHelperCalls(1);
    expect(mockHelperCall).toHaveBeenCalledTimes(1);
    expect(await chat.readTitle()).toBe('Plan my week');
  });

  it('never overwrites a title the person set by renaming while the title call was out', async () => {
    let answerTitle: ((value: ReturnType<typeof helperAnswer>) => void) | undefined;
    mockHelperCall.mockImplementation(
      () =>
        new Promise(resolve => {
          answerTitle = resolve;
        }),
    );
    chat = await createChat();
    const replaceSpy = jest.spyOn(chat.sessionStore, 'replaceSessionTitleIfCurrent');

    const { drainInput } = await chat.beginTurn({
      turnId: 'turn-1',
      text: 'Plan a long weekend in Lisbon with good food and no early mornings',
    });
    await withinBound(drainTurnEvents(drainInput), "the first turn's follow-up");
    await chat.waitForHelperCalls(1);
    if (answerTitle === undefined) {
      throw new Error('the title call never started');
    }

    // The person renames the chat before the title model answers.
    await chat.sessionStore.updateSession({
      tenant_id: TENANT_ID,
      session_id: SESSION_ID,
      agent: undefined,
      title: 'Lisbon trip',
      metadata: undefined,
    });
    answerTitle(helperAnswer('Lisbon itinerary'));

    // Wait until the title step has tried its swap, then read the title it left.
    const deadline = Date.now() + FOLLOW_UP_BOUND_MS;
    while (replaceSpy.mock.calls.length === 0) {
      if (Date.now() > deadline) {
        throw new Error('the title step never tried to store its title');
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({ current_title: expect.any(String), title: 'Lisbon itinerary' }),
    );
    expect(await chat.readTitle()).toBe('Lisbon trip');
  });

  it('keeps the working title when the model answers with a sentence, not a title', async () => {
    mockHelperCall.mockResolvedValue(
      helperAnswer('This chat is about comparing three laptops for photo editing on a budget'),
    );
    chat = await createChat();
    const replaceSpy = jest.spyOn(chat.sessionStore, 'replaceSessionTitleIfCurrent');
    const firstMessage = 'Help me compare three laptops for photo editing under a budget of 1500 euros';

    const { drainInput } = await chat.beginTurn({ turnId: 'turn-1', text: firstMessage });
    await withinBound(drainTurnEvents(drainInput), "the first turn's follow-up");

    // Give the detached step its chance to finish, then check nothing was swapped.
    await chat.waitForHelperCalls(1);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(mockHelperCall).toHaveBeenCalledTimes(1);
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(await chat.readTitle()).toBe(firstMessage.slice(0, 50));
  });
});

describe('a chat the caller named keeps that name', () => {
  it('sets the caller title and never asks a model for a subject title', async () => {
    mockHelperCall.mockResolvedValue(helperAnswer('Morning brief'));
    chat = await createChat();
    // A schedule run's first message is its task: an instruction sentence, not a name.
    const taskText = 'Give me my morning brief: read everything new since my last brief and write one digest sentence';

    const { drainInput } = await chat.beginTurn({
      turnId: 'turn-1',
      text: taskText,
      sessionTitle: 'Morning brief · Tuesday, November 10',
    });
    await withinBound(drainTurnEvents(drainInput), "the named turn's follow-up");

    // The title step starts detached when it runs at all; give it its chance,
    // then check it never ran: no helper call, and the caller's title stands.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(mockHelperCall).not.toHaveBeenCalled();
    expect(await chat.readTitle()).toBe('Morning brief · Tuesday, November 10');
  });
});

describe('an incognito chat never sends its first exchange to the title model', () => {
  it('makes no title call and keeps the working title', async () => {
    mockHelperCall.mockResolvedValue(helperAnswer('Laptop comparison'));
    chat = await createChat({ incognito: true });
    const firstMessage = 'Help me compare three laptops for photo editing under a budget of 1500 euros';

    const { drainInput } = await chat.beginTurn({ turnId: 'turn-1', text: firstMessage });
    await withinBound(drainTurnEvents(drainInput), "the first turn's follow-up");

    // The title step starts detached when it runs at all; give it its chance,
    // then check it never ran: no helper call, and the working title stands.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(mockHelperCall).not.toHaveBeenCalled();
    expect(await chat.readTitle()).toBe(firstMessage.slice(0, 50));
  });
});

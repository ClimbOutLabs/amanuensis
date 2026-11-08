import {
  AgentSpecSchema,
  EventType,
  SessionHandle,
  type TerminalTurnState,
  type TurnDoneEvent,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import type { Tier3Card } from '@truefoundry/trueforge-core/core';
import type { ToolApprovalRequiredEvent } from '@truefoundry/trueforge-core/core/events/schema';
import { createLogger, type Logger } from 'winston';

import { beginTurnExecution, drainTurnEvents } from '../../../src/apis/turns';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { DeliveryStore } from '../../../src/db/deliveryStore';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
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
import type { DeliveryChannelSender } from '../../../src/runtime/delivery/deliveryChannel';
import { createDeliveryService } from '../../../src/runtime/delivery/deliveryService';
import {
  createTurnDeliveryObserver,
  type TurnDeliveryOrigin,
  type TurnFinishedNotice,
} from '../../../src/runtime/delivery/turnDeliveries';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription/index.js';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import type { Delivery } from '../../../src/schemas/deliveries';
import { TENANT_ID } from '../../../src/tenancy';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

// Helper model calls after a reply (a summary, a title) are built on VercelAILLM; the finished
// turns here never need one, and the mock keeps any surprise call from reaching a real provider.
jest.mock('@truefoundry/trueforge-core/core', () => {
  const actual = jest.requireActual<typeof import('@truefoundry/trueforge-core/core')>(
    '@truefoundry/trueforge-core/core',
  );
  return {
    ...actual,
    VercelAILLM: jest.fn().mockImplementation(() => ({
      createNonStream: () =>
        Promise.resolve({
          output: { role: 'assistant', content: 'A title' },
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          finish_reason: 'stop',
        }),
    })),
  };
});

const OWNER_ID = STANDALONE_REQUEST_CONTEXT.subject.id;

/** An answer in the brief's own shape: prose around one json block holding the digest. */
const BRIEF_ANSWER = [
  'Here is your brief.',
  '',
  '```json',
  '{"digest":"Two things need you today.","items":[]}',
  '```',
].join('\n');

const BRIEF_ORIGIN: TurnDeliveryOrigin = {
  type: 'schedule',
  name: 'morning-brief',
  task: 'Give me my morning brief.',
  scheduled_for: '2026-11-07T15:00:00.000Z',
  timezone: 'America/Los_Angeles',
};

function card(plain_what: string, extra: Partial<Tier3Card> = {}): Tier3Card {
  return {
    plain_what,
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
    ...extra,
  };
}

type WaitingCall = ToolApprovalRequiredEvent['tool_calls'][number];

function waitingCall(id: string, callCard?: Tier3Card): WaitingCall {
  return {
    id,
    source_event_id: `evt-${id}`,
    held: true,
    ...(callCard === undefined ? {} : { tier3_card: callCard }),
  };
}

function waitingEntry(id: string, calls: WaitingCall[]): ToolApprovalRequiredEvent {
  return {
    type: EventType.TOOL_APPROVAL_REQUIRED,
    id,
    thread_id: 'main',
    created_at: '2026-11-07T15:00:00.000Z',
    tool_calls: calls,
  };
}

function doneState(
  answer: string | null,
  requiredActions: ToolApprovalRequiredEvent[] = [],
): Extract<TerminalTurnState, { status: 'done' }> {
  return {
    status: 'done',
    output:
      answer === null
        ? null
        : {
            type: EventType.MODEL_MESSAGE,
            id: 'evt-answer',
            thread_id: 'main',
            created_at: '2026-11-07T15:00:00.000Z',
            content: answer,
          },
    required_actions: requiredActions,
    completed_at: '2026-11-07T15:00:00.000Z',
  };
}

/** A store, a service with a recording sender, and an observer over them, on one fresh database. */
async function deliveryWorld(logger: Logger) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const store = new DeliveryStore(db);
  const sent: Delivery[] = [];
  const senders: DeliveryChannelSender[] = [
    {
      send: input => {
        sent.push(input.delivery);
        return Promise.resolve([
          { channel: 'web_push', outcome: 'sent', detail: null, target: null, attempted_at: new Date().toISOString() },
        ]);
      },
    },
  ];
  const deliveries = createDeliveryService({ store, senders, audit: new SentinelAuditStore(db), logger });
  const observer = createTurnDeliveryObserver({ store, deliveries, logger });
  const feed = async (owner: { tenant_id: string; created_by: string }): Promise<Delivery[]> =>
    (await store.list({ ...owner, limit: 50 })).deliveries;
  return { db, store, sent, deliveries, observer, feed };
}

describe('the turn delivery producers, watched directly', () => {
  const logger = createLogger({ silent: true });
  const ALICE = { tenant_id: 't1', created_by: 'alice' };
  let world: Awaited<ReturnType<typeof deliveryWorld>> | undefined;

  beforeEach(async () => {
    world = await deliveryWorld(logger);
  });

  afterEach(async () => {
    await world?.db.destroy();
    world = undefined;
  });

  function notice(state: TurnFinishedNotice['state'], origin: TurnDeliveryOrigin): TurnFinishedNotice {
    return { ...ALICE, session_id: 's-direct', state, origin };
  }

  it('makes one brief delivery however often the same finish is seen, even across a restart', async () => {
    if (world === undefined) throw new Error('world missing');
    const finished = notice(doneState(BRIEF_ANSWER), BRIEF_ORIGIN);

    await world.observer.turnFinished(finished);
    await world.observer.turnFinished(finished);
    const restarted = createTurnDeliveryObserver({
      store: world.store,
      deliveries: world.deliveries,
      logger,
    });
    await restarted.turnFinished(finished);

    const feed = await world.feed(ALICE);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      kind: 'brief',
      level: 'nudge',
      text: 'Two things need you today.',
      reason: 'Your morning brief ran at 7:00 AM.',
      link: { type: 'chat', session_id: 's-direct' },
      seen_at: null,
    });
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]).toMatchObject({ kind: 'brief', level: 'nudge' });
  });

  it('makes no brief delivery when the answer does not read as a brief', async () => {
    if (world === undefined) throw new Error('world missing');
    await world.observer.turnFinished(notice(doneState('A plain prose answer with no brief in it.'), BRIEF_ORIGIN));
    expect(await world.feed(ALICE)).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
  });

  it('makes no brief delivery for a schedule that is not a brief', async () => {
    if (world === undefined) throw new Error('world missing');
    const origin: TurnDeliveryOrigin = {
      type: 'schedule',
      name: 'laundry-check',
      task: 'Check the laundry.',
      scheduled_for: '2026-11-07T15:00:00.000Z',
      timezone: 'America/Los_Angeles',
    };
    await world.observer.turnFinished(notice(doneState(BRIEF_ANSWER), origin));
    expect(await world.feed(ALICE)).toHaveLength(0);
  });

  it('names a brief schedule of the owner in the reason, with its own run time', async () => {
    if (world === undefined) throw new Error('world missing');
    const origin: TurnDeliveryOrigin = {
      type: 'schedule',
      name: 'weekend-roundup',
      task: 'Give me my morning brief. Weekend edition.',
      scheduled_for: '2026-11-07T17:30:00.000Z',
      timezone: 'America/Los_Angeles',
    };
    await world.observer.turnFinished(notice(doneState(BRIEF_ANSWER), origin));
    const feed = await world.feed(ALICE);
    expect(feed).toHaveLength(1);
    expect(feed[0]?.reason).toBe('Your "weekend-roundup" brief ran at 9:30 AM.');
  });

  it('makes one delivery per waiting entry, counting the rest of an entry without naming them', async () => {
    if (world === undefined) throw new Error('world missing');
    const state = doneState('Working on it.', [
      waitingEntry('entry-1', [waitingCall('call-1', card('Send the report to Ana.'))]),
      waitingEntry('entry-2', [
        waitingCall('call-2', card('Book the train tickets.')),
        waitingCall('call-3', card('Hold the hotel room.')),
      ]),
    ]);
    await world.observer.turnFinished(notice(state, { type: 'chat' }));

    const feed = await world.feed(ALICE);
    expect(feed).toHaveLength(2);
    const byApproval = new Map(feed.map(d => [d.link.type === 'approval' ? d.link.approval_id : '', d]));
    expect(byApproval.get('entry-1')).toMatchObject({
      kind: 'approval_waiting',
      level: 'nudge',
      text: 'Send the report to Ana.',
      reason: 'A chat you left is waiting for your ok.',
      link: { type: 'approval', session_id: 's-direct', approval_id: 'entry-1' },
    });
    expect(byApproval.get('entry-2')).toMatchObject({
      kind: 'approval_waiting',
      text: 'Book the train tickets. And 1 more is waiting.',
    });
    expect(world.sent.filter(d => d.kind === 'approval_waiting')).toHaveLength(2);
  });

  it('keeps every identifier a card carries out of the delivery text and reason', async () => {
    if (world === undefined) throw new Error('world missing');
    const planted = card('Pay the electricity bill.', {
      recipient: 'rcpt-4f8c2e91-7a3b',
      destination: 'dest-9911-xy',
      amount: 'amt-12345-zz',
      outbound_text: 'token: secret-token-xyz-123',
      destination_host: 'hooks-8f31.example.invalid',
    });
    const state = doneState('Working on it.', [waitingEntry('entry-1', [waitingCall('call-1', planted)])]);
    await world.observer.turnFinished(notice(state, { type: 'chat' }));

    const feed = await world.feed(ALICE);
    expect(feed).toHaveLength(1);
    const whole = JSON.stringify(feed[0]);
    for (const secret of ['rcpt-4f8c2e91-7a3b', 'dest-9911-xy', 'amt-12345-zz', 'secret-token-xyz-123', 'hooks-8f31']) {
      expect(whole).not.toContain(secret);
    }
    expect(feed[0]?.text).toBe('Pay the electricity bill.');
  });

  it('makes no delivery when the approvals were answered before the turn finished', async () => {
    if (world === undefined) throw new Error('world missing');
    await world.observer.turnFinished(notice(doneState('All done, nothing waiting.'), { type: 'chat' }));
    expect(await world.feed(ALICE)).toHaveLength(0);
  });

  it('makes no delivery for an entry whose calls could not be saved for the owner', async () => {
    if (world === undefined) throw new Error('world missing');
    const unsaved: WaitingCall = { id: 'call-x', source_event_id: 'evt-call-x', not_saved: 'too_many' };
    const state = doneState('Working on it.', [waitingEntry('entry-1', [unsaved])]);
    await world.observer.turnFinished(notice(state, { type: 'chat' }));
    expect(await world.feed(ALICE)).toHaveLength(0);
  });

  it('makes no delivery for a turn that started in Telegram', async () => {
    if (world === undefined) throw new Error('world missing');
    const state = doneState('Working on it.', [
      waitingEntry('entry-1', [waitingCall('call-1', card('Send the report to Ana.'))]),
    ]);
    await world.observer.turnFinished(notice(state, { type: 'telegram' }));
    expect(await world.feed(ALICE)).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
  });

  it('makes both deliveries when a brief run also ends waiting, the waiting one naming the schedule', async () => {
    if (world === undefined) throw new Error('world missing');
    const state = doneState(BRIEF_ANSWER, [
      waitingEntry('entry-1', [waitingCall('call-1', card('Send the summary to the group.'))]),
    ]);
    await world.observer.turnFinished(notice(state, BRIEF_ORIGIN));

    const feed = await world.feed(ALICE);
    expect(feed.map(d => d.kind).sort()).toEqual(['approval_waiting', 'brief']);
    const waiting = feed.find(d => d.kind === 'approval_waiting');
    expect(waiting?.reason).toBe('The "morning-brief" schedule ran and is waiting for your ok.');
  });

  it('makes one waiting delivery however often the same finish is seen', async () => {
    if (world === undefined) throw new Error('world missing');
    const finished = notice(
      doneState('Working on it.', [waitingEntry('entry-1', [waitingCall('call-1', card('Send the report to Ana.'))])]),
      { type: 'chat' },
    );
    await world.observer.turnFinished(finished);
    await world.observer.turnFinished(finished);
    expect(await world.feed(ALICE)).toHaveLength(1);
    expect(world.sent).toHaveLength(1);
  });
});

describe('finished turns reach the feed through the turn drain', () => {
  const SESSION_ID = 's-delivery-drain';
  const MODEL_FQN = 'test-provider/test-model';
  const logger = createLogger({ silent: true });

  let chat: Awaited<ReturnType<typeof createChat>> | undefined;

  afterEach(async () => {
    await chat?.db.destroy();
    chat = undefined;
  });

  /** One chat on a model that resolves, with the delivery world wired into its turn execution. */
  async function createChat() {
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
        subject_id: OWNER_ID,
        subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
        subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
      },
      agent: { type: 'inline', spec: AgentSpecSchema.parse({ model: { name: MODEL_FQN } }) },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
    const world = await deliveryWorldOn(db, logger);
    const deps = {
      mcpCatalog: McpCatalog.loadShipped(),
      globalSettingsStore: new SqliteGlobalSettingsStore(db),
      tokenFactoryBudget: uncappedTokenFactoryBudget,
      sessionStore,
      activeTurns: new ActiveTurnRegistry(),
      turnDrains: new TurnDrainRegistry(),
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
      deliveryObserver: world.observer,
      logger,
    };

    /** Begins a turn whose stream finishes at once with the given state. */
    const beginTurn = async ({
      turnId,
      text,
      state,
      origin,
    }: {
      turnId: string;
      text: string;
      state: TerminalTurnState;
      origin?: TurnDeliveryOrigin | undefined;
    }) => {
      const record = await sessionStore.getSession({ tenant_id: TENANT_ID, session_id: SESSION_ID });
      if (record === undefined) {
        throw new Error('test session was never created');
      }
      const handle = new SessionHandle<SessionCustom, TurnCustom>({ store: sessionStore, session: record });
      const createTurn = handle.createTurn.bind(handle);
      jest.spyOn(handle, 'createTurn').mockImplementation(async args => {
        const turn = await createTurn({ ...args, turn_id: turnId });
        jest.spyOn(turn, 'stream').mockImplementation(async function* (): AsyncGenerator<TurnStreamingEvent> {
          const done: TurnDoneEvent = {
            type: EventType.TURN_DONE,
            id: `evt_done_${turnId}`,
            created_at: '2026-11-07T15:00:00.000Z',
            state,
            thread_id: null,
          };
          await sessionStore.updateTurnState({ session_id: SESSION_ID, turn_id: turnId, state, turn_done_event: done });
          yield done;
        });
        return turn;
      });
      return beginTurnExecution({
        session: handle,
        input: [{ type: 'user.message', content: text }],
        previous_turn_id: record.last_turn_id ?? undefined,
        userRef: OWNER_ID,
        deps,
        ...(origin === undefined ? {} : { deliveryOrigin: origin }),
      });
    };

    const feed = async (): Promise<Delivery[]> =>
      (await world.store.list({ tenant_id: TENANT_ID, created_by: OWNER_ID, limit: 50 })).deliveries;

    return { db, world, beginTurn, feed };
  }

  /** The delivery world over a database that already exists (the chat's own). */
  async function deliveryWorldOn(db: ReturnType<typeof createSqliteDb>, worldLogger: Logger) {
    const store = new DeliveryStore(db);
    const sent: Delivery[] = [];
    const senders: DeliveryChannelSender[] = [
      {
        send: input => {
          sent.push(input.delivery);
          return Promise.resolve([
            {
              channel: 'web_push',
              outcome: 'sent',
              detail: null,
              target: null,
              attempted_at: new Date().toISOString(),
            },
          ]);
        },
      },
    ];
    const deliveries = createDeliveryService({
      store,
      senders,
      audit: new SentinelAuditStore(db),
      logger: worldLogger,
    });
    const observer = createTurnDeliveryObserver({ store, deliveries, logger: worldLogger });
    return { store, sent, observer };
  }

  it('delivers the digest when a brief run finishes', async () => {
    chat = await createChat();
    const { drainInput } = await chat.beginTurn({
      turnId: 'turn-brief',
      text: 'Give me my morning brief.',
      state: doneState(BRIEF_ANSWER),
      origin: BRIEF_ORIGIN,
    });
    await drainTurnEvents(drainInput);

    const feed = await chat.feed();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      kind: 'brief',
      level: 'nudge',
      text: 'Two things need you today.',
      reason: 'Your morning brief ran at 7:00 AM.',
      link: { type: 'chat', session_id: SESSION_ID },
    });
    expect(chat.world.sent).toHaveLength(1);
    expect(chat.world.sent[0]).toMatchObject({ kind: 'brief', level: 'nudge' });
  });

  it('delivers a waiting item when a chat turn ends still waiting on the owner', async () => {
    chat = await createChat();
    const { drainInput } = await chat.beginTurn({
      turnId: 'turn-waiting',
      text: 'Send the report when you can.',
      state: doneState('Working on it.', [
        waitingEntry('entry-1', [waitingCall('call-1', card('Send the report to Ana.'))]),
      ]),
      // The chat route begins its turns with this origin; the schedule path passes its own.
      origin: { type: 'chat' },
    });
    await drainTurnEvents(drainInput);

    const feed = await chat.feed();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      kind: 'approval_waiting',
      level: 'nudge',
      text: 'Send the report to Ana.',
      reason: 'A chat you left is waiting for your ok.',
      link: { type: 'approval', session_id: SESSION_ID, approval_id: 'entry-1' },
    });
    expect(chat.world.sent).toHaveLength(1);
  });

  it('delivers nothing when a brief run ends in error', async () => {
    chat = await createChat();
    const { drainInput } = await chat.beginTurn({
      turnId: 'turn-error',
      text: 'Give me my morning brief.',
      state: { status: 'error', message: 'The model stopped answering.', completed_at: '2026-11-07T15:00:00.000Z' },
      origin: BRIEF_ORIGIN,
    });
    await drainTurnEvents(drainInput);

    expect(await chat.feed()).toHaveLength(0);
    expect(chat.world.sent).toHaveLength(0);
  });
});

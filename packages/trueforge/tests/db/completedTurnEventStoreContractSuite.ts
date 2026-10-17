import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeDoneTurnState,
  makeTurnDoneEvent,
} from '../../../trueforge-core/tests/agent-session/testHelpers';
import type { AppendCompletedTurnEventsInput, ICompletedTurnEventStore } from '../../src/db/completedTurnEvents';
import type { SessionCustom, TurnCustom } from '../../src/db/sessionCustom';

type Store = ISessionStore<SessionCustom, TurnCustom> & ICompletedTurnEventStore;

const TENANT = 'default';
const SESSION_ID = 'session-completed-events';
const TURN_ID = 'turn-completed-events';

function learnedProfileEvent(id: string) {
  return {
    type: 'aman.profile.learned' as const,
    previous: null,
    current: '# Learned',
    revision: 1,
    id,
    created_at: new Date().toISOString(),
  };
}

/** Registered discriminator, required payload field absent: what a type-only guard admits. */
function learnedProfileEventMissingCurrent(id: string) {
  const complete = learnedProfileEvent(id);
  return {
    type: complete.type,
    previous: complete.previous,
    revision: complete.revision,
    id: complete.id,
    created_at: complete.created_at,
  };
}

/** Registered discriminator, required payload field of the wrong type. */
function learnedProfileEventWithStringRevision(id: string) {
  return { ...learnedProfileEvent(id), revision: '1' };
}

function sendReceiptEvent(id: string) {
  return {
    type: 'aman.email.send_receipt' as const,
    tool_call_id: 'call-send-1',
    result: {
      outcome: 'sent' as const,
      sent_at: '2026-09-01T09:12:00.000Z',
      sent_message_id: 'sent-1',
      check_code: 'A7F39C',
      message: { to: ['grace@example.com'], cc: [], bcc: [], subject: 'Lease', body: 'Thursday works.' },
    },
    id,
    created_at: new Date().toISOString(),
  };
}

function memoryRecallEvent(id: string) {
  return {
    type: 'aman.memory.recall' as const,
    injected_block: null,
    stats: {
      items: 0,
      entities: 0,
      dropped_over_budget: 0,
      dropped_below_threshold: 0,
      estimated_tokens: 0,
      recall_ms: 3,
      outcome: 'empty' as const,
      budget_reason: 'normal' as const,
    },
    sweep: { verified: 0, retried: 0, abandoned: 0, pending: 0 },
    id,
    created_at: new Date().toISOString(),
  };
}

/**
 * The narrow exception to turn immutability (see src/db/completedTurnEvents.ts): a completed
 * turn's event log takes registered passthrough audit rows and nothing else, and only rows that
 * parse against the schema owning that event's shape, so a row the list and stream routes would
 * later fail to read never reaches the log.
 *
 * `appendWidened` is the same backend query the store method calls, reached through its wide
 * runtime-boundary type. The store method itself is narrowly typed, so neither a lifecycle event
 * nor a malformed payload can be handed to it at all; this is how the runtime half of that
 * guarantee gets exercised.
 */
export function runCompletedTurnEventStoreContractSuite(params: {
  createStore: () => Store;
  appendWidened: (input: AppendCompletedTurnEventsInput) => Promise<void>;
}): void {
  async function seedDoneTurn(store: Store): Promise<void> {
    await store.createSession({
      tenant_id: TENANT,
      session_id: SESSION_ID,
      created_by_subject: { subject_id: 'user-a', subject_type: 'user', subject_display_name: 'user-a' },
      external_id: null,
      source: null,
      metadata: {},
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
    });
    await store.createTurn(makeCreateTurnInput({ sessionId: SESSION_ID, turnId: TURN_ID }));
    const state = makeDoneTurnState();
    await store.updateTurnState({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      state,
      turn_done_event: makeTurnDoneEvent(state),
    });
  }

  function listEvents(store: Store) {
    return store.listTurnEvents({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      limit: 50,
      page_token: undefined,
      order: undefined,
    });
  }

  it('appends registered passthrough audit events to a done turn', async () => {
    const store = params.createStore();
    await seedDoneTurn(store);
    const before = (await listEvents(store)).data.length;

    await store.appendEventsToDoneTurn({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      events: [learnedProfileEvent('evt_learned'), memoryRecallEvent('evt_recall')],
    });

    const { data } = await listEvents(store);
    expect(data).toHaveLength(before + 2);
    expect(data.map(event => event.id)).toEqual(expect.arrayContaining(['evt_learned', 'evt_recall']));
  });

  it('stores a send receipt and reads it back whole, so a reloaded chat can show it', async () => {
    const store = params.createStore();
    await seedDoneTurn(store);

    const receipt = sendReceiptEvent('evt_receipt');
    await store.appendEventsToDoneTurn({ session_id: SESSION_ID, turn_id: TURN_ID, events: [receipt] });

    const { data } = await listEvents(store);
    expect(data.find(event => event.id === 'evt_receipt')).toEqual(receipt);
  });

  it('refuses a send receipt that says sent without a message id', async () => {
    const store = params.createStore();
    await seedDoneTurn(store);
    const before = (await listEvents(store)).data.length;
    const { result } = sendReceiptEvent('evt_bad_receipt');
    const withoutId = {
      outcome: result.outcome,
      sent_at: result.sent_at,
      check_code: result.check_code,
      message: result.message,
    };

    await expect(
      params.appendWidened({
        session_id: SESSION_ID,
        turn_id: TURN_ID,
        events: [{ ...sendReceiptEvent('evt_bad_receipt'), result: withoutId }],
      }),
    ).rejects.toThrow(/aman\.email\.send_receipt is not a valid passthrough audit event/);

    expect((await listEvents(store)).data).toHaveLength(before);
  });

  it('refuses a registered event type missing a required payload field and writes nothing', async () => {
    const store = params.createStore();
    await seedDoneTurn(store);
    const before = (await listEvents(store)).data.length;

    await expect(
      params.appendWidened({
        session_id: SESSION_ID,
        turn_id: TURN_ID,
        events: [learnedProfileEventMissingCurrent('evt_missing_current')],
      }),
    ).rejects.toThrow(/aman\.profile\.learned is not a valid passthrough audit event: current: /);

    expect((await listEvents(store)).data).toHaveLength(before);
  });

  it('refuses a registered event type with a wrong-typed payload field and writes nothing', async () => {
    const store = params.createStore();
    await seedDoneTurn(store);
    const before = (await listEvents(store)).data.length;

    await expect(
      params.appendWidened({
        session_id: SESSION_ID,
        turn_id: TURN_ID,
        events: [learnedProfileEventWithStringRevision('evt_string_revision')],
      }),
    ).rejects.toThrow(/aman\.profile\.learned is not a valid passthrough audit event: revision: /);

    expect((await listEvents(store)).data).toHaveLength(before);
  });

  it('refuses a lifecycle event on a done turn and writes nothing', async () => {
    const store = params.createStore();
    await seedDoneTurn(store);
    const before = (await listEvents(store)).data.length;

    const forged = makeTurnDoneEvent(makeDoneTurnState());
    await expect(params.appendWidened({ session_id: SESSION_ID, turn_id: TURN_ID, events: [forged] })).rejects.toThrow(
      /not a registered passthrough audit event/,
    );

    expect((await listEvents(store)).data).toHaveLength(before);
  });

  it('refuses a whole batch when one event is not a passthrough audit event', async () => {
    const store = params.createStore();
    await seedDoneTurn(store);
    const before = (await listEvents(store)).data.length;

    await expect(
      params.appendWidened({
        session_id: SESSION_ID,
        turn_id: TURN_ID,
        events: [learnedProfileEvent('evt_learned_batch'), makeTurnDoneEvent(makeDoneTurnState())],
      }),
    ).rejects.toThrow(/not a registered passthrough audit event/);

    expect((await listEvents(store)).data).toHaveLength(before);
  });

  it('refuses a whole batch when one registered event fails its schema', async () => {
    const store = params.createStore();
    await seedDoneTurn(store);
    const before = (await listEvents(store)).data.length;

    await expect(
      params.appendWidened({
        session_id: SESSION_ID,
        turn_id: TURN_ID,
        events: [learnedProfileEvent('evt_learned_valid'), learnedProfileEventMissingCurrent('evt_learned_malformed')],
      }),
    ).rejects.toThrow(/aman\.profile\.learned is not a valid passthrough audit event: current: /);

    expect((await listEvents(store)).data).toHaveLength(before);
  });
}

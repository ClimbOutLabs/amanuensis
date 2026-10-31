/**
 * The words a finished turn adds to the past-chat search index, and the backfill that fills
 * the index for chats which already exist. Indexing takes the person's own typed words and
 * the assistant's final replies only: tool calls, tool output, attachments and host-wrapped
 * text never become documents.
 */
import type { TurnRecordWithoutSnapshot } from '@truefoundry/trueforge-core/agent-session';
import { InMemorySessionStore } from '@truefoundry/trueforge-core/agent-session';
import { EventType, newEventId } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeTurnDoneEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { chatSearchDocumentsForTurn, runChatSearchBackfill } from '../../../src/runtime/chatSearchIndexing';
import { TENANT_ID } from '../../../src/tenancy';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';

const logger = createLogger({ silent: true });

function turnWith(overrides: Partial<TurnRecordWithoutSnapshot<TurnCustom>>): TurnRecordWithoutSnapshot<TurnCustom> {
  return {
    turn_id: 'turn-1',
    session_id: 'session-1',
    first_turn_id: 'turn-1',
    ancestor_ids: [],
    previous_turn_id: null,
    state: { status: 'running' },
    input: [],
    created_at: new Date('2026-10-01T10:00:00.000Z'),
    updated_at: new Date('2026-10-01T10:01:00.000Z'),
    custom: null,
    ...overrides,
  };
}

function doneState(content: string) {
  return {
    status: 'done' as const,
    output: {
      type: EventType.MODEL_MESSAGE,
      id: newEventId(),
      created_at: '2026-10-01T10:01:00.000Z',
      thread_id: 'main',
      content,
    },
    required_actions: [],
    completed_at: '2026-10-01T10:01:00.000Z',
  };
}

describe('chatSearchDocumentsForTurn', () => {
  it('indexes what the person typed and the final reply', () => {
    const documents = chatSearchDocumentsForTurn(
      turnWith({
        input: [{ type: EventType.USER_MESSAGE, content: 'When does the ferry to the island leave?' }],
        state: doneState('The ferry leaves at nine in the morning.'),
      }),
    );
    expect(documents).toEqual([
      {
        message_id: 'user',
        role: 'user',
        text: 'When does the ferry to the island leave?',
        created_at: new Date('2026-10-01T10:00:00.000Z'),
      },
      {
        message_id: 'assistant',
        role: 'assistant',
        text: 'The ferry leaves at nine in the morning.',
        created_at: new Date('2026-10-01T10:01:00.000Z'),
      },
    ]);
  });

  it('never indexes tool approvals or tool responses', () => {
    const documents = chatSearchDocumentsForTurn(
      turnWith({
        input: [
          {
            type: EventType.USER_TOOL_APPROVAL,
            thread_id: 'main',
            tool_call_id: 'call-1',
            approval: { status: 'allow' },
          },
          {
            type: EventType.USER_TOOL_RESPONSE,
            thread_id: 'main',
            tool_call_id: 'call-2',
            content: 'the secret tool output with the word ferry',
          },
        ],
        state: doneState('All done.'),
      }),
    );
    expect(documents.map(document => document.role)).toEqual(['assistant']);
    expect(documents[0]?.text).toBe('All done.');
  });

  it('leaves out file parts and host-wrapped text, keeping the typed words', () => {
    const documents = chatSearchDocumentsForTurn(
      turnWith({
        input: [
          {
            type: EventType.USER_MESSAGE,
            content: [
              { type: 'text', text: 'Please read this menu.' },
              { type: 'file', name: 'menu.pdf', data: 'data:application/pdf;base64,AAAA' },
              { type: 'text', text: '<tfy-internal>hidden host note about ferries</tfy-internal>' },
            ],
          },
        ],
        state: doneState('The menu lists grilled fish.'),
      }),
    );
    expect(documents[0]?.text).toBe('Please read this menu.');
  });

  it('indexes only the person words when the turn did not finish with a reply', () => {
    const documents = chatSearchDocumentsForTurn(
      turnWith({
        input: [{ type: EventType.USER_MESSAGE, content: 'Book the ferry please.' }],
        state: {
          status: 'error',
          message: 'The model stopped answering.',
          completed_at: '2026-10-01T10:01:00.000Z',
        },
      }),
    );
    expect(documents.map(document => document.role)).toEqual(['user']);
  });
});

describe('runChatSearchBackfill', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
  });

  async function seedFinishedChat(store: SqliteSessionStore, sessionId: string, title: string): Promise<void> {
    await store.createSession({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
    const createInput = makeCreateTurnInput<TurnCustom>({ sessionId, turnId: `${sessionId}-turn-1` });
    createInput.turn.input = [{ type: EventType.USER_MESSAGE, content: 'When does the ferry to the island leave?' }];
    createInput.update_session_title_if_not_exist = title;
    await store.createTurn(createInput);
    const state = doneState('The ferry leaves at nine in the morning.');
    await store.updateTurnState({
      session_id: sessionId,
      turn_id: `${sessionId}-turn-1`,
      state,
      turn_done_event: makeTurnDoneEvent(state),
    });
  }

  it('fills the index for chats that already exist, then reports done', async () => {
    const store = new SqliteSessionStore(env.db);
    await seedFinishedChat(store, 'old-chat-1', 'Island trip plans');
    await seedFinishedChat(store, 'old-chat-2', 'Harbour notes');

    const before = await store.searchChatHistory({
      tenant_id: TENANT_ID,
      query: 'ferry',
      created_by_subject_id: 'user-1',
      exclude_session_id: null,
      from: null,
      to: null,
      limit: 8,
    });
    expect(before).toEqual([]);

    const result = await runChatSearchBackfill({
      sessionStore: store,
      globalSettingsStore: new SqliteGlobalSettingsStore(env.db),
      logger,
    });
    expect(result).toEqual({ sessions_scanned: 2, turns_indexed: 2, done: true });

    const hits = await store.searchChatHistory({
      tenant_id: TENANT_ID,
      query: 'ferry',
      created_by_subject_id: 'user-1',
      exclude_session_id: null,
      from: null,
      to: null,
      limit: 8,
    });
    expect(hits.map(hit => hit.session_id).sort()).toEqual(['old-chat-1', 'old-chat-2']);

    const again = await runChatSearchBackfill({
      sessionStore: store,
      globalSettingsStore: new SqliteGlobalSettingsStore(env.db),
      logger,
    });
    expect(again).toEqual({ sessions_scanned: 0, turns_indexed: 0, done: true });
  });

  it('resumes from the saved page instead of starting over', async () => {
    const store = new SqliteSessionStore(env.db);
    await seedFinishedChat(store, 'old-chat-1', 'Island trip plans');
    const settings = new SqliteGlobalSettingsStore(env.db);
    // A cursor that points past the only page: the walk ends at once and marks itself done.
    await settings.setSetting({ key: 'chat_search_backfill_done', value: 'true' });
    const result = await runChatSearchBackfill({ sessionStore: store, globalSettingsStore: settings, logger });
    expect(result.done).toBe(true);
    expect(result.sessions_scanned).toBe(0);
  });
});

describe('indexing into a memory store', () => {
  it('keeps the same behaviour on the in-memory store the import replay uses', async () => {
    const store = new InMemorySessionStore<SessionCustom, TurnCustom>();
    await store.createSession({
      tenant_id: TENANT_ID,
      session_id: 'memory-chat',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
    await store.indexChatMessages({
      tenant_id: TENANT_ID,
      session_id: 'memory-chat',
      turn_id: 'turn-1',
      documents: [{ message_id: 'user', role: 'user', text: 'ferry times please', created_at: new Date() }],
    });
    const hits = await store.searchChatHistory({
      tenant_id: TENANT_ID,
      query: 'ferry',
      created_by_subject_id: 'user-1',
      exclude_session_id: null,
      from: null,
      to: null,
      limit: 8,
    });
    expect(hits).toHaveLength(1);
  });
});

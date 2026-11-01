/**
 * The words a finished turn adds to the past-chat search index, and the indexer that keeps
 * the index only for people who turned the search on. Indexing takes the person's own typed
 * words and the assistant's final replies only: tool calls, tool output, attachments and
 * host-wrapped text never become documents.
 */
import type { TurnRecordWithoutSnapshot } from '@truefoundry/trueforge-core/agent-session';
import type {
  ISessionStore,
  SearchChatHistoryInput,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import { EventType, newEventId } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeTurnDoneEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqliteSentinelSettingsStore } from '../../../src/db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import {
  ChatSearchIndexer,
  chatSearchDocumentsForTurn,
  requestChatSearchBackfill,
} from '../../../src/runtime/chatSearchIndexing';
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

  it('leaves out a host-wrapped message stored as plain text', () => {
    const documents = chatSearchDocumentsForTurn(
      turnWith({
        input: [
          { type: EventType.USER_MESSAGE, content: '<tfy-internal>hidden host note about ferries</tfy-internal>' },
          { type: EventType.USER_MESSAGE, content: 'What about the bus?' },
        ],
        state: doneState('The bus leaves at ten.'),
      }),
    );
    expect(documents[0]?.text).toBe('What about the bus?');
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

/** A store whose index writes fail, as during a database outage. */
class FailingIndexStore extends SqliteSessionStore {
  override indexChatMessages(): Promise<void> {
    return Promise.reject(new Error('database is busy'));
  }
}

const PERSON = { tenant_id: TENANT_ID, created_by: 'user-1' };

function searchFor(query: string): SearchChatHistoryInput {
  return {
    tenant_id: TENANT_ID,
    query,
    created_by_subject_id: PERSON.created_by,
    exclude_session_id: null,
    persona_ids: ['p-work'],
    from: null,
    to: null,
    limit: 8,
  };
}

describe('ChatSearchIndexer', () => {
  let env: SqliteTestDatabase;
  let store: SqliteSessionStore;
  let globalSettingsStore: SqliteGlobalSettingsStore;
  let sentinelSettingsStore: SqliteSentinelSettingsStore;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    store = new SqliteSessionStore(env.db);
    globalSettingsStore = new SqliteGlobalSettingsStore(env.db);
    sentinelSettingsStore = new SqliteSentinelSettingsStore(env.db);
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
  });

  function indexer(sessionStore: ISessionStore<SessionCustom, TurnCustom> = store): ChatSearchIndexer {
    return new ChatSearchIndexer({
      sessionStore,
      globalSettingsStore,
      sentinelSettingsStore,
      personaStore: new SqlitePersonaStore(env.db),
      logger,
    });
  }

  async function setSwitch(enabled: boolean): Promise<void> {
    await sentinelSettingsStore.patch({
      ...PERSON,
      offline_mode: undefined,
      tier2_auto_allow: undefined,
      search_without_asking: undefined,
      maps_without_asking: undefined,
      sandbox_without_asking: undefined,
      chat_search_enabled: enabled,
      package_downloads_without_project_allowed: undefined,
    });
  }

  async function pending(): Promise<string | undefined> {
    return (await globalSettingsStore.getSetting({ key: 'chat_search_backfill_pending' }))?.value;
  }

  async function seedFinishedChat(sessionId: string, custom: TurnCustom | null = null): Promise<void> {
    await store.createSession({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      created_by_subject: { subject_id: PERSON.created_by, subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
    const createInput = makeCreateTurnInput<TurnCustom>({ sessionId, turnId: `${sessionId}-turn-1` });
    createInput.turn.input = [{ type: EventType.USER_MESSAGE, content: 'When does the ferry to the island leave?' }];
    createInput.turn.custom = custom;
    createInput.update_session_title_if_not_exist = sessionId;
    await store.createTurn(createInput);
    const state = doneState('The ferry leaves at nine in the morning.');
    await store.updateTurnState({
      session_id: sessionId,
      turn_id: `${sessionId}-turn-1`,
      state,
      turn_done_event: makeTurnDoneEvent(state),
    });
  }

  async function seedSession(sessionId: string): Promise<void> {
    await store.createSession({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      created_by_subject: { subject_id: PERSON.created_by, subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
  }

  async function finishTurn(sessionId: string, turnId: string): Promise<void> {
    const state = doneState('The ferry leaves at nine in the morning.');
    await store.updateTurnState({
      session_id: sessionId,
      turn_id: turnId,
      state,
      turn_done_event: makeTurnDoneEvent(state),
    });
  }

  async function seedTurn(
    sessionId: string,
    turnId: string,
    custom: TurnCustom | null,
    previousTurnId?: string,
  ): Promise<void> {
    const createInput = makeCreateTurnInput<TurnCustom>({
      sessionId,
      turnId,
      ...(previousTurnId === undefined ? {} : { previousTurnId }),
    });
    createInput.turn.input = [{ type: EventType.USER_MESSAGE, content: 'When does the ferry to the island leave?' }];
    createInput.turn.custom = custom;
    await store.createTurn(createInput);
    await finishTurn(sessionId, turnId);
  }

  it('adds nothing while the person has the search off', async () => {
    await seedFinishedChat('chat-1');
    await indexer().indexFinishedTurn({ ...PERSON, session_id: 'chat-1', turn_id: 'chat-1-turn-1' });
    await setSwitch(true);
    expect(await store.searchChatHistory(searchFor('ferry'))).toEqual([]);
  });

  it('gives a turn with an empty custom block the persona chosen before it, not the main assistant', async () => {
    await setSwitch(true);
    await seedSession('chat-1');
    const personaStore = new SqlitePersonaStore(env.db);
    await personaStore.recordPersonaActivation({
      tenant_id: TENANT_ID,
      id: 'activation-1',
      session_id: 'chat-1',
      turn_id: null,
      persona_id: 'p-work',
      persona_name: 'Work',
      model_name: 'test/model',
      source: 'explicit',
    });
    await seedTurn('chat-1', 'chat-1-turn-1', {});

    await indexer().indexFinishedTurn({ ...PERSON, session_id: 'chat-1', turn_id: 'chat-1-turn-1' });

    expect((await store.searchChatHistory(searchFor('ferry'))).map(hit => hit.session_id)).toEqual(['chat-1']);
    expect(await store.searchChatHistory({ ...searchFor('ferry'), persona_ids: ['p-home'] })).toEqual([]);
    expect(await store.searchChatHistory({ ...searchFor('ferry'), persona_ids: [] })).toEqual([]);
  });

  it('inherits the persona from the earlier turn a turn follows', async () => {
    await setSwitch(true);
    await seedSession('chat-1');
    await seedTurn('chat-1', 'chat-1-turn-1', {
      persona: { persona_id: 'p-work', persona_name: 'Work', model_name: 'test/model', source: 'sticky' },
    });
    await seedTurn('chat-1', 'chat-1-turn-2', {}, 'chat-1-turn-1');

    await indexer().indexFinishedTurn({ ...PERSON, session_id: 'chat-1', turn_id: 'chat-1-turn-2' });

    expect((await store.searchChatHistory(searchFor('ferry'))).map(hit => hit.session_id)).toEqual(['chat-1']);
    expect(await store.searchChatHistory({ ...searchFor('ferry'), persona_ids: [] })).toEqual([]);
  });

  it('leaves out a turn whose persona cannot be decided', async () => {
    await setSwitch(true);
    await seedSession('chat-1');
    const personaStore = new SqlitePersonaStore(env.db);
    await personaStore.recordPersonaActivation({
      tenant_id: TENANT_ID,
      id: 'activation-1',
      session_id: 'chat-1',
      turn_id: 'some-other-turn',
      persona_id: 'p-work',
      persona_name: 'Work',
      model_name: 'test/model',
      source: 'invocation',
    });
    await seedTurn('chat-1', 'chat-1-turn-1', {});

    await indexer().indexFinishedTurn({ ...PERSON, session_id: 'chat-1', turn_id: 'chat-1-turn-1' });

    expect(await store.searchChatHistory(searchFor('ferry'))).toEqual([]);
    expect(await store.searchChatHistory({ ...searchFor('ferry'), persona_ids: [] })).toEqual([]);
  });

  it('still fills in every chat when the switch is turned off and on again while a pass is running', async () => {
    await seedFinishedChat('race-chat-1');
    await seedFinishedChat('race-chat-2');
    await seedFinishedChat('race-chat-3');

    let chatSearch: ChatSearchIndexer | undefined;
    let toggled = false;
    class TogglingStore extends SqliteSessionStore {
      override async indexChatMessages(input: Parameters<SqliteSessionStore['indexChatMessages']>[0]): Promise<void> {
        if (!toggled && chatSearch !== undefined) {
          toggled = true;
          await setSwitch(false);
          await chatSearch.followSwitch({ ...PERSON, enabled: false });
          await setSwitch(true);
          await chatSearch.followSwitch({ ...PERSON, enabled: true });
        }
        await super.indexChatMessages(input);
      }
    }
    chatSearch = indexer(new TogglingStore(env.db));
    await chatSearch.requestPass(PERSON);
    await setSwitch(true);
    await chatSearch.followSwitch({ ...PERSON, enabled: true });
    await chatSearch.idle();

    expect(toggled).toBe(true);
    expect((await store.searchChatHistory(searchFor('ferry'))).map(hit => hit.session_id).sort()).toEqual([
      'race-chat-1',
      'race-chat-2',
      'race-chat-3',
    ]);
    expect(await pending()).toBeUndefined();
  });

  it('takes a pass write back when the search is turned off while that write runs', async () => {
    await seedFinishedChat('late-chat');

    let chatSearch: ChatSearchIndexer | undefined;
    let turnedOff = false;
    class LateWriteStore extends SqliteSessionStore {
      override async indexChatMessages(input: Parameters<SqliteSessionStore['indexChatMessages']>[0]): Promise<void> {
        if (!turnedOff && chatSearch !== undefined && input.documents.length > 0) {
          // The clear runs between the pass's last switch check and its write landing.
          turnedOff = true;
          await setSwitch(false);
          await chatSearch.followSwitch({ ...PERSON, enabled: false });
        }
        await super.indexChatMessages(input);
      }
    }
    chatSearch = indexer(new LateWriteStore(env.db));
    await chatSearch.requestPass(PERSON);
    await setSwitch(true);
    await chatSearch.followSwitch({ ...PERSON, enabled: true });
    await chatSearch.idle();

    expect(turnedOff).toBe(true);
    await setSwitch(true);
    expect(await store.searchChatHistory(searchFor('ferry'))).toEqual([]);
    expect(await pending()).toBeUndefined();
  });

  it('adds a finished turn with the persona that answered it once the search is on', async () => {
    await setSwitch(true);
    await seedFinishedChat('chat-1', {
      persona: { persona_id: 'p-work', persona_name: 'Work', model_name: 'test/model', source: 'sticky' },
    });
    await indexer().indexFinishedTurn({ ...PERSON, session_id: 'chat-1', turn_id: 'chat-1-turn-1' });
    expect((await store.searchChatHistory(searchFor('ferry'))).map(hit => hit.session_id)).toEqual(['chat-1']);
    expect(await store.searchChatHistory({ ...searchFor('ferry'), persona_ids: [] })).toEqual([]);
  });

  it('fills in earlier chats when the search is turned on, then forgets them when it is turned off', async () => {
    await seedFinishedChat('old-chat-1');
    await seedFinishedChat('old-chat-2');
    const chatSearch = indexer();

    await chatSearch.requestPass(PERSON);
    await setSwitch(true);
    await chatSearch.followSwitch({ ...PERSON, enabled: true });
    await chatSearch.idle();
    expect((await store.searchChatHistory(searchFor('ferry'))).map(hit => hit.session_id).sort()).toEqual([
      'old-chat-1',
      'old-chat-2',
    ]);
    expect(await pending()).toBeUndefined();

    await setSwitch(false);
    await chatSearch.followSwitch({ ...PERSON, enabled: false });
    await setSwitch(true);
    expect(await store.searchChatHistory(searchFor('ferry'))).toEqual([]);
  });

  it('drops a requested pass, and writes nothing, when the switch is off by the time it runs', async () => {
    await seedFinishedChat('old-chat-1');
    await requestChatSearchBackfill({ globalSettingsStore, person: PERSON });
    const chatSearch = indexer();
    await chatSearch.resumePending();
    await chatSearch.idle();
    expect(await pending()).toBeUndefined();
    await setSwitch(true);
    expect(await store.searchChatHistory(searchFor('ferry'))).toEqual([]);
  });

  it('asks for a pass when a write fails, and the pass adds the turn later', async () => {
    await setSwitch(true);
    await seedFinishedChat('chat-1');
    await indexer(new FailingIndexStore(env.db)).indexFinishedTurn({
      ...PERSON,
      session_id: 'chat-1',
      turn_id: 'chat-1-turn-1',
    });
    expect(await pending()).toContain('user-1');
    expect(await store.searchChatHistory(searchFor('ferry'))).toEqual([]);

    const recovered = indexer();
    await recovered.resumePending();
    await recovered.idle();
    expect((await store.searchChatHistory(searchFor('ferry'))).map(hit => hit.session_id)).toEqual(['chat-1']);
    expect(await pending()).toBeUndefined();
  });
});

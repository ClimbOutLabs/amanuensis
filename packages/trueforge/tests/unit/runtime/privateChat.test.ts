/**
 * A private chat and a normal chat run the same finished turn through the turn drain. The normal
 * chat is saved to memory and joins the past-chat search; the private chat reaches neither.
 */
import { EventType, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { newEventId } from '@truefoundry/trueforge-core/core';
import winston from 'winston';
import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeTurnDoneEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';
import { drainTurnEvents } from '../../../src/apis/turns';
import type { TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqliteSentinelSettingsStore } from '../../../src/db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { ChatSearchIndexer } from '../../../src/runtime/chatSearchIndexing';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { HindsightClient } from '../../../src/runtime/memory/hindsightClient';
import { PRIVATE_CHAT_LIFETIME_MS, privateChatExpiry, sessionKeepsNothing } from '../../../src/runtime/privateChat';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';
import { TENANT_ID } from '../../../src/tenancy';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';

const OWNER = 'user-1';
const QUESTION = 'When does the ferry to the island leave?';
const REPLY = 'The ferry leaves at nine in the morning.';
const DONE_AT = '2026-10-01T10:01:00.000Z';

function doneState() {
  return {
    status: 'done' as const,
    output: { type: EventType.MODEL_MESSAGE, id: newEventId(), created_at: DONE_AT, thread_id: 'main', content: REPLY },
    required_actions: [],
    completed_at: DONE_AT,
  };
}

async function* finishedTurnStream(): AsyncGenerator<TurnStreamingEvent> {
  const state = doneState();
  yield { type: EventType.TURN_DONE, id: newEventId(), created_at: DONE_AT, state, thread_id: null };
}

describe('sessionKeepsNothing', () => {
  it('is true only for a private chat', () => {
    expect(sessionKeepsNothing({ session: { is_incognito: true } })).toBe(true);
    expect(sessionKeepsNothing({ session: { is_incognito: false } })).toBe(false);
  });
});

describe('privateChatExpiry', () => {
  it('is a day after the given time', () => {
    const from = new Date('2026-11-05T10:00:00.000Z');
    expect(privateChatExpiry({ from }).getTime() - from.getTime()).toBe(PRIVATE_CHAT_LIFETIME_MS);
    expect(privateChatExpiry({ from }).toISOString()).toBe('2026-11-06T10:00:00.000Z');
  });
});

describe('a finished turn in a private chat and a normal chat', () => {
  let env: SqliteTestDatabase;
  let sessionStore: SqliteSessionStore;
  let indexer: ChatSearchIndexer;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    sessionStore = new SqliteSessionStore(env.db);
    const sentinelSettingsStore = new SqliteSentinelSettingsStore(env.db);
    await sentinelSettingsStore.patch({
      tenant_id: TENANT_ID,
      created_by: OWNER,
      offline_mode: undefined,
      tier2_auto_allow: undefined,
      search_without_asking: undefined,
      maps_without_asking: undefined,
      sandbox_without_asking: undefined,
      chat_search_enabled: true,
      package_downloads_without_project_allowed: undefined,
    });
    indexer = new ChatSearchIndexer({
      sessionStore,
      globalSettingsStore: new SqliteGlobalSettingsStore(env.db),
      sentinelSettingsStore,
      personaStore: new SqlitePersonaStore(env.db),
      logger: winston.createLogger({ silent: true }),
    });
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
  });

  /** Seeds a chat with one finished turn, drains it, and reports what the drain kept. */
  async function finishTurnIn(
    isIncognito: boolean,
  ): Promise<{ retained: number; searchable: boolean; expiresAt: Date | null | undefined }> {
    const sessionId = isIncognito ? 'private-chat' : 'normal-chat';
    const turnId = `${sessionId}-turn-1`;
    await sessionStore.createSession({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      created_by_subject: { subject_id: OWNER, subject_type: 'user', subject_display_name: OWNER },
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
      is_incognito: isIncognito,
      private_expires_at: isIncognito ? new Date(Date.now() + 60_000) : null,
    });
    const createInput = makeCreateTurnInput<TurnCustom>({ sessionId, turnId });
    createInput.turn.input = [{ type: EventType.USER_MESSAGE, content: QUESTION }];
    await sessionStore.createTurn(createInput);
    const state = doneState();
    await sessionStore.updateTurnState({
      session_id: sessionId,
      turn_id: turnId,
      state,
      turn_done_event: makeTurnDoneEvent(state),
    });

    const client = new HindsightClient({
      apiBase: 'https://hindsight.test.example',
      bank: 'aman',
      headers: {},
      fetchImpl: () => Promise.reject(new Error('drain tests must not reach the network')),
    });
    const retain = jest.spyOn(client, 'retain').mockResolvedValue({ ok: true });
    jest.spyOn(client, 'getOperation').mockResolvedValue({ ok: true, status: 'completed' });
    const executionDeadline = new TurnExecutionDeadline({
      abortController: new AbortController(),
      default_timeout_ms: 60_000,
      finalization_buffer_ms: 1_000,
    });
    executionDeadline.arm();
    const session = await sessionStore.getSession({ tenant_id: TENANT_ID, session_id: sessionId });
    if (session === undefined) {
      throw new Error('seeded chat is missing');
    }

    await drainTurnEvents({
      trackedStream: finishedTurnStream(),
      turnEventStream: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined).get(`stream-${sessionId}`),
      sessionId,
      turnId,
      executionDeadline,
      logger: winston.createLogger({ silent: true }),
      turnDrains: new TurnDrainRegistry(),
      memory: { session, client, userText: QUESTION, attachedFiles: false },
      chatSearch: { indexer, tenantId: TENANT_ID, createdBy: OWNER },
      privateChat: isIncognito ? { sessionStore, tenantId: TENANT_ID } : undefined,
    });

    const hits = await sessionStore.searchChatHistory({
      tenant_id: TENANT_ID,
      query: 'ferry',
      created_by_subject_id: OWNER,
      exclude_session_id: null,
      personas: { kind: 'all' },
      from: null,
      to: null,
      limit: 10,
    });
    const after = await sessionStore.getSession({ tenant_id: TENANT_ID, session_id: sessionId });
    return {
      retained: retain.mock.calls.length,
      searchable: hits.some(hit => hit.session_id === sessionId),
      expiresAt: after?.private_expires_at,
    };
  }

  it('saves the normal chat to memory and the past-chat search', async () => {
    expect(await finishTurnIn(false)).toEqual({ retained: 1, searchable: true, expiresAt: null });
  });

  it('saves nothing from the private chat, and gives it another day', async () => {
    const before = Date.now();
    const result = await finishTurnIn(true);
    expect(result).toMatchObject({ retained: 0, searchable: false });
    expect(result.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + PRIVATE_CHAT_LIFETIME_MS);
  });
});

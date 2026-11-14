/**
 * Pulling a fact out of one chat's recall: the exclusion is stored with that chat, so it is
 * still there when read back through a fresh store (a restart changes nothing), the session
 * must exist, only the person who owns the chat may pull a fact out of it, a private chat
 * keeps nothing so nothing is recorded for it, and the fact's words are capped.
 */
import { InMemorySessionStore, Sessions } from '@truefoundry/trueforge-core/agent-session';

import { makeAgentSpec } from '../../../../trueforge-core/tests/agent-session/testHelpers';
import { createRecallExclusionsRouter } from '../../../src/apis/recallExclusions';
import type { RequestContext } from '../../../src/auth/identity';
import { RecallExclusionStore } from '../../../src/db/recallExclusionStore';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import {
  CreateRecallExclusionResponseSchema,
  RECALL_EXCLUSION_FACT_TEXT_MAX_LENGTH,
} from '../../../src/schemas/recallExclusions';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';

const TENANT = 't1';

function contextFor(subjectId: string): RequestContext {
  return {
    tenant_id: TENANT,
    subject: { id: subjectId, type: 'user', display_name: subjectId },
    roles: [],
    user_credential: null,
  };
}

describe('POST /api/v1/sessions/{session_id}/recall-exclusions', () => {
  let testDb: SqliteTestDatabase;
  let sessionStore: InMemorySessionStore<SessionCustom, TurnCustom>;

  beforeEach(async () => {
    testDb = await createSqliteTestDatabase();
    sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
    const sessions = new Sessions<SessionCustom, TurnCustom>({ sessionStore });
    await sessions.create({
      tenant_id: TENANT,
      session_id: 'chat-1',
      created_by_subject: { subject_id: 'ada', subject_type: 'user', subject_display_name: 'Ada' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });
    await sessions.create({
      tenant_id: TENANT,
      session_id: 'chat-private',
      created_by_subject: { subject_id: 'ada', subject_type: 'user', subject_display_name: 'Ada' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
      is_incognito: true,
      private_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  afterEach(async () => {
    await testDb.teardown();
  });

  function routerFor(callerId: string) {
    return createRecallExclusionsRouter({
      sessionStore,
      recallExclusionStore: new RecallExclusionStore(testDb.db),
      resolveRequestContext: () => contextFor(callerId),
    });
  }

  /** What a fresh store on the same database reads back: nothing here is process memory. */
  async function storedFor(sessionId: string): Promise<readonly string[]> {
    return new RecallExclusionStore(testDb.db).listForSession({ tenant_id: TENANT, session_id: sessionId });
  }

  function postInit(factText: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fact_text: factText }),
    };
  }

  it('records the exclusion for this chat only and answers 201', async () => {
    const response = await routerFor('ada').request('/chat-1/recall-exclusions', postInit('The gate code is 4417'));
    expect(response.status).toBe(201);
    const body = CreateRecallExclusionResponseSchema.parse(await response.json());
    expect(body.data).toEqual({ session_id: 'chat-1', fact_text: 'The gate code is 4417' });
    expect(await storedFor('chat-1')).toEqual(['The gate code is 4417']);
    expect(await storedFor('chat-2')).toEqual([]);
  });

  it('recording the same fact twice keeps one exclusion', async () => {
    const router = routerFor('ada');
    await router.request('/chat-1/recall-exclusions', postInit('The gate code is 4417'));
    const again = await router.request('/chat-1/recall-exclusions', postInit('The gate code is 4417'));
    expect(again.status).toBe(201);
    expect(await storedFor('chat-1')).toEqual(['The gate code is 4417']);
  });

  it('answers 404 for a chat that does not exist', async () => {
    const response = await routerFor('ada').request('/no-such-chat/recall-exclusions', postInit('A fact'));
    expect(response.status).toBe(404);
  });

  it('answers 403 when the caller is not the person who owns the chat', async () => {
    const response = await routerFor('bob').request('/chat-1/recall-exclusions', postInit('A fact'));
    expect(response.status).toBe(403);
    expect(await storedFor('chat-1')).toEqual([]);
  });

  it('answers 400 when the fact is missing', async () => {
    const response = await routerFor('ada').request('/chat-1/recall-exclusions', postInit(undefined));
    expect(response.status).toBe(400);
  });

  it('answers 400 when the fact is longer than the cap', async () => {
    const tooLong = 'x'.repeat(RECALL_EXCLUSION_FACT_TEXT_MAX_LENGTH + 1);
    const response = await routerFor('ada').request('/chat-1/recall-exclusions', postInit(tooLong));
    expect(response.status).toBe(400);
    expect(await storedFor('chat-1')).toEqual([]);
  });

  it('records nothing for a private chat, which keeps nothing', async () => {
    const response = await routerFor('ada').request(
      '/chat-private/recall-exclusions',
      postInit('The gate code is 4417'),
    );
    expect(response.status).toBe(400);
    expect(await storedFor('chat-private')).toEqual([]);
  });
});

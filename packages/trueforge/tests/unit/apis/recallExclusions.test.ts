/**
 * Pulling a fact out of one chat's recall: the exclusion is recorded for that chat only, the
 * session must exist, and only the person who owns the chat may pull a fact out of it.
 */
import { InMemorySessionStore, Sessions } from '@truefoundry/trueforge-core/agent-session';

import { makeAgentSpec } from '../../../../trueforge-core/tests/agent-session/testHelpers';
import { createRecallExclusionsRouter } from '../../../src/apis/recallExclusions';
import type { RequestContext } from '../../../src/auth/identity';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { recallExclusionsFor } from '../../../src/runtime/memory/recallExclusions';
import { CreateRecallExclusionResponseSchema } from '../../../src/schemas/recallExclusions';

const TENANT = 't1';

function contextFor(subjectId: string): RequestContext {
  return {
    tenant_id: TENANT,
    subject: { id: subjectId, type: 'user', display_name: subjectId },
    roles: [],
    user_credential: null,
  };
}

async function createRouter(callerId: string) {
  const sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
  const sessions = new Sessions<SessionCustom, TurnCustom>({ sessionStore });
  await sessions.create({
    tenant_id: TENANT,
    session_id: 'chat-1',
    created_by_subject: { subject_id: 'ada', subject_type: 'user', subject_display_name: 'Ada' },
    agent: { type: 'inline', spec: makeAgentSpec() },
    external_id: null,
  });
  return createRecallExclusionsRouter({
    sessionStore,
    resolveRequestContext: () => contextFor(callerId),
  });
}

function postInit(factText: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fact_text: factText }),
  };
}

describe('POST /api/v1/sessions/{session_id}/recall-exclusions', () => {
  it('records the exclusion for this chat only and answers 201', async () => {
    const router = await createRouter('ada');
    const response = await router.request('/chat-1/recall-exclusions', postInit('The gate code is 4417'));
    expect(response.status).toBe(201);
    const body = CreateRecallExclusionResponseSchema.parse(await response.json());
    expect(body.data).toEqual({ session_id: 'chat-1', fact_text: 'The gate code is 4417' });
    expect(recallExclusionsFor('chat-1').has('The gate code is 4417')).toBe(true);
    expect(recallExclusionsFor('chat-2').has('The gate code is 4417')).toBe(false);
  });

  it('answers 404 for a chat that does not exist', async () => {
    const router = await createRouter('ada');
    const response = await router.request('/no-such-chat/recall-exclusions', postInit('A fact'));
    expect(response.status).toBe(404);
  });

  it('answers 403 when the caller is not the person who owns the chat', async () => {
    const router = await createRouter('bob');
    const response = await router.request('/chat-1/recall-exclusions', postInit('A fact'));
    expect(response.status).toBe(403);
    expect(recallExclusionsFor('chat-1').has('A fact')).toBe(false);
  });

  it('answers 400 when the fact is missing', async () => {
    const router = await createRouter('ada');
    const response = await router.request('/chat-1/recall-exclusions', postInit(undefined));
    expect(response.status).toBe(400);
  });
});

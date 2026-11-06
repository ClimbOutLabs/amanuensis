import { Sessions, type CreatedBySubject, type SessionAgent } from '@truefoundry/trueforge-core/agent-session';

import type { RequestContext } from '../../../../src/auth/identity';
import { inProcessCaller } from '../../../../src/auth/inProcessCaller';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { ReachSettingsStore } from '../../../../src/db/reachSettingsStore';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { createCallChats, PHONE_CALL_CHAT_TITLE } from '../../../../src/runtime/calls/callChats';
import type { Delivery } from '../../../../src/schemas/deliveries';

const TENANT = 'default';
const DANA: CreatedBySubject = { subject_id: 'dana', subject_type: 'user', subject_display_name: 'Dana' };
const AGENT = { type: 'reference' as const, id: 'agent-1', name: 'assistant-0123456789abcdef' };
/** What a new chat in the app starts on. */
const NEW_CHAT_AGENT: SessionAgent = { type: 'reference', id: 'agent-new', name: 'assistant-fedcba9876543210' };

function delivery(link: Delivery['link']): Delivery {
  return {
    id: 'delivery-1',
    kind: 'nudge',
    level: 'call',
    text: 'Your 3pm clashes with the school pickup.',
    reason: 'Two things at the same time.',
    created_at: '2026-11-06T15:00:00.000Z',
    seen_at: null,
    attempts: [],
    link,
  };
}

/** `null` stands for a server with no model, whose new chats have no assistant. */
async function setup({ newChatAgent = NEW_CHAT_AGENT }: { newChatAgent?: SessionAgent | null } = {}) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const sessionStore = new SqliteSessionStore(db);
  const sessions = new Sessions({ sessionStore });
  const requests: { path: string; caller: RequestContext | undefined; site: string | null }[] = [];
  const chats = createCallChats({
    sessionStore,
    sessions: () => sessions,
    reachSettings: new ReachSettingsStore(db),
    newChatAgent: () => Promise.resolve(newChatAgent ?? undefined),
    selfFetch: () => (request, env) => {
      const path = new URL(request.url).pathname;
      requests.push({ path, caller: inProcessCaller({ env, path }), site: request.headers.get('sec-fetch-site') });
      return new Response('{}', { status: 200 });
    },
    contextFor: ({ tenant_id, subject }) => ({
      tenant_id,
      subject: { id: subject.subject_id, type: subject.subject_type, display_name: subject.subject_display_name },
      roles: [],
      user_credential: null,
    }),
    port: 8791,
    now: () => new Date('2026-11-06T15:00:00.000Z'),
  });
  return { sessionStore, sessions, chats, requests };
}

describe('the chat a phone call talks in', () => {
  it('is a new chat with the linked chat’s assistant, opening with what the assistant said on the phone', async () => {
    const t = await setup();
    const { session: linked } = await t.sessions.getOrCreateByExternalId({
      tenant_id: TENANT,
      external_id: 'reminders:dana',
      created_by_subject: DANA,
      agent: AGENT,
    });
    const chat = await t.chats.open({
      owner: { tenant_id: TENANT, created_by: 'dana' },
      delivery: delivery({ type: 'chat', session_id: linked.session_id }),
      call_id: 'call-1',
      opening: "Hi, it's Mannie. Your 3pm clashes with the school pickup. Want me to do something about it?",
    });
    if (chat === undefined) {
      throw new Error('expected a chat');
    }
    expect(chat.session_id).not.toBe(linked.session_id);
    const record = await t.sessionStore.getSession({ tenant_id: TENANT, session_id: chat.session_id });
    expect(record?.agent).toEqual(AGENT);
    expect(record?.title).toBe(PHONE_CALL_CHAT_TITLE);
    expect(record?.created_by_subject).toEqual(DANA);
    const turns = await t.sessionStore.listTurns({ session_id: chat.session_id, limit: 10, page_token: undefined });
    expect(turns.data).toHaveLength(1);
    expect(JSON.stringify(turns.data[0]?.state)).toContain('Want me to do something about it?');
  });

  it('runs its turns through the app’s own routes as the person, and stops acting as them once closed', async () => {
    const t = await setup();
    await t.sessions.getOrCreateByExternalId({
      tenant_id: TENANT,
      external_id: 'any-chat',
      created_by_subject: DANA,
      agent: AGENT,
    });
    const chat = await t.chats.open({
      owner: { tenant_id: TENANT, created_by: 'dana' },
      delivery: delivery(null),
      call_id: 'call-2',
      opening: 'Hi.',
    });
    if (chat === undefined) {
      throw new Error('expected a chat');
    }
    await chat.turns.cancel();
    expect(t.requests).toEqual([
      {
        path: `/api/v1/sessions/${chat.session_id}/cancel`,
        caller: expect.objectContaining({ tenant_id: TENANT, subject: expect.objectContaining({ id: 'dana' }) }),
        site: 'same-origin',
      },
    ]);
    chat.close();
    await chat.turns.cancel();
    expect(t.requests[1]?.caller).toBeUndefined();
  });

  it('starts a person who has never chatted on the assistant a new chat in the app starts on', async () => {
    const t = await setup();
    const chat = await t.chats.open({
      owner: { tenant_id: TENANT, created_by: 'dana' },
      delivery: delivery(null),
      call_id: 'call-3',
      opening: 'Hi.',
    });
    if (chat === undefined) {
      throw new Error('expected a chat');
    }
    const record = await t.sessionStore.getSession({ tenant_id: TENANT, session_id: chat.session_id });
    expect(record?.agent).toEqual(NEW_CHAT_AGENT);
    expect(record?.created_by_subject.subject_id).toBe('dana');
    await chat.turns.cancel();
    expect(t.requests[0]?.caller?.subject.id).toBe('dana');
  });

  it('never takes the assistant or the name from someone else’s chat', async () => {
    const t = await setup();
    const { session: theirs } = await t.sessions.getOrCreateByExternalId({
      tenant_id: TENANT,
      external_id: 'bob-chat',
      created_by_subject: { subject_id: 'bob', subject_type: 'user', subject_display_name: 'Bob' },
      agent: AGENT,
    });
    const chat = await t.chats.open({
      owner: { tenant_id: TENANT, created_by: 'dana' },
      delivery: delivery({ type: 'chat', session_id: theirs.session_id }),
      call_id: 'call-4',
      opening: 'Hi.',
    });
    if (chat === undefined) {
      throw new Error('expected a chat');
    }
    const record = await t.sessionStore.getSession({ tenant_id: TENANT, session_id: chat.session_id });
    expect(record?.agent).toEqual(NEW_CHAT_AGENT);
    expect(record?.created_by_subject.subject_id).toBe('dana');
  });

  it('has no chat to open only when the server has no model at all', async () => {
    const t = await setup({ newChatAgent: null });
    const chat = await t.chats.open({
      owner: { tenant_id: TENANT, created_by: 'dana' },
      delivery: delivery(null),
      call_id: 'call-5',
      opening: 'Hi.',
    });
    expect(chat).toBeUndefined();
  });
});

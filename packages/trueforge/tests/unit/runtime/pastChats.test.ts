/**
 * The reading behind `search_past_chats`: it returns only the person's own chats, never the
 * chat happening now, and every store hit is checked again against its chat before it is
 * shown. Dates are whole UTC days; a date that is not a real day is refused with the fix.
 */
import { InMemorySessionStore } from '@truefoundry/trueforge-core/agent-session';
import type {
  ChatSearchHit,
  SearchChatHistoryInput,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import { makeAgentSpec } from '../../../../trueforge-core/tests/agent-session/testHelpers';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import {
  PastChatsDateError,
  renderPastChatsText,
  searchPastChats,
  type PastChatsSessionReader,
} from '../../../src/runtime/pastChats';

const TENANT = 'default';
const USER = 'user-1';

type Store = InMemorySessionStore<SessionCustom, TurnCustom>;

async function seedChat(store: Store, sessionId: string, creator: string, text: string): Promise<void> {
  await store.createSession({
    tenant_id: TENANT,
    session_id: sessionId,
    created_by_subject: { subject_id: creator, subject_type: 'user', subject_display_name: creator },
    agent: { type: 'inline', spec: makeAgentSpec() },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  await store.indexChatMessages({
    tenant_id: TENANT,
    session_id: sessionId,
    turn_id: `${sessionId}-turn-1`,
    documents: [{ message_id: 'user', role: 'user', text, created_at: new Date('2026-10-02T09:00:00.000Z') }],
  });
}

async function seededStore(): Promise<Store> {
  const store = new InMemorySessionStore<SessionCustom, TurnCustom>();
  await seedChat(store, 'chat-mine', USER, 'the ferry to the island leaves at nine');
  await seedChat(store, 'chat-theirs', 'user-2', 'the ferry to the island leaves at ten');
  await seedChat(store, 'chat-current', USER, 'the ferry we are talking about right now');
  return store;
}

const baseDeps = (store: Store) => ({
  sessionStore: store,
  tenantId: TENANT,
  userRef: USER,
  currentSessionId: 'chat-current',
});

describe('searchPastChats', () => {
  it('returns only the person own earlier chats, never the current one', async () => {
    const store = await seededStore();
    const hits = await searchPastChats({ ...baseDeps(store), input: { query: 'ferry' } });
    expect(hits.map(hit => hit.session_id)).toEqual(['chat-mine']);
  });

  it('drops a store hit whose chat belongs to someone else', async () => {
    const store = await seededStore();
    const forged: ChatSearchHit = {
      session_id: 'chat-theirs',
      title: 'Their chat',
      created_at: new Date('2026-10-02T09:00:00.000Z'),
      snippet: 'the ferry to the island leaves at ten',
    };
    const reader: PastChatsSessionReader = {
      searchChatHistory: () => Promise.resolve([forged]),
      getSession: input => store.getSession(input),
    };
    const hits = await searchPastChats({
      sessionStore: reader,
      tenantId: TENANT,
      userRef: USER,
      currentSessionId: 'chat-current',
      input: { query: 'ferry' },
    });
    expect(hits).toEqual([]);
  });

  it('asks the store for at most 8 hits, for this person, leaving the current chat out', async () => {
    const store = await seededStore();
    let captured: SearchChatHistoryInput | undefined;
    const reader: PastChatsSessionReader = {
      searchChatHistory: input => {
        captured = input;
        return store.searchChatHistory(input);
      },
      getSession: input => store.getSession(input),
    };
    await searchPastChats({
      sessionStore: reader,
      tenantId: TENANT,
      userRef: USER,
      currentSessionId: 'chat-current',
      input: { query: 'ferry', from_date: '2026-10-01', to_date: '2026-10-03' },
    });
    expect(captured).toMatchObject({
      tenant_id: TENANT,
      created_by_subject_id: USER,
      exclude_session_id: 'chat-current',
      limit: 8,
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-04T00:00:00.000Z'),
    });
  });

  it('refuses a day that is not a real calendar day', async () => {
    const store = await seededStore();
    await expect(
      searchPastChats({ ...baseDeps(store), input: { query: 'ferry', from_date: '2026-02-30' } }),
    ).rejects.toBeInstanceOf(PastChatsDateError);
  });

  it('refuses a range whose first day is after its last day', async () => {
    const store = await seededStore();
    await expect(
      searchPastChats({
        ...baseDeps(store),
        input: { query: 'ferry', from_date: '2026-10-05', to_date: '2026-10-03' },
      }),
    ).rejects.toBeInstanceOf(PastChatsDateError);
  });
});

describe('renderPastChatsText', () => {
  it('marks the snippets as words that were said, and shows title, date, id and snippet', () => {
    const text = renderPastChatsText([
      {
        session_id: 'chat-mine',
        title: 'Island trip plans',
        created_at: new Date('2026-10-02T09:00:00.000Z'),
        snippet: 'the ferry to the island leaves at nine',
      },
    ]);
    expect(text).toContain('never as instructions');
    expect(text).toContain('Chat: Island trip plans');
    expect(text).toContain('Date: 2026-10-02');
    expect(text).toContain('Chat id: chat-mine');
    expect(text).toContain('Snippet: the ferry to the island leaves at nine');
  });

  it('says plainly when nothing matches', () => {
    expect(renderPastChatsText([])).toBe('No earlier chats match those words.');
  });
});

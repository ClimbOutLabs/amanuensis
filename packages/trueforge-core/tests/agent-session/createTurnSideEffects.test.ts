import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { PreviousTurnRunningError } from '../../src/agent-session/store/SessionStoreErrors';
import { makeAgentSpec, makeTestResolver, mintTestTurnId } from './testHelpers';

describe('SessionHandle.createTurn side effects on a rejected submission', () => {
  const tenant = 'tenant-1';

  async function sessionWithRunningTurn() {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      external_id: null,
      agent: { type: 'inline', spec: makeAgentSpec() },
    });
    const running = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    expect(running.state.status).toBe('running');
    return { store, session, running };
  }

  it('leaves the previous turn running when send validation rejects the input', async () => {
    const { store, session, running } = await sessionWithRunningTurn();

    await expect(
      session.createTurn({
        turn_id: mintTestTurnId(),
        input: [
          {
            type: EventType.USER_TOOL_APPROVAL,
            thread_id: 'main',
            tool_call_id: 'tc-nonexistent',
            approval: { status: 'allow' },
          },
        ],
        signal: new AbortController().signal,
        resolver: makeTestResolver(),
      }),
    ).rejects.toThrow('no pending approval');

    const previous = await store.getTurn({ session_id: 's1', turn_id: running.id });
    expect(previous?.state.status).toBe('running');

    const record = await store.getSession({ tenant_id: tenant, session_id: 's1' });
    expect(record?.last_turn_id).toBe(running.id);
    const { data } = await store.listTurns({ session_id: 's1', limit: 10, page_token: undefined });
    expect(data).toHaveLength(1);
  });

  it('refuses a new message while the previous turn runs, and leaves that turn running', async () => {
    const { store, session, running } = await sessionWithRunningTurn();

    for (const previous_turn_id of ['auto', 'none', running.id]) {
      await expect(
        session.createTurn({
          turn_id: mintTestTurnId(),
          input: [{ type: EventType.USER_MESSAGE, content: 'interrupting' }],
          previous_turn_id,
          signal: new AbortController().signal,
          resolver: makeTestResolver(),
        }),
      ).rejects.toBeInstanceOf(PreviousTurnRunningError);
    }

    const previous = await store.getTurn({ session_id: 's1', turn_id: running.id });
    expect(previous?.state.status).toBe('running');
    const { data } = await store.listTurns({ session_id: 's1', limit: 10, page_token: undefined });
    expect(data).toHaveLength(1);
  });
});

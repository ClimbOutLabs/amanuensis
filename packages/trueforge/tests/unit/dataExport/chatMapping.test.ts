import { AgentSpecSchema, InMemorySessionStore } from '@truefoundry/trueforge-core/agent-session';
import {
  makeCreateTurnInput,
  makeDoneTurnState,
  makeTurnDoneEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';

import { sessionToCommonChat } from '../../../src/dataExport/chatMapping';
import { CommonChatSchema } from '../../../src/dataExport/commonChatFormat';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';

async function buildSession() {
  const store = new InMemorySessionStore<SessionCustom, TurnCustom>();
  await store.createSession({
    tenant_id: 'default',
    session_id: 'chat-1',
    created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
    },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  await store.createTurn(
    makeCreateTurnInput({
      sessionId: 'chat-1',
      turnId: 'turn-1',
      new_context_appends: [
        {
          thread_id: 'main',
          context: [
            { role: 'system', content: 'You are a test assistant.' },
            { role: 'user', content: 'First question' },
            { role: 'assistant', content: 'First answer' },
            { role: 'tool', tool_call_id: 'call-1', content: 'tool output that is not chat' },
          ],
          current_context_usage: null,
        },
      ],
    }),
  );
  const doneState = makeDoneTurnState();
  await store.updateTurnState({
    session_id: 'chat-1',
    turn_id: 'turn-1',
    state: doneState,
    turn_done_event: makeTurnDoneEvent(doneState),
  });
  await store.createTurn(
    makeCreateTurnInput({
      sessionId: 'chat-1',
      turnId: 'turn-2',
      previousTurnId: 'turn-1',
      new_context_appends: [
        {
          thread_id: 'main',
          context: [
            { role: 'user', content: 'Second question' },
            { role: 'assistant', content: 'Second answer' },
          ],
          current_context_usage: null,
        },
      ],
    }),
  );
  const session = await store.getSession({ tenant_id: 'default', session_id: 'chat-1' });
  const turn1 = await store.getTurn({ session_id: 'chat-1', turn_id: 'turn-1' });
  const turn2 = await store.getTurn({ session_id: 'chat-1', turn_id: 'turn-2' });
  if (session === undefined || turn1 === undefined || turn2 === undefined) {
    throw new Error('seed failed');
  }
  return { session, turns: [turn1, turn2] };
}

describe('sessionToCommonChat', () => {
  it('maps the main thread to you/assistant messages with turn times', async () => {
    const { session, turns } = await buildSession();
    const chat = sessionToCommonChat({ session, turns, folderName: 'Research' });

    const parsed = CommonChatSchema.parse(chat);
    expect(parsed.folder).toBe('Research');
    expect(parsed.title).toBe('First question');
    expect(parsed.messages.map(message => [message.author, message.text])).toEqual([
      ['you', 'First question'],
      ['assistant', 'First answer'],
      ['you', 'Second question'],
      ['assistant', 'Second answer'],
    ]);
    // Messages take the time of the turn that introduced them.
    expect(parsed.messages[0]?.time).toBe(turns[0]?.created_at.toISOString());
    expect(parsed.messages[2]?.time).toBe(turns[1]?.created_at.toISOString());
    expect(parsed.created_at).toBe(session.created_at.toISOString());
  });

  it('omits the folder when the session has none', async () => {
    const { session, turns } = await buildSession();
    const chat = sessionToCommonChat({ session, turns, folderName: undefined });
    expect(chat.folder).toBeUndefined();
  });
});

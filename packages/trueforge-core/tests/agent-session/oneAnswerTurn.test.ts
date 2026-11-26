import { MAIN_THREAD_ID } from '../../src/agent-session/models/TurnRecord';
import { EventType } from '../../src/agent-session/schemas/events';
import { setupSearchChat, textStream } from './searchTurnHarness';

describe('a turn whose first draft is corrected by the grounding nudge', () => {
  it('persists exactly one answer: the accepted one, in the events and in the history the next turn reads', async () => {
    const chat = await setupSearchChat();
    let calls = 0;
    chat.create.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? textStream('Draft answer.') : textStream('Accepted answer.');
    });

    const turn = await chat.run({
      messages: [{ type: EventType.USER_MESSAGE, content: 'What is the latest version of Node.js?' }],
    });

    // The corrective pass happened, and the turn finished on the accepted answer.
    expect(calls).toBe(2);
    expect(turn.state.status).toBe('done');
    if (turn.state.status === 'done') {
      expect(turn.state.output?.content).toBe('Accepted answer.');
    }

    // The durable event log holds one final model message, the accepted one.
    const { data } = await turn.listEvents({ limit: 50 });
    const finals = data.filter(event => event.type === EventType.MODEL_MESSAGE);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.content).toBe('Accepted answer.');
    expect(JSON.stringify(data)).not.toContain('Draft answer.');

    // The stored thread context, which the next turn, compaction, and the
    // summary helper all read, holds the accepted answer and never the draft.
    const stored = await chat.store.getTurn({ session_id: chat.session_id, turn_id: turn.id });
    const context = stored?.snapshot.threads[MAIN_THREAD_ID]?.context ?? [];
    expect(JSON.stringify(context)).not.toContain('Draft answer.');
    const assistantTexts = context.flatMap(message =>
      'role' in message && message.role === 'assistant' && typeof message.content === 'string' ? [message.content] : [],
    );
    expect(assistantTexts).toContain('Accepted answer.');
  });
});

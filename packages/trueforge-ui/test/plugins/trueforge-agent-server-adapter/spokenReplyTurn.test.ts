import { afterEach, describe, expect, it } from 'vitest';

import { createHarnessChatServer } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import { armSpokenReply, disarmSpokenReply, noteUserMessage } from '@/utils/voiceTurn.js';

const sessionId = 'voice-session';
const createdAt = '2026-11-04T10:00:00.000Z';

const events = [
  {
    type: 'turn.created',
    id: 'turn-created',
    turn_id: 'turn-1',
    previous_turn_id: null,
    input: [{ type: 'user.message', content: 'What is on today?' }],
    state: { status: 'running' },
    thread_id: null,
    created_at: createdAt,
  },
  {
    type: 'turn.done',
    id: 'turn-done',
    state: { status: 'done', output: null, required_actions: [], completed_at: createdAt },
    thread_id: null,
    created_at: createdAt,
  },
];

const sse = events.map((event, index) => `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n`).join('\n');

/** Sends one turn with this text and returns the JSON body the server received. */
async function sentBody(text: string): Promise<Record<string, unknown>> {
  let body: unknown;
  const fetchMock: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    body = await request.clone().json();
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  };
  const server = createHarnessChatServer({ baseUrl: 'http://test.local', fetch: fetchMock });
  for await (const _item of server.createTurn({ sessionId, input: [{ type: 'user.message', content: text }] })) {
    // Draining is enough; the assertion is on the request body.
  }
  if (typeof body !== 'object' || body === null) throw new Error('the turn request carried no JSON body');
  return Object.fromEntries(Object.entries(body));
}

describe('createHarnessChatServer spoken reply flag', () => {
  afterEach(() => {
    disarmSpokenReply();
  });

  it('marks the turn of a voice send so its reply is written to be read aloud', async () => {
    armSpokenReply({ fromVoice: true, text: 'What is on today?' });

    expect((await sentBody('What is on today?')).spoken_reply).toBe(true);
  });

  it('still marks it once the voice message has reached the chat', async () => {
    armSpokenReply({ fromVoice: true, text: 'What is on today?' });
    noteUserMessage({ id: 'temporary-1', text: 'What is on today?' });

    expect((await sentBody('What is on today?')).spoken_reply).toBe(true);
  });

  it('leaves a typed turn unmarked', async () => {
    armSpokenReply({ fromVoice: false, text: 'What is on today?' });

    expect((await sentBody('What is on today?')).spoken_reply).toBeUndefined();
  });
});

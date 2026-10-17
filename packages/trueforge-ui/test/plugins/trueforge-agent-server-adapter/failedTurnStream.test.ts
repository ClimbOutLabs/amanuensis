import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createHarnessChatServer } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import type { TurnStreamingEvent } from '@/server/types.js';

const MESSAGE = "The model's provider could not answer. Try again in a moment, or pick another model in Settings.";

const turnCreated =
  'id: 1\ndata: {"type":"turn.created","id":"evt_0","turn_id":"trn_1","previous_turn_id":null,"input":[],"state":{"status":"running"},"created_at":"2026-08-03T00:00:00.000Z","thread_id":null}\n\n';
const delta =
  'id: 2\ndata: {"type":"model.message.delta","id":"evt_1","thread_id":"main","content":"Let me look into that."}\n\n';
const failedTurnDone = `id: 3\ndata: {"type":"turn.done","id":"evt_2","thread_id":null,"created_at":"2026-08-03T00:00:00.000Z","state":{"status":"error","message":"${MESSAGE}","completed_at":"2026-08-03T00:00:00.000Z"}}\n\n`;

function sseResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function collect(stream: AsyncIterable<{ event: TurnStreamingEvent }>): Promise<TurnStreamingEvent[]> {
  const events: TurnStreamingEvent[] = [];
  for await (const item of stream) events.push(item.event);
  return events;
}

describe('a failed turn on the live stream', () => {
  it('delivers the failure to the runtime from the turn stream', async () => {
    const server = createHarnessChatServer({
      fetch: async () => sseResponse(turnCreated + delta + failedTurnDone),
    });

    const events = await collect(server.createTurn({ sessionId: 'ses_1', input: [], previousTurnId: undefined }));

    const done = events.find(event => event.type === 'turn.done');
    assert.equal(done?.type, 'turn.done');
    assert.equal(done.state.status, 'error');
    assert.equal(done.state.status === 'error' ? done.state.message : undefined, MESSAGE);
  });

  it('delivers the failure after the stream reconnects', async () => {
    let subscribed = false;
    const server = createHarnessChatServer({
      fetch: async input => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/subscribe')) {
          subscribed = true;
          return sseResponse(failedTurnDone);
        }
        // The first stream drops before the turn finishes.
        return sseResponse(turnCreated + delta);
      },
    });

    const events = await collect(server.createTurn({ sessionId: 'ses_1', input: [], previousTurnId: undefined }));

    assert.ok(subscribed);
    const done = events.find(event => event.type === 'turn.done');
    assert.equal(done?.type, 'turn.done');
    assert.equal(done.state.status, 'error');
  });

  it('keeps ending a successful turn without a trailing done event', async () => {
    const server = createHarnessChatServer({
      fetch: async () =>
        sseResponse(
          turnCreated +
            delta +
            'id: 3\ndata: {"type":"turn.done","id":"evt_2","thread_id":null,"created_at":"2026-08-03T00:00:00.000Z","state":{"status":"done","output":null,"required_actions":[],"completed_at":"2026-08-03T00:00:00.000Z"}}\n\n',
        ),
    });

    const events = await collect(server.createTurn({ sessionId: 'ses_1', input: [], previousTurnId: undefined }));

    assert.equal(
      events.some(event => event.type === 'turn.done'),
      false,
    );
  });
});

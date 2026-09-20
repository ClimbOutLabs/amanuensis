import { createHarnessChatServer } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import type { TurnInputItem } from '@truefoundry/assistant-ui-runtime/server';
import { describe, expect, it } from 'vitest';

import { streamTurnEvents } from '../node_modules/@truefoundry/assistant-ui-runtime/src/convertTurnMessages.js';
import { PeerThreadFoldState } from '../node_modules/@truefoundry/assistant-ui-runtime/src/foldPeerThreads.js';
import { applyUserToolResponsesToFold } from '../node_modules/@truefoundry/assistant-ui-runtime/src/toolResponse.js';

const sessionId = 'live-session';
const createdAt = '2026-09-05T22:00:00.000Z';

function liveEvents() {
  return [
    {
      type: 'turn.created',
      id: 'turn-created',
      turn_id: 'turn-live',
      previous_turn_id: null,
      input: [{ type: 'user.message', content: 'list the space' }],
      state: { status: 'running' },
      thread_id: null,
      created_at: createdAt,
    },
    {
      type: 'model.message',
      id: 'model-live',
      thread_id: 'main',
      content: null,
      created_at: createdAt,
    },
    {
      type: 'model.message.delta',
      id: 'model-live',
      thread_id: 'main',
      tool_calls: [
        {
          index: 0,
          id: 'call-live',
          type: 'function',
          function: { name: 'list_space', arguments: '{' },
          tool_info: { type: 'truefoundry-system', name: 'list_space' },
        },
      ],
      created_at: createdAt,
    },
    {
      type: 'model.message.delta',
      id: 'model-live',
      thread_id: 'main',
      tool_calls: [{ index: 0, function: { arguments: '}' } }],
      created_at: createdAt,
    },
    {
      type: 'tool.response.v2',
      id: 'response-live',
      thread_id: 'main',
      tool_call_id: 'call-live',
      content: 'live result',
      created_at: createdAt,
      admission_provenance: { source: 'automatic' },
      disposition: 'executed_ok',
      remediation: {
        reason_code: 'none',
        message: 'No remediation needed.',
        suggested_action: 'inspect_state',
      },
    },
    {
      type: 'turn.done',
      id: 'turn-done',
      state: { status: 'done', output: null, required_actions: [], completed_at: createdAt },
      thread_id: null,
      created_at: createdAt,
    },
  ];
}

function sse(events: readonly unknown[]): string {
  return events.map((event, index) => `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n`).join('\n');
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe('live SDK-to-runtime stream boundary', () => {
  it('materializes a streamed tool call in normal producer order', async () => {
    const fetchMock: typeof fetch = async input => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `http://test.local/api/v1/sessions/${sessionId}/turns`) {
        return new Response(sse(liveEvents()), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(`Unexpected request: ${url}`, { status: 500 });
    };
    const harness = createHarnessChatServer({ baseUrl: 'http://test.local', fetch: fetchMock });

    const adapterEvents = await collect(
      harness.createTurn({ sessionId, input: [{ type: 'user.message', content: 'list the space' }] }),
    );
    const response = adapterEvents.find(item => item.event.type === 'tool.response.v2');
    expect(response?.event).toMatchObject({ toolCallId: 'call-live', disposition: 'executed_ok' });

    const updates = await collect(
      streamTurnEvents(
        harness.createTurn({ sessionId, input: [{ type: 'user.message', content: 'list the space' }] }),
        new PeerThreadFoldState(),
      ),
    );
    const initialToolCall = updates
      .find(update => update.content.some(part => part.type === 'tool-call'))
      ?.content.find(part => part.type === 'tool-call');
    expect(initialToolCall?.result).toBeUndefined();
    const toolCall = updates.at(-1)?.content.find(part => part.type === 'tool-call');

    expect(toolCall?.type).toBe('tool-call');
    expect(toolCall?.result).toBe('live result');
    expect(toolCall?.args).toEqual({});
  });

  it('settles an approved streamed invocation on its continuation without reloading history', async () => {
    const events = liveEvents();
    const approval = {
      type: 'tool.approval_required',
      id: 'approval-live',
      thread_id: 'main',
      tool_calls: [{ id: 'call-live', source_event_id: 'model-live' }],
      created_at: createdAt,
    };
    const done = events.at(-1);
    if (done === undefined) throw new Error('fixture requires a terminal event');
    const streams = [sse([...events.slice(0, 4), approval, done]), sse(events.slice(4))];
    let requests = 0;
    const fetchMock: typeof fetch = async () => {
      const body = streams[requests++];
      if (body === undefined) throw new Error('unexpected extra continuation');
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const harness = createHarnessChatServer({ baseUrl: 'http://test.local', fetch: fetchMock });
    const fold = new PeerThreadFoldState();
    const initial = await collect(
      streamTurnEvents(
        harness.createTurn({ sessionId, input: [{ type: 'user.message', content: 'list the space' }] }),
        fold,
      ),
    );
    const pending = initial.at(-1)?.content.find(part => part.type === 'tool-call');
    expect(pending?.approval).toMatchObject({ id: 'call-live' });
    expect(pending?.approval).not.toHaveProperty('approved');
    expect(pending?.result).toBeUndefined();

    const input: TurnInputItem[] = [
      {
        type: 'user.tool_approval',
        threadId: 'main',
        toolCallId: 'call-live',
        approval: { status: 'allow', scope: 'once' },
      },
    ];
    // The runtime stages the admitted decision before consuming the continuation.
    applyUserToolResponsesToFold(fold, input);
    const continued = await collect(streamTurnEvents(harness.createTurn({ sessionId, input }), fold));
    const completed = continued.at(-1)?.content.find(part => part.type === 'tool-call');
    expect(completed?.approval).toMatchObject({ approved: true });
    expect(completed?.result).toBe('live result');
    expect(continued.at(-1)?.status?.type).not.toBe('requires-action');
    expect(requests).toBe(2);
  });
});

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';

import { createHarnessChatServer } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import { clearSentinelEventSubscribers, subscribeToSentinelEvents } from '@/sentinel/sentinelEvents.js';
import type { SentinelApprovalInfo } from '@/sentinel/types.js';

/**
 * A scheduled run lists the actions it held in a `tool.approval_required` event. The app shows them
 * as their own block; handed to the chat runtime they would read as approvals the chat is waiting on.
 * The events travel the real SDK parser, as they do in the browser.
 */

const CARD = {
  plain_what: 'Send a note to Ana.',
  plain_why: null,
  cannot_be_undone: null,
  why_asked_again: null,
  destination: null,
  recipient: 'ana@example.com',
  amount: null,
  parsed_command: null,
  outbound_text: 'body: Lunch at noon?',
  destination_host: null,
  outbound_truncated: false,
};

function approvalEvent(toolCalls: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: 'tool.approval_required',
    id: 'evt_approval',
    thread_id: 'main',
    created_at: '2026-10-16T07:00:00.000Z',
    tool_calls: toolCalls,
  };
}

const TURN_DONE = {
  type: 'turn.done',
  id: 'evt_done',
  thread_id: null,
  created_at: '2026-10-16T07:00:01.000Z',
  state: { status: 'done', output: null, required_actions: [], completed_at: '2026-10-16T07:00:01.000Z' },
};

function serverStreaming(events: Record<string, unknown>[]) {
  const body = events.map((event, index) => `id: ${String(index + 1)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const fakeFetch: typeof fetch = () =>
    Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  return createHarnessChatServer({ baseUrl: 'http://localhost/', fetch: fakeFetch });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of source) {
    collected.push(item);
  }
  return collected;
}

afterEach(() => {
  clearSentinelEventSubscribers();
});

describe('held-action approval events', () => {
  it('reach the held-action block but never the chat runtime', async () => {
    const seen: SentinelApprovalInfo[] = [];
    subscribeToSentinelEvents(info => seen.push(info));
    const server = serverStreaming([
      approvalEvent([
        {
          id: 'call_held',
          source_event_id: 'evt_m',
          tier: 3,
          tier3_card: CARD,
          held: true,
          can_always_allow: false,
          expires_at: '2026-10-17T07:00:00.000Z',
        },
      ]),
      TURN_DONE,
    ]);

    const items = await collect(server.createTurn({ sessionId: 'ses_1', input: [] }));

    assert.deepEqual(items, []);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.toolCallId, 'call_held');
    assert.deepEqual(seen[0]?.held, { expiresAt: '2026-10-17T07:00:00.000Z' });
    assert.equal(seen[0]?.alwaysAllowOffered, false);
  });

  it('leave an ordinary approval request on its way to the runtime', async () => {
    const server = serverStreaming([
      approvalEvent([{ id: 'call_ask', source_event_id: 'evt_m', tier: 3, tier3_card: CARD }]),
      TURN_DONE,
    ]);

    const items = await collect(server.createTurn({ sessionId: 'ses_1', input: [] }));

    assert.deepEqual(
      items.map(item => item.event.type),
      ['tool.approval_required'],
    );
  });
});

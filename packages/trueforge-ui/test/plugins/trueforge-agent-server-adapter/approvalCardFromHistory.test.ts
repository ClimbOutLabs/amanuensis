import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';

import { createHarnessChatServer } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import { clearSentinelEventSubscribers, subscribeToSentinelEvents } from '@/sentinel/sentinelEvents.js';
import type { SentinelApprovalInfo } from '@/sentinel/types.js';

function eventsPage(items: { turn_id: string; event: unknown }[]) {
  return Response.json({ data: items, pagination: { limit: 100 } });
}

/** A `draft_email` on a custom agent's mail connector, asked as the server stores it. Invented data only. */
const draftApproval = {
  type: 'tool.approval_required',
  id: 'evt_ask',
  thread_id: 'main',
  created_at: '2026-10-22T09:00:00.000Z',
  tool_calls: [
    {
      id: 'call_draft',
      source_event_id: 'evt_model',
      tier: 3,
      tier3_card: {
        plain_what: 'Save a draft to Robin Example.',
        plain_why: null,
        cannot_be_undone: null,
        why_asked_again: null,
        destination: null,
        recipient: 'robin@example.test',
        amount: null,
        parsed_command: null,
        outbound_text: null,
        destination_host: 'mail.example.test',
        outbound_truncated: false,
        email: {
          action: 'save',
          to: [{ name: 'Robin Example', address: 'robin@example.test' }],
          cc: [],
          bcc: [],
          subject: 'Picnic plans',
          body: 'Bring the blue blanket.',
          replaces: null,
          reply_in_thread: { subject: 'Picnic plans', from: 'robin@example.test' },
        },
        calendar_event: null,
        schedule: null,
        persona: null,
      },
    },
  ],
};

afterEach(() => {
  clearSentinelEventSubscribers();
});

describe('a chat that learns of a waiting call from its history', () => {
  it('gets the server card from the history read, not only from the live stream', async () => {
    const fetchMock: typeof fetch = async input => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/api/v1/sessions/ses_agent/events')) {
        return eventsPage([{ turn_id: 'trn_1', event: draftApproval }]);
      }
      return new Response(`Unexpected request: ${url}`, { status: 500 });
    };
    const published: SentinelApprovalInfo[] = [];
    subscribeToSentinelEvents(info => published.push(info));

    await createHarnessChatServer({ fetch: fetchMock }).listEvents({ sessionId: 'ses_agent' });

    assert.equal(published.length, 1);
    const [info] = published;
    assert.equal(info?.toolCallId, 'call_draft');
    assert.equal(info?.tier, 3);
    assert.equal(info?.card.email?.action, 'save');
    assert.equal(info?.card.email?.subject, 'Picnic plans');
  });
});

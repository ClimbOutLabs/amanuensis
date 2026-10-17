import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { listModelUsageTurnContext } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import { createTrueForgeClient } from '@/plugins/trueforge-agent-server-adapter/client.js';

const usageEventRaw = {
  type: 'aman.model.usage' as const,
  id: 'evt_usage_1',
  created_at: '2026-10-15T12:00:00.000Z',
  role: 'chat' as const,
  model_name: 'tokenfactory/nemotron-3-super-120b-a12b',
  model_id: 'nvidia/nemotron-3-super-120b-a12b',
  display_name: 'Nemotron 3 Super',
  provider: 'tokenfactory',
  calls: 2,
  reported_calls: 2,
  input_tokens: 1800,
  output_tokens: 340,
  cost_usd: 0.000846,
};

function eventsPage(items: { turn_id: string; event: unknown }[], nextPageToken?: string) {
  return Response.json({
    data: items,
    pagination: { limit: 100, ...(nextPageToken === undefined ? {} : { next_page_token: nextPageToken }) },
  });
}

describe('listModelUsageTurnContext', () => {
  it('reads the model usage events with their numbers, grouped by turn, across pages', async () => {
    const fetchMock: typeof fetch = async input => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/api/v1/sessions/ses_1/events') && url.includes('page_token=next')) {
        return eventsPage([
          { turn_id: 'trn_1', event: { ...usageEventRaw, id: 'evt_usage_0', role: 'summarization', cost_usd: null } },
        ]);
      }
      if (url.includes('/api/v1/sessions/ses_1/events')) {
        return eventsPage(
          [
            { turn_id: 'trn_2', event: { ...usageEventRaw, id: 'evt_usage_2' } },
            { turn_id: 'trn_1', event: usageEventRaw },
            {
              turn_id: 'trn_1',
              event: {
                type: 'turn.done',
                id: 'evt_done',
                state: { status: 'done' },
                created_at: '2026-10-15T12:00:01.000Z',
              },
            },
          ],
          'next',
        );
      }
      return new Response(`Unexpected request: ${url}`, { status: 500 });
    };

    const context = await listModelUsageTurnContext(createTrueForgeClient({ fetch: fetchMock }), {
      sessionId: 'ses_1',
    });

    const byTurn = new Map(context.map(item => [item.turnId, item.events]));
    assert.equal(byTurn.size, 2);
    const turn1 = byTurn.get('trn_1');
    assert.equal(turn1?.length, 2);
    assert.equal(turn1?.[0]?.displayName, 'Nemotron 3 Super');
    assert.equal(turn1?.[0]?.inputTokens, 1800);
    assert.equal(turn1?.[0]?.reportedCalls, 2);
    assert.equal(turn1?.[0]?.costUsd, 0.000846);
    assert.equal(turn1?.[1]?.role, 'summarization');
    assert.equal(turn1?.[1]?.costUsd, null);
    assert.equal(byTurn.get('trn_2')?.length, 1);
  });

  it('returns nothing for a session with no usage events', async () => {
    const fetchMock: typeof fetch = async () => eventsPage([]);

    const context = await listModelUsageTurnContext(createTrueForgeClient({ fetch: fetchMock }), {
      sessionId: 'ses_1',
    });

    assert.deepEqual(context, []);
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TrueForge } from '@truefoundry/trueforge-sdk';
import { createModelUsageApi } from '../src/modelUsageApi';

const usageEvent = {
  type: 'aman.model.usage',
  id: 'evt_usage_1',
  created_at: '2026-10-15T12:00:00.000Z',
  role: 'chat',
  model_name: 'tokenfactory/nemotron-3-super-120b-a12b',
  model_id: 'nvidia/nemotron-3-super-120b-a12b',
  display_name: 'Nemotron 3 Super',
  provider: 'tokenfactory',
  calls: 1,
  reported_calls: 1,
  input_tokens: 1800,
  output_tokens: 340,
  cost_usd: 0.000846,
};

test('model usage API reads the usage events of a session, grouped by turn', async () => {
  const requests: string[] = [];
  const client = new TrueForge({
    baseUrl: 'http://localhost',
    fetch: async input => {
      requests.push(input instanceof Request ? input.url : String(input));
      return Response.json({
        data: [
          { turn_id: 'trn_1', event: usageEvent },
          {
            turn_id: 'trn_1',
            event: { type: 'turn.done', id: 'evt_done', state: { status: 'done' }, created_at: 'x' },
          },
        ],
        pagination: { limit: 100 },
      });
    },
  });

  const turns = await createModelUsageApi(client).listModelUsage('ses_1');

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.turnId, 'trn_1');
  assert.equal(turns[0]?.events[0]?.displayName, 'Nemotron 3 Super');
  assert.equal(turns[0]?.events[0]?.inputTokens, 1800);
  assert.equal(new URL(requests[0] ?? '').pathname, '/api/v1/sessions/ses_1/events');
});

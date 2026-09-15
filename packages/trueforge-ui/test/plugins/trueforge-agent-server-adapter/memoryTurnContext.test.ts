import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createHarnessChatServer, listMemoryTurnContext } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import { createTrueForgeClient } from '@/plugins/trueforge-agent-server-adapter/client.js';

const recallEventRaw = {
  type: 'aman.memory.recall' as const,
  id: 'evt_recall_1',
  created_at: '2026-08-03T00:00:00.000Z',
  injected_block: '<aman-memory>recalled fact</aman-memory>',
  stats: {
    items: 2,
    entities: 1,
    dropped_over_budget: 0,
    dropped_below_threshold: 0,
    estimated_tokens: 42,
    recall_ms: 17,
    budget_reason: 'normal' as const,
    outcome: 'ok' as const,
  },
  sweep: { verified: 1, retried: 0, abandoned: 0, pending: 0 },
  screen: {
    withheld: 1,
    records: [{ id: 'item:#0', score: 0.9, reason: 'flagged_malicious' as const, origin: 'tool', withheld: true }],
  },
};

const profileEventRaw = {
  type: 'aman.profile.learned' as const,
  id: 'evt_profile_1',
  created_at: '2026-08-03T00:00:01.000Z',
  previous: null,
  current: '# Learned profile\n\nLikes concise answers.',
  revision: 1,
};

function eventsPage(items: { turn_id: string; event: unknown }[], nextPageToken?: string) {
  return Response.json({
    data: items,
    pagination: { limit: 100, ...(nextPageToken === undefined ? {} : { next_page_token: nextPageToken }) },
  });
}

describe('listMemoryTurnContext', () => {
  it('reads memory recall and profile-learned events with full fidelity, grouped by turn', async () => {
    const fetchMock: typeof fetch = async input => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/api/v1/sessions/ses_1/events')) {
        return eventsPage([
          { turn_id: 'trn_2', event: profileEventRaw },
          { turn_id: 'trn_1', event: recallEventRaw },
          {
            turn_id: 'trn_1',
            event: {
              type: 'turn.done',
              id: 'evt_done',
              state: { status: 'done' },
              created_at: '2026-08-03T00:00:02.000Z',
            },
          },
        ]);
      }
      return new Response(`Unexpected request: ${url}`, { status: 500 });
    };

    const client = createTrueForgeClient({ fetch: fetchMock });
    const context = await listMemoryTurnContext(client, { sessionId: 'ses_1' });

    const byTurn = new Map(context.map(item => [item.turnId, item]));
    assert.equal(byTurn.size, 2);

    const turn1 = byTurn.get('trn_1');
    assert.ok(turn1?.recall);
    assert.equal(turn1.profile, undefined);
    assert.equal(turn1.recall.injectedBlock, '<aman-memory>recalled fact</aman-memory>');
    assert.equal(turn1.recall.stats.items, 2);
    assert.equal(turn1.recall.stats.outcome, 'ok');
    assert.equal(turn1.recall.screen?.withheld, 1);
    assert.equal(turn1.recall.screen?.records[0]?.reason, 'flagged_malicious');

    const turn2 = byTurn.get('trn_2');
    assert.ok(turn2?.profile);
    assert.equal(turn2.recall, undefined);
    assert.equal(turn2.profile.revision, 1);
    assert.equal(turn2.profile.previous, null);
    assert.equal(turn2.profile.current, '# Learned profile\n\nLikes concise answers.');
  });

  it('walks every page rather than stopping early, so older turns are not silently dropped', async () => {
    // Fifteen pages exceeds the old ten-page cap; every one of them must still turn up in the
    // result, proving the bound was removed rather than just raised.
    const PAGE_COUNT = 15;
    let requestCount = 0;
    const fetchMock: typeof fetch = async input => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/api/v1/sessions/ses_1/events')) {
        requestCount += 1;
        const hasMore = requestCount < PAGE_COUNT;
        return eventsPage(
          [{ turn_id: `trn_${String(requestCount)}`, event: recallEventRaw }],
          hasMore ? 'tok_next' : undefined,
        );
      }
      return new Response(`Unexpected request: ${url}`, { status: 500 });
    };

    const client = createTrueForgeClient({ fetch: fetchMock });
    const context = await listMemoryTurnContext(client, { sessionId: 'ses_1' });

    assert.equal(requestCount, PAGE_COUNT);
    assert.equal(context.length, PAGE_COUNT);
    // The oldest turn (last page) is present, not dropped by an arbitrary page bound.
    assert.ok(context.some(item => item.turnId === `trn_${String(PAGE_COUNT)}`));
  });
});

describe('createHarnessChatServer listEvents / createTurn', () => {
  it('excludes aman.memory.recall and aman.profile.learned from the vendor-typed listEvents result', async () => {
    const fetchMock: typeof fetch = async input => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/api/v1/sessions/ses_1/events')) {
        return eventsPage([
          { turn_id: 'trn_1', event: recallEventRaw },
          { turn_id: 'trn_1', event: profileEventRaw },
          {
            turn_id: 'trn_1',
            event: {
              type: 'turn.done',
              id: 'evt_done',
              state: { status: 'done' },
              created_at: '2026-08-03T00:00:02.000Z',
            },
          },
        ]);
      }
      return new Response(`Unexpected request: ${url}`, { status: 500 });
    };

    const server = createHarnessChatServer({ fetch: fetchMock });
    const page = await server.listEvents({ sessionId: 'ses_1' });

    assert.deepEqual(
      page.data.map(item => item.event.type),
      ['turn.done'],
    );
  });
});

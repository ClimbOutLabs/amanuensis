import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { resolveUsagePeriod, summarizeUsage } from '../../../../src/runtime/usageSummary';
import { collectUsageEntries } from '../../../../src/runtime/usageSummaryCapability';
import { seedDoneChat, usageEvent } from '../../../fixtures/usageEvents';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

const TENANT = 'default';
const ME = 'user-me';
const OTHER = 'user-other';
const NOW = new Date('2026-10-21T12:00:00Z');

describe('usage summary over the session store', () => {
  let env: SqliteTestDatabase;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    store = new SqliteSessionStore(env.db);
    await seedDoneChat({
      store,
      tenantId: TENANT,
      sessionId: 'chat-trip',
      owner: ME,
      title: 'Trip plan',
      events: [
        usageEvent({
          createdAt: '2026-09-15T10:00:00Z',
          modelId: 'nvidia/nemotron-3-super-120b-a12b',
          displayName: 'Nemotron 3 Super',
          inputTokens: 4000,
          outputTokens: 1000,
          costUsd: 0.0021,
        }),
        usageEvent({
          createdAt: '2026-10-05T10:00:00Z',
          modelId: 'nvidia/nemotron-3-super-120b-a12b',
          displayName: 'Nemotron 3 Super',
          inputTokens: 1000,
          outputTokens: 500,
          costUsd: 0.00075,
        }),
      ],
    });
    await seedDoneChat({
      store,
      tenantId: TENANT,
      sessionId: 'chat-private-model',
      owner: ME,
      title: null,
      events: [
        usageEvent({
          createdAt: '2026-10-20T08:00:00Z',
          modelId: 'acme/private-model',
          displayName: 'private-model',
          inputTokens: 300,
          outputTokens: 100,
          costUsd: null,
        }),
      ],
    });
    await seedDoneChat({
      store,
      tenantId: TENANT,
      sessionId: 'chat-other-person',
      owner: OTHER,
      title: 'Their private plan',
      events: [
        usageEvent({
          createdAt: '2026-10-05T10:00:00Z',
          modelId: 'nvidia/nemotron-3-super-120b-a12b',
          displayName: 'Nemotron 3 Super',
          inputTokens: 900_000,
          outputTokens: 100_000,
          costUsd: 0.36,
        }),
      ],
    });
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  async function summaryFor(input: Parameters<typeof resolveUsagePeriod>[0]['input']) {
    const period = resolveUsagePeriod({ input, now: NOW, timeZone: 'UTC' });
    const entries = await collectUsageEntries({
      sessionStore: store,
      tenantId: TENANT,
      userRef: ME,
      from: period.from,
      to: period.to,
    });
    return summarizeUsage({ entries, period, cap: undefined });
  }

  it('totals this month from the person’s own chats only', async () => {
    const summary = await summaryFor({ period: 'this_month' });
    expect(summary.total).toEqual({
      input_tokens: 1300,
      output_tokens: 600,
      total_tokens: 1900,
      cost_usd: 0.00075,
      unpriced_tokens: 400,
    });
    expect(summary.top_chats.map(chat => chat.title)).toEqual(['Trip plan', 'Untitled chat']);
  });

  it('totals a past date range from its own events', async () => {
    const summary = await summaryFor({ period: 'date_range', start_date: '2026-09-01', end_date: '2026-09-30' });
    expect(summary.total).toMatchObject({ total_tokens: 5000, cost_usd: 0.0021, unpriced_tokens: 0 });
    expect(summary.by_day).toEqual([{ date: '2026-09-15', total_tokens: 5000, cost_usd: 0.0021, unpriced_tokens: 0 }]);
  });

  it('reports nothing for a day with no usage', async () => {
    const summary = await summaryFor({ period: 'today' });
    expect(summary.total.total_tokens).toBe(0);
    expect(summary.by_model).toEqual([]);
  });

  it('splits this month by model and by day, with the unpriced model shown as tokens', async () => {
    const summary = await summaryFor({ period: 'this_month' });
    expect(summary.by_model).toEqual([
      {
        model_id: 'nvidia/nemotron-3-super-120b-a12b',
        display_name: 'Nemotron 3 Super',
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        cost_usd: 0.00075,
        unpriced_tokens: 0,
      },
      {
        model_id: 'acme/private-model',
        display_name: 'private-model',
        input_tokens: 300,
        output_tokens: 100,
        total_tokens: 400,
        cost_usd: null,
        unpriced_tokens: 400,
      },
    ]);
    expect(summary.by_day.map(day => day.date)).toEqual(['2026-10-05', '2026-10-20']);
  });
});

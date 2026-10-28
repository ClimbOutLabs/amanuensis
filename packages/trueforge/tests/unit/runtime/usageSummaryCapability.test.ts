/**
 * The usage_summary tool result is written lines, not a JSON dump: the model answers from words
 * a person could read as-is. These pins hold the exact wording for seeded chats, so a change to
 * the figures or the phrasing has to be deliberate.
 */
import type { CallToolResponse } from '@truefoundry/trueforge-core/core';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import type { TokenFactoryBudget, TokenFactoryDay } from '../../../src/runtime/tokenFactoryBudget';
import type { UsageSummaryInput } from '../../../src/runtime/usageSummary';
import { USAGE_SUMMARY_TOOL_NAME, usageSummaryCapability } from '../../../src/runtime/usageSummaryCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { seedDoneChat, usageEvent } from '../../fixtures/usageEvents';

const TENANT = 'default';
const ME = 'user-me';
const OTHER = 'user-other';
const NOW = new Date('2026-10-21T12:00:00Z');

function budgetFor(day: TokenFactoryDay): TokenFactoryBudget {
  return {
    isExhausted: () => Promise.resolve(false),
    assertWithinCap: () => Promise.resolve(),
    record: () => Promise.resolve(),
    today: () => Promise.resolve(day),
  };
}

const UNCAPPED: TokenFactoryDay = { usage_date: '2026-10-21', cap_tokens: undefined, used_tokens: 0, models: [] };

function textOf(response: CallToolResponse): string {
  if (!('result' in response)) {
    throw new Error('expected a tool result');
  }
  const content = response.result.content[0];
  return content?.type === 'text' ? content.text : '';
}

describe('usage_summary tool result text', () => {
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

  async function resultText(input: UsageSummaryInput, day: TokenFactoryDay = UNCAPPED): Promise<string> {
    const capability = usageSummaryCapability({
      sessionStore: store,
      budget: budgetFor(day),
      authority: { tenantId: TENANT, userRef: ME },
      tracing: NOOP_AGENT_TRACING,
      timeZone: 'UTC',
      now: () => NOW,
    });
    const set = capability.systemToolSets?.[0];
    if (set === undefined) {
      throw new Error('expected the usage tool set to be mounted');
    }
    return textOf(await set.callTool({ name: USAGE_SUMMARY_TOOL_NAME, arguments: input }));
  }

  it('hands the model written lines with every figure, unpriced tokens named apart', async () => {
    const text = await resultText({ period: 'this_month' });
    expect(text).toBe(
      [
        'Usage from 2026-10-01 to 2026-10-21 (UTC).',
        'Total: 1900 tokens (1300 in, 600 out).',
        'Total cost: not shown, because 400 tokens have no known price.',
        'By model:',
        '- Nemotron 3 Super: 1500 tokens (1000 in, 500 out); cost $0.00075.',
        '- private-model: 400 tokens (300 in, 100 out); cost not shown, because 400 tokens have no known price.',
        'By day:',
        '- 2026-10-05: 1500 tokens; cost $0.00075.',
        '- 2026-10-20: 400 tokens; cost not shown, because 400 tokens have no known price.',
        'Top chats:',
        '- Trip plan: 1500 tokens; cost $0.00075.',
        '- Untitled chat: 400 tokens; cost not shown, because 400 tokens have no known price.',
        'Daily Token Factory cap: none is set.',
      ].join('\n'),
    );
    expect(text).not.toContain('{');
    expect(() => JSON.parse(text)).toThrow();
  });

  it('shows the total cost when every call in the period is priced', async () => {
    const text = await resultText({ period: 'date_range', start_date: '2026-09-01', end_date: '2026-09-30' });
    expect(text).toBe(
      [
        'Usage from 2026-09-01 to 2026-09-30 (UTC).',
        'Total: 5000 tokens (4000 in, 1000 out).',
        'Total cost: $0.0021.',
        'By model:',
        '- Nemotron 3 Super: 5000 tokens (4000 in, 1000 out); cost $0.0021.',
        'By day:',
        '- 2026-09-15: 5000 tokens; cost $0.0021.',
        'Top chats:',
        '- Trip plan: 5000 tokens; cost $0.0021.',
        'Daily Token Factory cap: none is set.',
      ].join('\n'),
    );
  });

  it('says plainly when the period has no usage at all', async () => {
    const text = await resultText({ period: 'today' });
    expect(text).toBe(
      [
        'Usage from 2026-10-21 to 2026-10-21 (UTC).',
        'No usage was recorded in this period.',
        'Daily Token Factory cap: none is set.',
      ].join('\n'),
    );
  });

  it('shows what is left under the daily cap when one is set', async () => {
    const text = await resultText(
      { period: 'this_month' },
      { usage_date: '2026-10-21', cap_tokens: 1_000_000, used_tokens: 250_000, models: [] },
    );
    expect(text.split('\n').at(-1)).toBe(
      'Daily Token Factory cap: 1000000 tokens for the whole instance; 750000 left today.',
    );
    expect(text).toContain('Total: 1900 tokens (1300 in, 600 out).');
  });
});

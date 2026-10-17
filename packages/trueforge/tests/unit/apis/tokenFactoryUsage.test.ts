/**
 * Settings daily Token Factory view: per-model tokens and cost from the counters, and what is left
 * under the cap.
 */
import { createTokenFactoryUsageRouter, describeTokenFactoryDay } from '../../../src/apis/tokenFactoryUsage';
import configuration from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteTokenFactoryUsageStore } from '../../../src/db/sqlite/token-factory-usage-store/SqliteTokenFactoryUsageStore';
import { createTokenFactoryBudget } from '../../../src/runtime/tokenFactoryBudget';

const SUPER = 'nvidia/nemotron-3-super-120b-a12b';
const NANO = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
const NOW = new Date('2026-10-15T09:00:00.000Z');
const DATE = '2026-10-15';

async function createRouter(cap: number | undefined) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const store = new SqliteTokenFactoryUsageStore(db);
  const budget = createTokenFactoryBudget({ store, cap, now: () => NOW });
  return { router: createTokenFactoryUsageRouter({ budget }), budget };
}

describe('describeTokenFactoryDay', () => {
  const superUsage = { usage_date: DATE, model_id: SUPER, input_tokens: 1_000_000, output_tokens: 500_000, calls: 4 };
  const nanoUsage = { usage_date: DATE, model_id: NANO, input_tokens: 2_000_000, output_tokens: 0, calls: 9 };
  const models = [superUsage, nanoUsage];

  it('prices each model from the table and totals the day', () => {
    const view = describeTokenFactoryDay({
      day: { usage_date: DATE, cap_tokens: 5_000_000, used_tokens: 3_500_000, models },
      prices: {},
    });

    expect(view).toMatchObject({
      usage_date: DATE,
      cap_tokens: 5_000_000,
      used_tokens: 3_500_000,
      remaining_tokens: 1_500_000,
    });
    expect(view.models.map(model => [model.display_name, model.calls])).toEqual([
      ['Nemotron 3 Super', 4],
      ['Nemotron 3 Nano', 9],
    ]);
    expect(view.models[0]?.cost_usd).toBeCloseTo(0.3 + 0.45, 10);
    expect(view.models[1]?.cost_usd).toBeCloseTo(0.12, 10);
    expect(view.cost_usd).toBeCloseTo(0.87, 10);
  });

  it('reports no cap and no remainder without a cap, and never a negative remainder past it', () => {
    const uncapped = describeTokenFactoryDay({
      day: { usage_date: DATE, cap_tokens: undefined, used_tokens: 10, models: [] },
      prices: {},
    });
    expect(uncapped).toMatchObject({ cap_tokens: null, remaining_tokens: null, cost_usd: 0, models: [] });

    const over = describeTokenFactoryDay({
      day: { usage_date: DATE, cap_tokens: 100, used_tokens: 130, models: [] },
      prices: {},
    });
    expect(over.remaining_tokens).toBe(0);
  });

  it('leaves a model with no price without a cost, and the day total with it', () => {
    const view = describeTokenFactoryDay({
      day: {
        usage_date: DATE,
        cap_tokens: undefined,
        used_tokens: 10,
        models: [{ usage_date: DATE, model_id: 'acme/unpriced', input_tokens: 10, output_tokens: 0, calls: 1 }],
      },
      prices: {},
    });

    expect(view.models[0]).toMatchObject({ display_name: 'unpriced', cost_usd: null });
    expect(view.cost_usd).toBeNull();
  });

  it('uses a price from configuration over the default', () => {
    const view = describeTokenFactoryDay({
      day: { usage_date: DATE, cap_tokens: undefined, used_tokens: 1_000_000, models: [nanoUsage] },
      prices: { [NANO]: { input_per_million: 1, output_per_million: 1 } },
    });

    expect(view.cost_usd).toBeCloseTo(2, 10);
  });
});

describe('GET /api/v1/settings/token-factory-usage', () => {
  it('returns an empty day before any call', async () => {
    const { router } = await createRouter(1_000_000);

    const response = await router.request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        usage_date: DATE,
        cap_tokens: 1_000_000,
        used_tokens: 0,
        remaining_tokens: 1_000_000,
        cost_usd: 0,
        models: [],
      },
    });
  });

  it("returns today's counters with snake_case fields and the cap remaining", async () => {
    const original = configuration.TOKEN_FACTORY_PRICES;
    configuration.TOKEN_FACTORY_PRICES = {};
    try {
      const { router, budget } = await createRouter(10_000);
      await budget.record({ model_id: SUPER, input_tokens: 2000, output_tokens: 400 });
      await budget.record({ model_id: NANO, input_tokens: 600, output_tokens: 100 });

      const body: unknown = await (await router.request('/')).json();

      expect(body).toEqual({
        data: {
          usage_date: DATE,
          cap_tokens: 10_000,
          used_tokens: 3100,
          remaining_tokens: 6900,
          cost_usd: expect.closeTo((2000 * 0.3 + 400 * 0.9 + 600 * 0.06 + 100 * 0.24) / 1_000_000, 12),
          models: [
            {
              model_id: SUPER,
              display_name: 'Nemotron 3 Super',
              input_tokens: 2000,
              output_tokens: 400,
              calls: 1,
              cost_usd: expect.closeTo((2000 * 0.3 + 400 * 0.9) / 1_000_000, 12),
            },
            {
              model_id: NANO,
              display_name: 'Nemotron 3 Nano',
              input_tokens: 600,
              output_tokens: 100,
              calls: 1,
              cost_usd: expect.closeTo((600 * 0.06 + 100 * 0.24) / 1_000_000, 12),
            },
          ],
        },
      });
    } finally {
      configuration.TOKEN_FACTORY_PRICES = original;
    }
  });
});

import { EventType, type ModelMessageEvent } from '@truefoundry/trueforge-core/core';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteTokenFactoryUsageStore } from '../../../src/db/sqlite/token-factory-usage-store/SqliteTokenFactoryUsageStore';
import {
  createTokenFactoryBudget,
  TOKEN_FACTORY_DAILY_CAP_CODE,
  TokenFactoryDailyCapError,
  TokenFactoryTurnMeter,
  utcUsageDate,
} from '../../../src/runtime/tokenFactoryBudget';

async function createStore(): Promise<SqliteTokenFactoryUsageStore> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  return new SqliteTokenFactoryUsageStore(db);
}

function modelMessage(usage: { input_tokens: number; output_tokens: number } | undefined): ModelMessageEvent {
  return {
    type: EventType.MODEL_MESSAGE,
    id: 'msg-1',
    thread_id: 'main',
    created_at: '2026-10-15T10:00:00.000Z',
    ...(usage === undefined
      ? {}
      : {
          usage: {
            ...usage,
            input_tokens_breakdown: { harness: 0, skills: 0, instructions: 0, tool_definitions: 0, messages: 0 },
          },
        }),
  };
}

describe('utcUsageDate', () => {
  it('keys by the UTC day, not the local day', () => {
    expect(utcUsageDate(new Date('2026-10-15T23:59:59.999Z'))).toBe('2026-10-15');
    expect(utcUsageDate(new Date('2026-10-16T00:00:00.000Z'))).toBe('2026-10-16');
    // 01:30 at UTC+2 is still the previous UTC day.
    expect(utcUsageDate(new Date('2026-10-16T01:30:00+02:00'))).toBe('2026-10-15');
  });
});

describe('createTokenFactoryBudget', () => {
  it('counts recorded tokens per UTC day and allows turns below the cap', async () => {
    const store = await createStore();
    const budget = createTokenFactoryBudget({ store, cap: 1000, now: () => new Date('2026-10-15T09:00:00.000Z') });

    await budget.record(400);
    await budget.record(250);

    expect((await store.getUsage({ usage_date: '2026-10-15' }))?.used_tokens).toBe(650);
    await expect(budget.assertWithinCap()).resolves.toBeUndefined();
  });

  it('refuses with a typed 429 once the cap is reached, including exactly at the cap', async () => {
    const store = await createStore();
    const budget = createTokenFactoryBudget({ store, cap: 1000, now: () => new Date('2026-10-15T09:00:00.000Z') });
    await budget.record(1000);

    const refusal = await budget.assertWithinCap().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(TokenFactoryDailyCapError);
    if (!(refusal instanceof TokenFactoryDailyCapError)) {
      throw new Error('expected a TokenFactoryDailyCapError');
    }
    expect(refusal.status).toBe(429);
    expect(refusal.code).toBe(TOKEN_FACTORY_DAILY_CAP_CODE);
    expect(refusal.message).toContain('midnight UTC');
  });

  it('resets at the UTC day boundary', async () => {
    const store = await createStore();
    let current = new Date('2026-10-15T23:59:59.999Z');
    const budget = createTokenFactoryBudget({ store, cap: 500, now: () => current });
    await budget.record(500);
    await expect(budget.assertWithinCap()).rejects.toBeInstanceOf(TokenFactoryDailyCapError);

    current = new Date('2026-10-16T00:00:00.000Z');
    await expect(budget.assertWithinCap()).resolves.toBeUndefined();

    await budget.record(120);
    expect((await store.getUsage({ usage_date: '2026-10-16' }))?.used_tokens).toBe(120);
    expect((await store.getUsage({ usage_date: '2026-10-15' }))?.used_tokens).toBe(500);
  });

  it('keeps the count across a restart because it lives in the store', async () => {
    const store = await createStore();
    const now = () => new Date('2026-10-15T09:00:00.000Z');
    await createTokenFactoryBudget({ store, cap: 300, now }).record(300);

    await expect(createTokenFactoryBudget({ store, cap: 300, now }).assertWithinCap()).rejects.toBeInstanceOf(
      TokenFactoryDailyCapError,
    );
  });

  it('has no cap and no store traffic when the cap is unset', async () => {
    const store = await createStore();
    const getUsage = jest.spyOn(store, 'getUsage');
    const addUsage = jest.spyOn(store, 'addUsage');
    const budget = createTokenFactoryBudget({ store, cap: undefined });

    await budget.record(5_000_000_000);
    await expect(budget.assertWithinCap()).resolves.toBeUndefined();

    expect(getUsage).not.toHaveBeenCalled();
    expect(addUsage).not.toHaveBeenCalled();
  });

  it('ignores a zero or negative token count', async () => {
    const store = await createStore();
    const addUsage = jest.spyOn(store, 'addUsage');
    const budget = createTokenFactoryBudget({ store, cap: 100 });

    await budget.record(0);
    await budget.record(-5);

    expect(addUsage).not.toHaveBeenCalled();
  });
});

describe('TokenFactoryTurnMeter', () => {
  const now = () => new Date('2026-10-15T09:00:00.000Z');

  it('counts provider-reported input and output tokens of an admitted turn', async () => {
    const store = await createStore();
    const meter = new TokenFactoryTurnMeter(createTokenFactoryBudget({ store, cap: 10_000, now }));

    await meter.admit();
    await meter.observe(modelMessage({ input_tokens: 1200, output_tokens: 80 }));
    await meter.observe(modelMessage({ input_tokens: 1400, output_tokens: 20 }));

    expect((await store.getUsage({ usage_date: '2026-10-15' }))?.used_tokens).toBe(2700);
  });

  it('does not count a turn that was never admitted onto Token Factory', async () => {
    const store = await createStore();
    const meter = new TokenFactoryTurnMeter(createTokenFactoryBudget({ store, cap: 10_000, now }));

    await meter.observe(modelMessage({ input_tokens: 1200, output_tokens: 80 }));

    expect(await store.getUsage({ usage_date: '2026-10-15' })).toBeUndefined();
  });

  it('skips events that carry no usage', async () => {
    const store = await createStore();
    const addUsage = jest.spyOn(store, 'addUsage');
    const meter = new TokenFactoryTurnMeter(createTokenFactoryBudget({ store, cap: 10_000, now }));

    await meter.admit();
    await meter.observe(modelMessage(undefined));

    expect(addUsage).not.toHaveBeenCalled();
  });

  it('refuses admission when the cap is already reached', async () => {
    const store = await createStore();
    const budget = createTokenFactoryBudget({ store, cap: 100, now });
    await budget.record(100);
    const meter = new TokenFactoryTurnMeter(budget);

    await expect(meter.admit()).rejects.toBeInstanceOf(TokenFactoryDailyCapError);
    await meter.observe(modelMessage({ input_tokens: 10, output_tokens: 10 }));

    expect((await store.getUsage({ usage_date: '2026-10-15' }))?.used_tokens).toBe(100);
  });
});

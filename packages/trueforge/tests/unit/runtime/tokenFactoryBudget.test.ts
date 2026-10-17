import type {
  ExtendedChatCompletionChunk,
  ILLM,
  LLMCreateParams,
  LLMCreateParamsStreaming,
  RawAssistantMessageWithUsage,
} from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';

import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteTokenFactoryUsageStore } from '../../../src/db/sqlite/token-factory-usage-store/SqliteTokenFactoryUsageStore';
import {
  createTokenFactoryBudget,
  meterHelperLlm,
  TOKEN_FACTORY_DAILY_CAP_CODE,
  TokenFactoryDailyCapError,
  TokenFactoryMeteredLLM,
  tokenFactoryRole,
  utcUsageDate,
  type TokenFactoryBudget,
} from '../../../src/runtime/tokenFactoryBudget';

const SUPER = 'nvidia/nemotron-3-super-120b-a12b';
const NANO = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

/** One counted call of `tokens` input tokens on the Super model. */
function counted(tokens: number): { model_id: string; input_tokens: number; output_tokens: number } {
  return { model_id: SUPER, input_tokens: tokens, output_tokens: 0 };
}

async function createStore(): Promise<SqliteTokenFactoryUsageStore> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  return new SqliteTokenFactoryUsageStore(db);
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

    await budget.record(counted(400));
    await budget.record(counted(250));

    expect((await store.getUsage({ usage_date: '2026-10-15' }))?.used_tokens).toBe(650);
    await expect(budget.assertWithinCap()).resolves.toBeUndefined();
  });

  it('refuses with a typed 429 once the cap is reached, including exactly at the cap', async () => {
    const store = await createStore();
    const budget = createTokenFactoryBudget({ store, cap: 1000, now: () => new Date('2026-10-15T09:00:00.000Z') });
    await budget.record(counted(1000));

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
    await budget.record(counted(500));
    await expect(budget.assertWithinCap()).rejects.toBeInstanceOf(TokenFactoryDailyCapError);

    current = new Date('2026-10-16T00:00:00.000Z');
    await expect(budget.assertWithinCap()).resolves.toBeUndefined();

    await budget.record(counted(120));
    expect((await store.getUsage({ usage_date: '2026-10-16' }))?.used_tokens).toBe(120);
    expect((await store.getUsage({ usage_date: '2026-10-15' }))?.used_tokens).toBe(500);
  });

  it('keeps the count across a restart because it lives in the store', async () => {
    const store = await createStore();
    const now = () => new Date('2026-10-15T09:00:00.000Z');
    await createTokenFactoryBudget({ store, cap: 300, now }).record(counted(300));

    await expect(createTokenFactoryBudget({ store, cap: 300, now }).assertWithinCap()).rejects.toBeInstanceOf(
      TokenFactoryDailyCapError,
    );
  });

  it('never refuses without a cap, and still counts usage per model for the daily view', async () => {
    const store = await createStore();
    const getUsage = jest.spyOn(store, 'getUsage');
    const budget = createTokenFactoryBudget({ store, cap: undefined, now: TODAY });

    await budget.record({ model_id: SUPER, input_tokens: 4_000_000_000, output_tokens: 1_000_000_000 });
    await budget.record({ model_id: NANO, input_tokens: 90, output_tokens: 10 });
    await expect(budget.assertWithinCap()).resolves.toBeUndefined();

    expect(getUsage).not.toHaveBeenCalled();
    expect(await budget.today()).toEqual({
      usage_date: '2026-10-15',
      cap_tokens: undefined,
      used_tokens: 5_000_000_100,
      models: [
        {
          usage_date: '2026-10-15',
          model_id: SUPER,
          input_tokens: 4_000_000_000,
          output_tokens: 1_000_000_000,
          calls: 1,
        },
        { usage_date: '2026-10-15', model_id: NANO, input_tokens: 90, output_tokens: 10, calls: 1 },
      ],
    });
  });

  it("reports the cap and today's counters, and an empty day before any call", async () => {
    const store = await createStore();
    const budget = createTokenFactoryBudget({ store, cap: 1000, now: TODAY });

    expect(await budget.today()).toEqual({ usage_date: '2026-10-15', cap_tokens: 1000, used_tokens: 0, models: [] });

    await budget.record({ model_id: SUPER, input_tokens: 300, output_tokens: 50 });
    expect(await budget.today()).toMatchObject({ cap_tokens: 1000, used_tokens: 350 });
  });

  it('ignores a zero or negative token count', async () => {
    const store = await createStore();
    const addUsage = jest.spyOn(store, 'addUsage');
    const budget = createTokenFactoryBudget({ store, cap: 100 });

    await budget.record(counted(0));
    await budget.record({ model_id: SUPER, input_tokens: 0, output_tokens: 0 });

    expect(addUsage).not.toHaveBeenCalled();
  });
});

const TODAY = () => new Date('2026-10-15T09:00:00.000Z');
const USAGE_DATE = '2026-10-15';
const BODY: LLMCreateParamsStreaming = { messages: [{ role: 'user', content: 'hi' }], stream: true };
const silentLogger = createLogger({ silent: true });

function chunk(usage?: { input_tokens: number; output_tokens: number }): ExtendedChatCompletionChunk {
  return {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: {}, finish_reason: null, logprobs: null }],
    ...(usage === undefined ? {} : { usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens } }),
  };
}

const FINAL: RawAssistantMessageWithUsage = {
  output: { role: 'assistant', content: 'ok' },
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  finish_reason: 'stop',
};

/** An inner client that yields the given chunks, then either finishes or throws `failure`. */
function scriptedClient(options: { chunks: ExtendedChatCompletionChunk[]; failure?: Error }): ILLM & {
  closed: () => boolean;
} {
  let closed = false;
  async function* create(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
    try {
      for (const next of options.chunks) {
        yield next;
      }
      if (options.failure !== undefined) {
        throw options.failure;
      }
      return FINAL;
    } finally {
      closed = true;
    }
  }
  return {
    create,
    createNonStream: (_body: LLMCreateParams) => Promise.resolve(FINAL),
    closed: () => closed,
  };
}

async function usedToday(store: SqliteTokenFactoryUsageStore): Promise<number | undefined> {
  return (await store.getUsage({ usage_date: USAGE_DATE }))?.used_tokens;
}

async function drain(llm: ILLM): Promise<void> {
  const stream = llm.create(BODY);
  let step = await stream.next();
  while (!step.done) {
    step = await stream.next();
  }
}

describe('TokenFactoryBudget.isExhausted', () => {
  it('is never true without a cap and true from the cap onward', async () => {
    const store = await createStore();
    const uncapped = createTokenFactoryBudget({ store, cap: undefined, now: TODAY });
    await uncapped.record(counted(1_000_000));
    expect(await uncapped.isExhausted()).toBe(false);

    const capped = createTokenFactoryBudget({ store: await createStore(), cap: 500, now: TODAY });
    expect(await capped.isExhausted()).toBe(false);
    await capped.record(counted(500));
    expect(await capped.isExhausted()).toBe(true);
  });
});

describe('TokenFactoryMeteredLLM with Token Factory as the primary', () => {
  async function setup(cap: number) {
    const store = await createStore();
    const budget = createTokenFactoryBudget({ store, cap, now: TODAY });
    return { store, budget };
  }

  it('re-checks the cap before every model call, so a turn stops mid-way once the cap is reached', async () => {
    const { store, budget } = await setup(1000);
    const build = jest.fn(() => scriptedClient({ chunks: [chunk({ input_tokens: 900, output_tokens: 100 })] }));
    const llm = new TokenFactoryMeteredLLM({ role: 'primary', modelId: SUPER, budget, logger: silentLogger, build });

    await drain(llm);
    expect(await usedToday(store)).toBe(1000);

    const refusal = await drain(llm).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(TokenFactoryDailyCapError);
    if (!(refusal instanceof TokenFactoryDailyCapError)) {
      throw new Error('expected a TokenFactoryDailyCapError');
    }
    expect(refusal.code).toBe(TOKEN_FACTORY_DAILY_CAP_CODE);
    expect(refusal.message).toContain('midnight UTC');
    expect(build).toHaveBeenCalledTimes(1);
    expect(await usedToday(store)).toBe(1000);
  });

  it('applies the same check to the non-streaming calls compaction and helpers make', async () => {
    const { budget } = await setup(10);
    await budget.record(counted(10));
    const llm = new TokenFactoryMeteredLLM({
      role: 'primary',
      modelId: SUPER,
      budget,
      logger: silentLogger,
      build: () => scriptedClient({ chunks: [] }),
    });

    await expect(llm.createNonStream({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(
      TokenFactoryDailyCapError,
    );
  });

  it('counts the usage a stream reported even when it then fails', async () => {
    const { store, budget } = await setup(10_000);
    const llm = new TokenFactoryMeteredLLM({
      role: 'primary',
      modelId: SUPER,
      budget,
      logger: silentLogger,
      build: () =>
        scriptedClient({ chunks: [chunk({ input_tokens: 300, output_tokens: 40 })], failure: new Error('stream cut') }),
    });

    await expect(drain(llm)).rejects.toThrow('stream cut');

    expect(await usedToday(store)).toBe(340);
  });

  it('counts the usage a stream reported when the consumer abandons it, and closes the provider stream', async () => {
    const { store, budget } = await setup(10_000);
    const inner = scriptedClient({ chunks: [chunk(), chunk({ input_tokens: 70, output_tokens: 5 }), chunk()] });
    const llm = new TokenFactoryMeteredLLM({
      role: 'primary',
      modelId: SUPER,
      budget,
      logger: silentLogger,
      build: () => inner,
    });

    const stream = llm.create(BODY);
    await stream.next();
    await stream.next();
    await stream.return(FINAL);

    expect(await usedToday(store)).toBe(75);
    expect(inner.closed()).toBe(true);
  });

  it('does not count a call that failed over away from Token Factory', async () => {
    const { store, budget } = await setup(10_000);
    const llm = new TokenFactoryMeteredLLM({
      role: 'primary',
      modelId: SUPER,
      budget,
      logger: silentLogger,
      build: ({ onFailover }) => {
        onFailover();
        return scriptedClient({ chunks: [chunk({ input_tokens: 50, output_tokens: 50 })] });
      },
    });

    await drain(llm);

    expect(await usedToday(store)).toBeUndefined();
  });

  it('never fails a call because the count could not be stored', async () => {
    const { budget } = await setup(10_000);
    const failing: TokenFactoryBudget = {
      ...budget,
      record: () => Promise.reject(new Error('disk full')),
    };
    const warn = jest.spyOn(silentLogger, 'warn');
    const llm = new TokenFactoryMeteredLLM({
      role: 'primary',
      modelId: SUPER,
      budget: failing,
      logger: silentLogger,
      build: () => scriptedClient({ chunks: [chunk({ input_tokens: 5, output_tokens: 5 })] }),
    });

    await expect(drain(llm)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Token Factory usage could not be counted', expect.anything());
  });

  it('is unlimited without a cap and counts the call under the Token Factory model id', async () => {
    const store = await createStore();
    const llm = new TokenFactoryMeteredLLM({
      role: 'primary',
      modelId: NANO,
      budget: createTokenFactoryBudget({ store, cap: undefined, now: TODAY }),
      logger: silentLogger,
      build: () => scriptedClient({ chunks: [chunk({ input_tokens: 9_000_000, output_tokens: 1 })] }),
    });

    await drain(llm);

    expect(await store.listModelUsage({ usage_date: USAGE_DATE })).toEqual([
      { usage_date: USAGE_DATE, model_id: NANO, input_tokens: 9_000_000, output_tokens: 1, calls: 1 },
    ]);
  });
});

describe('TokenFactoryMeteredLLM with Token Factory as the fallback (TOKEN_FACTORY_MODE=fallback)', () => {
  it('counts only the calls Token Factory answered after the configured provider failed', async () => {
    const store = await createStore();
    const budget = createTokenFactoryBudget({ store, cap: 10_000, now: TODAY });
    let failOver = false;
    const llm = new TokenFactoryMeteredLLM({
      role: 'fallback',
      modelId: SUPER,
      budget,
      logger: silentLogger,
      build: ({ onFailover }) => {
        if (failOver) {
          onFailover();
        }
        return scriptedClient({ chunks: [chunk({ input_tokens: 200, output_tokens: 30 })] });
      },
    });

    await drain(llm);
    expect(await usedToday(store)).toBeUndefined();

    failOver = true;
    await drain(llm);
    await drain(llm);
    expect(await usedToday(store)).toBe(460);
  });

  it('leaves the Token Factory failover out of a call once the cap is reached', async () => {
    const store = await createStore();
    const budget = createTokenFactoryBudget({ store, cap: 100, now: TODAY });
    const build = jest.fn((_options: { withFailover: boolean; onFailover: () => void }) =>
      scriptedClient({ chunks: [chunk({ input_tokens: 80, output_tokens: 20 })] }),
    );
    const llm = new TokenFactoryMeteredLLM({ role: 'fallback', modelId: SUPER, budget, logger: silentLogger, build });

    await drain(llm);
    expect(build).toHaveBeenLastCalledWith(expect.objectContaining({ withFailover: true }));

    await budget.record(counted(100));
    await drain(llm);
    expect(build).toHaveBeenLastCalledWith(expect.objectContaining({ withFailover: false }));
  });
});

describe('meterHelperLlm', () => {
  const identity = (provider: string) => ({ model_name: `${provider}/nano`, model_id: NANO, provider });

  it('limits and counts a helper call on the tokenfactory provider, and records it under its role', async () => {
    const store = await createStore();
    const budget = createTokenFactoryBudget({ store, cap: 100, now: TODAY });
    const inner = scriptedClient({ chunks: [chunk({ input_tokens: 60, output_tokens: 40 })] });
    const record = jest.fn();
    const llm = meterHelperLlm({
      llm: inner,
      identity: identity('tokenfactory'),
      role: 'summarization',
      budget,
      usage: { record },
      logger: silentLogger,
    });

    await llm.createNonStream({ messages: [{ role: 'user', content: 'hi' }] });
    expect(await usedToday(store)).toBe(100);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'summarization', identity: identity('tokenfactory') }),
    );

    await expect(llm.createNonStream({ messages: [{ role: 'user', content: 'again' }] })).rejects.toBeInstanceOf(
      TokenFactoryDailyCapError,
    );
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('records but never limits or counts a helper call on any other provider', async () => {
    const store = await createStore();
    const budget = createTokenFactoryBudget({ store, cap: 1, now: TODAY });
    await budget.record(counted(1));
    const record = jest.fn();
    const llm = meterHelperLlm({
      llm: scriptedClient({ chunks: [chunk({ input_tokens: 60, output_tokens: 40 })] }),
      identity: identity('custom'),
      role: 'profile_learning',
      budget,
      usage: { record },
      logger: silentLogger,
    });

    await expect(llm.createNonStream({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBeDefined();

    expect(await usedToday(store)).toBe(1);
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe('tokenFactoryRole', () => {
  it('names the Token Factory side of the routing', () => {
    expect(tokenFactoryRole({ primaryType: 'tokenfactory', fallbackType: undefined })).toBe('primary');
    expect(tokenFactoryRole({ primaryType: 'tokenfactory', fallbackType: 'custom' })).toBe('primary');
    expect(tokenFactoryRole({ primaryType: 'custom', fallbackType: 'tokenfactory' })).toBe('fallback');
    expect(tokenFactoryRole({ primaryType: 'custom', fallbackType: undefined })).toBeUndefined();
  });
});

import type { ILLM } from '@truefoundry/trueforge-core/core';
import type { Server } from 'node:http';
import winston from 'winston';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { type IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteModelProviderStore } from '../../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteTokenFactoryUsageStore } from '../../../../src/db/sqlite/token-factory-usage-store/SqliteTokenFactoryUsageStore';
import {
  buildSummarizationMessages,
  lightReasoningRequestFields,
  parseSummaryReply,
  summarizeTurnContent,
} from '../../../../src/runtime/memory/memorySummarize';
import { createTokenFactoryBudget } from '../../../../src/runtime/tokenFactoryBudget';
import { ensureEnvManagedTokenFactoryProvider } from '../../../../src/runtime/tokenFactoryProvider';
import type { ModelProperties } from '../../../../src/schemas/modelProvider';
import { TENANT_ID } from '../../../../src/tenancy';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { startModelEndpointStub } from '../../../fixtures/modelEndpointStub';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

const TURN_DATE = '2026-10-26T09:00:00.000Z';

function makeLogger() {
  return winston.createLogger({ silent: true });
}

/**
 * A complete ILLM double for summarization tests: the summarizer only ever calls
 * `createNonStream`, and streaming refuses loudly so an unexpected call fails the test.
 */
function fakeSummarizer(content: string | { type: 'text'; text: string }[]): ILLM {
  const result: Awaited<ReturnType<ILLM['createNonStream']>> = {
    output: { role: 'assistant', content },
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    finish_reason: 'stop',
  };
  return {
    create(): ReturnType<ILLM['create']> {
      throw new Error('streaming is not used by memory summarization');
    },
    createNonStream: async () => result,
  };
}

/** An ILLM double whose summarization call fails with `error`. */
function fakeSummarizerThrowing(error: Error): ILLM {
  return {
    create(): ReturnType<ILLM['create']> {
      throw new Error('streaming is not used by memory summarization');
    },
    createNonStream: async () => {
      throw error;
    },
  };
}

function fakeModelProviderStore(): IModelProviderStore {
  return {
    listProviders: jest.fn(),
    getProvider: jest.fn(),
    getProviderForUpdate: jest.fn(),
    createProvider: jest.fn(),
    upsertProvider: jest.fn(),
    listModels: jest.fn(),
    deleteProvider: jest.fn(),
  };
}

describe('buildSummarizationMessages', () => {
  it('includes the full exchange for the model to summarize', () => {
    const messages = buildSummarizationMessages({
      userText: 'My robot is named Bleep-Bloop.',
      assistantText: 'Got it, Bleep-Bloop.',
      turnDate: TURN_DATE,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain('User: My robot is named Bleep-Bloop.');
    expect(messages[1]?.content).toContain('Assistant: Got it, Bleep-Bloop.');
  });

  it('tells the model that nothing is a valid answer, with an example of an empty result', () => {
    const system = buildSummarizationMessages({ userText: 'hi', assistantText: 'hello', turnDate: TURN_DATE })[0]
      ?.content;
    expect(system).toContain('{"facts": []}');
    expect(system).toContain('Most turns hold nothing worth keeping');
  });

  it('names what to keep and what never to keep', () => {
    const system = buildSummarizationMessages({ userText: 'hi', assistantText: 'hello', turnDate: TURN_DATE })[0]
      ?.content;
    expect(system).toContain('anything they ask you to remember');
    expect(system).toContain('anything the assistant said, asked, offered, or wrote');
    expect(system).toContain('open questions');
    expect(system).toContain('rules for how the assistant should act');
    expect(system).toContain('Never write "User" or "Assistant"');
  });

  it('gives the date of the chat in the time zone of the person', () => {
    const user = buildSummarizationMessages({
      userText: 'hi',
      assistantText: 'hello',
      turnDate: '2026-10-26T23:30:00.000Z',
      timeZone: 'Asia/Tokyo',
    })[1]?.content;
    expect(user).toContain('Date of the chat: 2026-10-27 (Tuesday)');
  });

  it('falls back to UTC for a time zone it does not know', () => {
    const user = buildSummarizationMessages({
      userText: 'hi',
      assistantText: 'hello',
      turnDate: TURN_DATE,
      timeZone: 'Not/AZone',
    })[1]?.content;
    expect(user).toContain('Date of the chat: 2026-10-26 (Monday)');
  });

  it('asks for the empty list exactly, and never for a sentence saying there is nothing', () => {
    const system = buildSummarizationMessages({ userText: 'hi', assistantText: 'hello', turnDate: TURN_DATE })[0]
      ?.content;
    expect(system).toContain('Always reply with one JSON object and nothing else');
    expect(system).toContain('Never write a sentence that says there is nothing to keep');
  });

  it('gives the date of the chat so relative dates can be written out', () => {
    const user = buildSummarizationMessages({ userText: 'hi', assistantText: 'hello', turnDate: TURN_DATE })[1]
      ?.content;
    expect(user).toContain('Date of the chat: 2026-10-26 (Monday)');
  });
});

describe('parseSummaryReply', () => {
  it('reads a facts object', () => {
    expect(parseSummaryReply('{"facts": ["The person has a dog named Rex.", "Harry has their book."]}')).toEqual({
      kind: 'facts',
      facts: ['The person has a dog named Rex.', 'Harry has their book.'],
    });
  });

  it.each([
    ['code fences', '```json\n{"facts": ["The person owns a bike."]}\n```'],
    ['a lead-in sentence', 'Here is the result: {"facts": ["The person owns a bike."]}'],
    ['a trailing comma', '{"facts": ["The person owns a bike.",]}'],
    ['bullet marks inside the facts', '{"facts": ["- The person owns a bike."]}'],
  ])('tolerates %s', (_name, reply) => {
    expect(parseSummaryReply(reply)).toEqual({ kind: 'facts', facts: ['The person owns a bike.'] });
  });

  it.each(['{"facts": []}', '```json\n{"facts": []}\n```', '{"facts":[]}'])('treats %j as nothing to keep', reply => {
    expect(parseSummaryReply(reply)).toEqual({ kind: 'nothing' });
  });

  it.each([
    '',
    '   ',
    'None',
    'No durable facts were shared in this exchange.',
    'Aucun fait durable.',
    'Keine dauerhaften Fakten.',
    'Turn summary: - No durable facts were shared in this exchange.',
    '(no content)',
    '["The person owns a bike."]',
  ])('never counts %j as nothing to keep or as a fact', reply => {
    expect(parseSummaryReply(reply)).toEqual({ kind: 'unreadable' });
  });

  it('drops a sentence in the list that says there are no facts', () => {
    expect(parseSummaryReply('{"facts": ["No durable facts."]}')).toEqual({ kind: 'nothing' });
    expect(parseSummaryReply('{"facts": ["No durable facts were shared.", "The person has a cat."]}')).toEqual({
      kind: 'facts',
      facts: ['The person has a cat.'],
    });
  });

  it('drops facts that start with a label older versions wrote', () => {
    expect(
      parseSummaryReply(
        '{"facts": ["Turn summary: The person has a cat.", "Chat title: Cats", "The person has a dog."]}',
      ),
    ).toEqual({ kind: 'facts', facts: ['The person has a dog.'] });
  });

  it('keeps a fact that merely starts with the word Assistant or User', () => {
    expect(parseSummaryReply('{"facts": ["Assistant professor Dana is the person\'s neighbor."]}')).toEqual({
      kind: 'facts',
      facts: ["Assistant professor Dana is the person's neighbor."],
    });
  });

  it('drops facts written as narration of the chat', () => {
    expect(
      parseSummaryReply(
        '{"facts": ["Assistant asked whether to file it today.", "User wants the assistant to ask one item at a time.", "The person has a cat."]}',
      ),
    ).toEqual({ kind: 'facts', facts: ['The person has a cat.'] });
  });

  it('keeps nothing when every fact is narration', () => {
    expect(parseSummaryReply('{"facts": ["Assistant drafted a note."]}')).toEqual({ kind: 'nothing' });
  });

  it('never stores prose or half a reply as a fact', () => {
    expect(parseSummaryReply('The person talked about a robot.')).toEqual({ kind: 'unreadable' });
    expect(parseSummaryReply('{"facts": ["The person owns')).toEqual({ kind: 'unreadable' });
    expect(parseSummaryReply('{"facts": "The person owns a bike."}')).toEqual({ kind: 'unreadable' });
  });

  it('keeps at most eight facts', () => {
    const facts = Array.from({ length: 12 }, (_, index) => `The person owns item number ${String(index)}.`);
    const parsed = parseSummaryReply(JSON.stringify({ facts }));
    expect(parsed.kind === 'facts' ? parsed.facts : []).toHaveLength(8);
  });
});

describe('lightReasoningRequestFields', () => {
  it('asks for no reasoning when the model lists it', () => {
    expect(lightReasoningRequestFields({ reasoning_efforts: ['none', 'low', 'high'] })).toEqual({
      enable_thinking: false,
      reasoning_effort: 'none',
    });
  });

  it('asks for the lightest effort the model lists', () => {
    expect(lightReasoningRequestFields({ reasoning_efforts: ['high', 'low', 'medium'] })).toEqual({
      reasoning_effort: 'low',
    });
    expect(lightReasoningRequestFields({ reasoning_efforts: ['minimal', 'low'] })).toEqual({
      reasoning_effort: 'minimal',
    });
  });

  it('asks for nothing when the model lists no light effort or no efforts', () => {
    expect(lightReasoningRequestFields({ reasoning_efforts: ['high', 'max'] })).toEqual({});
    expect(lightReasoningRequestFields({})).toEqual({});
  });
});

describe('summarizeTurnContent', () => {
  const base = {
    userText: 'Please remember that my synthetic test robot is named Bleep-Bloop.',
    assistantText: 'Got it — Bleep-Bloop is your synthetic test robot.',
    turnDate: TURN_DATE,
    tenantId: 'tenant-1',
    modelProviderStore: fakeModelProviderStore(),
    summarizationModelFqn: 'openai/gpt-4o',
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    modelUsage: discardedModelUsage,
    logger: makeLogger(),
  };

  it('returns a summarized result on success', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => fakeSummarizer('{"facts": ["The person has a synthetic test robot named Bleep-Bloop."]}'),
    });
    expect(result).toEqual({
      status: 'summarized',
      facts: ['The person has a synthetic test robot named Bleep-Bloop.'],
    });
  });

  it('returns skipped/empty-exchange when both sides are empty (nothing to summarize)', async () => {
    const result = await summarizeTurnContent({
      ...base,
      userText: '   ',
      assistantText: '',
      resolveLlm: async () => {
        throw new Error('must not be called');
      },
    });
    expect(result).toEqual({ status: 'skipped', reason: 'empty-exchange' });
  });

  it('returns skipped/no-model-configured when no model FQN is available', async () => {
    const result = await summarizeTurnContent({
      ...base,
      summarizationModelFqn: undefined,
      resolveLlm: async () => {
        throw new Error('must not be called');
      },
    });
    expect(result).toEqual({ status: 'skipped', reason: 'no-model-configured' });
  });

  it('returns failed and never throws when the LLM call fails', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => {
        throw new Error('provider down');
      },
    });
    expect(result).toEqual({ status: 'failed', reason: 'provider down', fallback: 'model_unresolved' });
  });

  it('returns nothing_to_keep only for the empty list', async () => {
    const result = await summarizeTurnContent({ ...base, resolveLlm: async () => fakeSummarizer('{"facts": []}') });
    expect(result).toEqual({ status: 'nothing_to_keep' });
  });

  it.each(['No durable facts were shared in this exchange.', 'Aucun fait durable.', '(no content)'])(
    'fails, rather than calling it nothing to keep, when the model writes %j',
    async reply => {
      const result = await summarizeTurnContent({ ...base, resolveLlm: async () => fakeSummarizer(reply) });
      expect(result).toEqual({ status: 'failed', reason: 'summary-unreadable', fallback: 'summary_unreadable' });
    },
  );

  it('fails, so the vault is marked, when the model finishes with no text at all', async () => {
    const result = await summarizeTurnContent({ ...base, resolveLlm: async () => fakeSummarizer('   ') });
    expect(result).toEqual({ status: 'failed', reason: 'summary-empty', fallback: 'summary_empty' });
  });

  it('returns failed, and keeps no text, when the reply is not the expected shape', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => fakeSummarizer('The person talked about a robot and a dog.'),
    });
    expect(result).toEqual({ status: 'failed', reason: 'summary-unreadable', fallback: 'summary_unreadable' });
  });

  it('returns failed with model_timeout when the summarizer call times out', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => fakeSummarizerThrowing(new Error('The request timed out after 30000 ms')),
    });
    expect(result).toEqual({
      status: 'failed',
      reason: 'The request timed out after 30000 ms',
      fallback: 'model_timeout',
    });
  });

  it('returns failed with model_failed when the summarizer call errors', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => fakeSummarizerThrowing(new Error('upstream 500')),
    });
    expect(result).toEqual({ status: 'failed', reason: 'upstream 500', fallback: 'model_failed' });
  });

  it('returns failed for an overlong summary instead of truncating', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => fakeSummarizer('x'.repeat(5000)),
    });
    expect(result).toEqual({ status: 'failed', reason: 'summary-too-long', fallback: 'summary_too_long' });
  });

  it('summarizes the most recent part of an overlong turn, and says earlier text was left out', async () => {
    const llm = fakeSummarizer('{"facts": ["The person has a cat named Miso."]}');
    const createNonStream = jest.spyOn(llm, 'createNonStream');
    const result = await summarizeTurnContent({
      ...base,
      userText: `${'filler '.repeat(3000)}Please remember that my cat is named Miso.`,
      resolveLlm: async () => llm,
    });
    expect(result.status).toBe('summarized');
    const sent = JSON.stringify(createNonStream.mock.calls[0]?.[0]?.messages);
    expect(sent).toContain('my cat is named Miso.');
    expect(sent).toContain('Earlier text of this long turn was left out.');
    expect(sent.length).toBeLessThan(20000);
  });

  it('caps the generation with max_tokens so output cost is bounded', async () => {
    const llm = fakeSummarizer('{"facts": ["The person has a synthetic test robot named Bleep-Bloop."]}');
    const createNonStream = jest.spyOn(llm, 'createNonStream');
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => llm,
    });
    expect(result.status).toBe('summarized');
    expect(createNonStream).toHaveBeenCalledTimes(1);
    expect(createNonStream.mock.calls[0]?.[0]?.max_tokens).toBe(800);
  });

  /** A reasoning model: it thinks until the cap when the cap is below `thinkingTokens`, and then has no text. */
  function fakeReasoningSummarizer(options: { thinkingTokens: number; answer: string }): {
    llm: ILLM;
    caps: (number | null | undefined)[];
  } {
    const caps: (number | null | undefined)[] = [];
    const llm: ILLM = {
      create(): ReturnType<ILLM['create']> {
        throw new Error('streaming is not used by memory summarization');
      },
      createNonStream: async body => {
        const cap = body.max_tokens;
        caps.push(cap);
        const cutOff = (cap ?? 0) < options.thinkingTokens;
        return {
          output: { role: 'assistant', content: cutOff ? '' : options.answer },
          usage: { input_tokens: 0, output_tokens: cutOff ? (cap ?? 0) : options.thinkingTokens, total_tokens: 0 },
          finish_reason: cutOff ? 'length' : 'stop',
        };
      },
    };
    return { llm, caps };
  }

  it('retries once with more room when thinking used up the cap and left no answer', async () => {
    const { llm, caps } = fakeReasoningSummarizer({
      thinkingTokens: 2000,
      answer: '{"facts": ["The person has a dog named Rex."]}',
    });
    const result = await summarizeTurnContent({ ...base, resolveLlm: async () => llm });
    expect(result).toEqual({ status: 'summarized', facts: ['The person has a dog named Rex.'] });
    expect(caps).toEqual([800, 4000]);
  });

  it('fails, and stores no text, when the model is still cut off after the retry', async () => {
    const { llm, caps } = fakeReasoningSummarizer({ thinkingTokens: 100_000, answer: '{"facts": []}' });
    const result = await summarizeTurnContent({ ...base, resolveLlm: async () => llm });
    expect(result).toEqual({ status: 'failed', reason: 'summary-cut-short', fallback: 'summary_cut_short' });
    expect(caps).toEqual([800, 4000]);
  });

  it('retries a cut-off half answer, and does not retry a finished empty one', async () => {
    const cutOff = fakeSummarizer('{"facts": ["The person ow');
    jest.spyOn(cutOff, 'createNonStream').mockResolvedValueOnce({
      output: { role: 'assistant', content: '{"facts": ["The person ow' },
      usage: { input_tokens: 0, output_tokens: 800, total_tokens: 800 },
      finish_reason: 'length',
    });
    const retried = await summarizeTurnContent({ ...base, resolveLlm: async () => cutOff });
    expect(retried.status).toBe('failed');
    expect(cutOff.createNonStream).toHaveBeenCalledTimes(2);

    const finished = fakeSummarizer('');
    jest.spyOn(finished, 'createNonStream');
    await summarizeTurnContent({ ...base, resolveLlm: async () => finished });
    expect(finished.createNonStream).toHaveBeenCalledTimes(1);
  });

  it('flattens multi-part content responses', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () =>
        fakeSummarizer([
          { type: 'text', text: '{"facts": ["The person' },
          { type: 'text', text: ' owns a robot."]}' },
        ]),
    });
    expect(result).toEqual({ status: 'summarized', facts: ['The person owns a robot.'] });
  });

  it('never holds more than the bounded number of concurrent LLM calls', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const blockingLlm = (): ILLM => ({
      create(): ReturnType<ILLM['create']> {
        throw new Error('streaming is not used by memory summarization');
      },
      createNonStream: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 25));
        inFlight -= 1;
        const result: Awaited<ReturnType<ILLM['createNonStream']>> = {
          output: { role: 'assistant', content: 'summary' },
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          finish_reason: 'stop',
        };
        return result;
      },
    });
    await Promise.all(
      Array.from({ length: 6 }, () => summarizeTurnContent({ ...base, resolveLlm: async () => blockingLlm() })),
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(0);
  });
});

describe('summarizeTurnContent on Token Factory', () => {
  const NOW = new Date('2026-10-15T09:00:00.000Z');
  const TODAY = '2026-10-15';
  const CAP = 1000;
  const servers: Server[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  async function setup(providerType: 'tokenfactory' | 'custom') {
    const stub = await startModelEndpointStub({
      usage: { prompt_tokens: 150, completion_tokens: 25 },
      content: '{"facts": ["The person has a synthetic test robot named Bleep-Bloop."]}',
    });
    servers.push(stub.server);
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const modelProviderStore = new SqliteModelProviderStore(db);
    if (providerType === 'tokenfactory') {
      await ensureEnvManagedTokenFactoryProvider({
        store: modelProviderStore,
        tenant_id: TENANT_ID,
        settings: {
          apiKey: 'sk-nebius',
          baseUrl: stub.baseUrl,
          model: 'nvidia/nemotron-3-super-120b-a12b',
          cheaperModel: undefined,
        },
        logger: makeLogger(),
      });
    } else {
      await modelProviderStore.upsertProvider({
        tenant_id: TENANT_ID,
        name: 'local-vllm',
        manifest: {
          type: 'custom',
          name: 'local-vllm',
          base_url: stub.baseUrl,
          models: [{ model_id: 'local-model', name: 'local-model', properties: {} }],
        },
      });
    }
    const usageStore = new SqliteTokenFactoryUsageStore(db);
    const tokenFactoryBudget = createTokenFactoryBudget({ store: usageStore, cap: CAP, now: () => NOW });
    const summarizationModelFqn =
      providerType === 'tokenfactory' ? 'tokenfactory/nemotron-3-super-120b-a12b' : 'local-vllm/local-model';
    const run = () =>
      summarizeTurnContent({
        userText: 'My robot is named Bleep-Bloop.',
        assistantText: 'Got it.',
        turnDate: TURN_DATE,
        tenantId: TENANT_ID,
        modelProviderStore,
        summarizationModelFqn,
        tokenFactoryBudget,
        modelUsage: discardedModelUsage,
        logger: makeLogger(),
      });
    return { run, usageStore };
  }

  it('counts the tokens its call reports', async () => {
    const { run, usageStore } = await setup('tokenfactory');

    expect((await run()).status).toBe('summarized');

    expect((await usageStore.getUsage({ usage_date: TODAY }))?.used_tokens).toBe(175);
  });

  it('fails without a call once the cap is reached', async () => {
    const { run, usageStore } = await setup('tokenfactory');
    await usageStore.addUsage({
      usage_date: TODAY,
      model_id: 'nvidia/nemotron-3-super-120b-a12b',
      input_tokens: CAP,
      output_tokens: 0,
    });

    expect((await run()).status).toBe('failed');

    expect((await usageStore.getUsage({ usage_date: TODAY }))?.used_tokens).toBe(CAP);
  });

  it('counts nothing on another provider', async () => {
    const { run, usageStore } = await setup('custom');

    expect((await run()).status).toBe('summarized');

    expect(await usageStore.getUsage({ usage_date: TODAY })).toBeUndefined();
  });
});

describe('summarizeTurnContent reasoning fields on the real call', () => {
  const FACTS = '{"facts": ["The person has a synthetic test robot named Bleep-Bloop."]}';
  const servers: Server[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  async function setup(options: {
    efforts: ModelProperties['reasoning_efforts'];
    refuse?: (body: Record<string, unknown>) => number | undefined;
  }) {
    const stub = await startModelEndpointStub({ content: FACTS, refuse: options.refuse });
    servers.push(stub.server);
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const modelProviderStore = new SqliteModelProviderStore(db);
    await modelProviderStore.upsertProvider({
      tenant_id: TENANT_ID,
      name: 'local-vllm',
      manifest: {
        type: 'custom',
        name: 'local-vllm',
        base_url: stub.baseUrl,
        models: [
          {
            model_id: 'local-model',
            name: 'local-model',
            properties: options.efforts === undefined ? {} : { reasoning_efforts: options.efforts },
          },
        ],
      },
    });
    const run = () =>
      summarizeTurnContent({
        userText: 'My robot is named Bleep-Bloop.',
        assistantText: 'Got it.',
        turnDate: TURN_DATE,
        tenantId: TENANT_ID,
        modelProviderStore,
        summarizationModelFqn: 'local-vllm/local-model',
        tokenFactoryBudget: uncappedTokenFactoryBudget,
        modelUsage: discardedModelUsage,
        logger: makeLogger(),
      });
    return { run, requests: stub.requests };
  }

  it('sends the lightest reasoning effort the model lists', async () => {
    const { run, requests } = await setup({ efforts: ['high', 'low'] });

    expect((await run()).status).toBe('summarized');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.['reasoning_effort']).toBe('low');
  });

  it('sends no reasoning field to a model that lists none', async () => {
    const { run, requests } = await setup({ efforts: undefined });

    expect((await run()).status).toBe('summarized');

    expect(requests[0]).not.toHaveProperty('reasoning_effort');
  });

  it('asks again without the field when the provider refuses it', async () => {
    const { run, requests } = await setup({
      efforts: ['low'],
      refuse: body => ('reasoning_effort' in body ? 400 : undefined),
    });

    expect((await run()).status).toBe('summarized');

    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty('reasoning_effort');
    expect(requests[1]).not.toHaveProperty('reasoning_effort');
  });
});

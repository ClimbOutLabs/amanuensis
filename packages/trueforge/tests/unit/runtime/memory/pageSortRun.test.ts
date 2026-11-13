import type { ILLM } from '@truefoundry/trueforge-core/core';
import winston from 'winston';

import type { IModelProviderStore } from '../../../../src/db/modelProviderStore';
import type { SummarizeTurnContext } from '../../../../src/runtime/memory/memoryRetain';
import { summaryModelForSorting } from '../../../../src/runtime/memory/pageSortRun';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { inMemoryGlobalSettingsStore } from '../../../fixtures/inMemoryGlobalSettingsStore';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

const logger = winston.createLogger({ silent: true });
const MESSAGES = [
  { role: 'system' as const, content: 'sort' },
  { role: 'user' as const, content: 'note' },
];
const GOOD = JSON.stringify({ decisions: [{ decision: 'ignore', reason: 'Nothing.' }] });

function llmReturning(steps: { content: string; finish: 'stop' | 'length' }[]): {
  llm: ILLM;
  caps: (number | undefined)[];
} {
  const caps: (number | undefined)[] = [];
  const llm: ILLM = {
    create(): ReturnType<ILLM['create']> {
      throw new Error('streaming is not used');
    },
    createNonStream: async body => {
      caps.push(body.max_tokens ?? undefined);
      const step = steps[Math.min(caps.length - 1, steps.length - 1)];
      return {
        output: { role: 'assistant', content: step?.content ?? '' },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        finish_reason: step?.finish ?? 'stop',
      };
    },
  };
  return { llm, caps };
}

function context(overrides: Partial<SummarizeTurnContext>): SummarizeTurnContext {
  const store: IModelProviderStore = {
    listProviders: jest.fn(),
    getProvider: jest.fn(),
    getProviderForUpdate: jest.fn(),
    createProvider: jest.fn(),
    upsertProvider: jest.fn(),
    listModels: jest.fn(),
    deleteProvider: jest.fn(),
    managedElsewhere: false,
  };
  return {
    tenantId: 't',
    modelProviderStore: store,
    summarizationModelFqn: 'test/model',
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    modelUsage: discardedModelUsage,
    globalSettingsStore: inMemoryGlobalSettingsStore(),
    ...overrides,
  };
}

describe('the model the sorter asks', () => {
  it('is the summarizer’s model: none is asked when no model is configured', () => {
    expect(summaryModelForSorting({ summarize: context({ summarizationModelFqn: ' ' }), logger })).toBeUndefined();
    expect(
      summaryModelForSorting({ summarize: context({ summarizationModelFqn: undefined }), logger }),
    ).toBeUndefined();
  });

  it('hands back the reply text', async () => {
    const { llm } = llmReturning([{ content: GOOD, finish: 'stop' }]);
    const ask = summaryModelForSorting({ summarize: context({ resolveLlm: () => Promise.resolve(llm) }), logger });
    expect(await ask?.(MESSAGES)).toEqual({ ok: true, reply: GOOD });
  });

  it('asks again with more room when the first reply was cut off before it held an answer', async () => {
    const { llm, caps } = llmReturning([
      { content: '{"decisions": [', finish: 'length' },
      { content: GOOD, finish: 'stop' },
    ]);
    const ask = summaryModelForSorting({ summarize: context({ resolveLlm: () => Promise.resolve(llm) }), logger });
    expect(await ask?.(MESSAGES)).toEqual({ ok: true, reply: GOOD });
    expect(caps).toHaveLength(2);
    expect(caps[1]).toBeGreaterThan(caps[0] ?? 0);
  });

  it('says why when the model cannot be reached', async () => {
    const ask = summaryModelForSorting({
      summarize: context({ resolveLlm: () => Promise.reject(new Error('no such model')) }),
      logger,
    });
    expect(await ask?.(MESSAGES)).toEqual({ ok: false, reason: 'no such model' });
  });

  it('says the model was slow when it took too long, after one more try', async () => {
    const { llm } = llmReturning([]);
    let tries = 0;
    const slow = {
      ...llm,
      createNonStream: () => {
        tries += 1;
        return Promise.reject(new Error('The operation was aborted due to timeout'));
      },
    };
    const ask = summaryModelForSorting({ summarize: context({ resolveLlm: () => Promise.resolve(slow) }), logger });
    expect(await ask?.(MESSAGES)).toEqual({
      ok: false,
      reason: 'The operation was aborted due to timeout',
      cause: 'model_slow',
    });
    expect(tries).toBe(2);
  });

  it('says why when the reply is empty', async () => {
    const { llm } = llmReturning([{ content: '  ', finish: 'stop' }]);
    const ask = summaryModelForSorting({ summarize: context({ resolveLlm: () => Promise.resolve(llm) }), logger });
    expect(await ask?.(MESSAGES)).toEqual({ ok: false, reason: 'the reply was empty', cause: 'reply_empty' });
  });
});

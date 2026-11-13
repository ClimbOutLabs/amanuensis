/** The wait the person chose in Settings is the time limit the model client is built with. */
import type { ILLM } from '@truefoundry/trueforge-core/core';
import winston from 'winston';

import type { IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { summaryLlmResolver } from '../../../../src/runtime/memory/memorySummarize';
import { summaryModelForSorting } from '../../../../src/runtime/memory/pageSortRun';
import { MEMORY_HELPER_WAIT_SETTING_KEY } from '../../../../src/runtime/memoryHelperWaitSettings';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { inMemoryGlobalSettingsStore } from '../../../fixtures/inMemoryGlobalSettingsStore';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

jest.mock('../../../../src/runtime/memory/memorySummarize', () => ({
  ...jest.requireActual<typeof import('../../../../src/runtime/memory/memorySummarize')>(
    '../../../../src/runtime/memory/memorySummarize',
  ),
  summaryLlmResolver: jest.fn(),
}));

const logger = winston.createLogger({ silent: true });
const GOOD = JSON.stringify({ decisions: [{ decision: 'ignore', reason: 'Nothing.' }] });

const llm: ILLM = {
  create(): ReturnType<ILLM['create']> {
    throw new Error('streaming is not used');
  },
  createNonStream: () =>
    Promise.resolve({
      output: { role: 'assistant', content: GOOD },
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      finish_reason: 'stop',
    }),
};

const modelProviderStore: IModelProviderStore = {
  listProviders: jest.fn(),
  getProvider: jest.fn(),
  getProviderForUpdate: jest.fn(),
  createProvider: jest.fn(),
  upsertProvider: jest.fn(),
  listModels: jest.fn(),
  deleteProvider: jest.fn(),
  managedElsewhere: false,
};

describe('how long a sorting question waits for the model', () => {
  const resolver = jest.mocked(summaryLlmResolver);

  beforeEach(() => {
    resolver.mockReset();
    resolver.mockReturnValue(() => Promise.resolve(llm));
  });

  async function askWith(globalSettingsStore: ReturnType<typeof inMemoryGlobalSettingsStore>) {
    const ask = summaryModelForSorting({
      summarize: {
        tenantId: 't',
        modelProviderStore,
        summarizationModelFqn: 'test/model',
        tokenFactoryBudget: uncappedTokenFactoryBudget,
        modelUsage: discardedModelUsage,
        globalSettingsStore,
      },
      logger,
    });
    return ask?.([{ role: 'user', content: 'note' }]);
  }

  it('is ten minutes until the person chooses', async () => {
    expect(await askWith(inMemoryGlobalSettingsStore())).toEqual({ ok: true, reply: GOOD });
    expect(resolver).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 10 * 60_000 }));
  });

  it('follows the choice at the next question, with no restart', async () => {
    const settings = inMemoryGlobalSettingsStore({ [MEMORY_HELPER_WAIT_SETTING_KEY]: '20' });

    await askWith(settings);
    expect(resolver).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 20 * 60_000 }));

    await settings.setSetting({ key: MEMORY_HELPER_WAIT_SETTING_KEY, value: '3' });
    await askWith(settings);
    expect(resolver).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 3 * 60_000 }));
  });
});

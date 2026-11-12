/** The nightly timer reads the Settings every time it looks at the clock, so a change needs no restart. */
import configuration from '../../../../src/config';
import { runNightlyJob } from '../../../../src/runtime/memory/nightlyJob';
import { startNightlyMemoryJob } from '../../../../src/runtime/memory/nightlyService';
import { MEMORY_NIGHTLY_SETTING_KEY } from '../../../../src/runtime/memoryNightlySettings';
import { MEMORY_PAGE_SORTING_SETTING_KEY } from '../../../../src/runtime/memoryPageSortingSettings';
import { inMemoryGlobalSettingsStore } from '../../../fixtures/inMemoryGlobalSettingsStore';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';
import { silentLogger } from './nightlyTestKit';

jest.mock('../../../../src/runtime/memory/nightlyJob', () => ({
  ...jest.requireActual<typeof import('../../../../src/runtime/memory/nightlyJob')>(
    '../../../../src/runtime/memory/nightlyJob',
  ),
  runNightlyJob: jest.fn(),
}));

const LOOK = 10 * 60 * 1000;

const personaStore = {
  listPersonaOwners: () => Promise.resolve([]),
  listPersonas: () => Promise.resolve([]),
};

describe('the nightly timer', () => {
  const originalJob = configuration.MEMORY_NIGHTLY_JOB;
  const originalSorting = configuration.MEMORY_PAGE_SORTING;
  const run = jest.mocked(runNightlyJob);

  beforeEach(() => {
    configuration.MEMORY_NIGHTLY_JOB = false;
    configuration.MEMORY_PAGE_SORTING = 'off';
    jest.useFakeTimers({ now: new Date(2026, 10, 11, 3, 0, 0) });
    run.mockReset();
    run.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    configuration.MEMORY_NIGHTLY_JOB = originalJob;
    configuration.MEMORY_PAGE_SORTING = originalSorting;
  });

  function start(settings: ReturnType<typeof inMemoryGlobalSettingsStore>): void {
    startNightlyMemoryJob({
      personaStore,
      modelProviderStore: {
        listProviders: jest.fn(),
        getProvider: jest.fn(),
        getProviderForUpdate: jest.fn(),
        createProvider: jest.fn(),
        upsertProvider: jest.fn(),
        listModels: jest.fn(),
        deleteProvider: jest.fn(),
      },
      globalSettingsStore: settings,
      tokenFactoryBudget: uncappedTokenFactoryBudget,
      logger: silentLogger,
    });
  }

  it('does nothing while nothing is stored and the default is off', async () => {
    start(inMemoryGlobalSettingsStore());
    await jest.advanceTimersByTimeAsync(LOOK * 3);
    expect(run).not.toHaveBeenCalled();
  });

  it('starts working once the person turns it on, without a restart, and follows the sorting setting', async () => {
    const settings = inMemoryGlobalSettingsStore();
    start(settings);
    await jest.advanceTimersByTimeAsync(LOOK);
    expect(run).not.toHaveBeenCalled();

    await settings.setSetting({ key: MEMORY_NIGHTLY_SETTING_KEY, value: 'true' });
    await jest.advanceTimersByTimeAsync(LOOK);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ mode: 'off' });

    await settings.setSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY, value: 'on' });
    await jest.advanceTimersByTimeAsync(LOOK);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toMatchObject({ mode: 'on' });

    await settings.setSetting({ key: MEMORY_NIGHTLY_SETTING_KEY, value: 'false' });
    await jest.advanceTimersByTimeAsync(LOOK);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

/** The nightly timer reads the Settings every time it looks at the clock, so a change needs no restart. */
import configuration from '../../../../src/config';
import { runNightlyJob } from '../../../../src/runtime/memory/nightlyJob';
import { startNightlyMemoryJob } from '../../../../src/runtime/memory/nightlyService';
import {
  MEMORY_NIGHTLY_HOUR_SETTING_KEY,
  MEMORY_NIGHTLY_SETTING_KEY,
} from '../../../../src/runtime/memoryNightlySettings';
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
    jest.useFakeTimers({ now: new Date(2026, 10, 11, 1, 0, 0) });
    run.mockReset();
    run.mockResolvedValue({
      movedToEarlier: 2,
      notesAsked: 0,
      notesSorted: 1,
      pagesAsked: 0,
      pairsListed: 0,
      vaultsWithoutModel: 0,
      unsortedReasons: [],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    configuration.MEMORY_NIGHTLY_JOB = originalJob;
    configuration.MEMORY_PAGE_SORTING = originalSorting;
  });

  function start(settings: ReturnType<typeof inMemoryGlobalSettingsStore>, listed: string[] = []) {
    return startNightlyMemoryJob({
      personaStore,
      modelProviderStore: {
        listProviders: jest.fn(),
        getProvider: jest.fn(),
        getProviderForUpdate: jest.fn(),
        createProvider: jest.fn(),
        upsertProvider: jest.fn(),
        listModels: jest.fn(() =>
          Promise.resolve(listed.map(name => ({ name, model_id: name, provider: { name: 'test' }, properties: {} }))),
        ),
        deleteProvider: jest.fn(),
        recordProviderCheck: jest.fn(),
        managedElsewhere: false,
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
    expect(run.mock.calls[0]?.[0]).toMatchObject({ deps: { mode: 'off', hour: 0 } });

    await settings.setSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY, value: 'on' });
    await jest.advanceTimersByTimeAsync(LOOK);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toMatchObject({ deps: { mode: 'on' } });

    await settings.setSetting({ key: MEMORY_NIGHTLY_SETTING_KEY, value: 'false' });
    await jest.advanceTimersByTimeAsync(LOOK);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('asks the helper model chosen in Settings, and the chat model when that one is gone', async () => {
    const settings = inMemoryGlobalSettingsStore();
    await settings.setSetting({ key: MEMORY_NIGHTLY_SETTING_KEY, value: 'true' });
    await settings.setSetting({ key: 'memory_summarize_enabled', value: 'true' });
    await settings.setSetting({ key: 'memory_helper_model', value: 'local/small' });
    start(settings, ['openai/main', 'local/small']);
    await jest.advanceTimersByTimeAsync(LOOK);
    const summarizeFor = run.mock.calls[0]?.[0].deps.summarizeFor;
    const vault = { namespace: 'default' };

    expect((await summarizeFor?.(vault))?.summarizationModelFqn).toBe('local/small');

    await settings.setSetting({ key: 'memory_helper_model', value: 'local/gone' });
    expect((await summarizeFor?.(vault))?.summarizationModelFqn).toBe('openai/main');
  });

  it('waits for the hour the person chose', async () => {
    const settings = inMemoryGlobalSettingsStore();
    await settings.setSetting({ key: MEMORY_NIGHTLY_SETTING_KEY, value: 'true' });
    await settings.setSetting({ key: MEMORY_NIGHTLY_HOUR_SETTING_KEY, value: '2' });
    start(settings);
    await jest.advanceTimersByTimeAsync(LOOK * 3);
    expect(run).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(run).toHaveBeenCalled();
    expect(run.mock.calls[0]?.[0]).toMatchObject({ deps: { hour: 2 } });
  });

  const QUIET_COUNTS = {
    movedToEarlier: 0,
    notesAsked: 0,
    notesSorted: 0,
    pagesAsked: 0,
    pairsListed: 0,
    vaultsWithoutModel: 0,
    unsortedReasons: [],
  };

  it('tidies now when asked, at any hour and with the daily tidy-up off', async () => {
    jest.setSystemTime(new Date(2026, 10, 11, 14, 0, 0));
    const job = start(inMemoryGlobalSettingsStore());

    job.tidyNow();
    await jest.advanceTimersByTimeAsync(0);

    expect(job.tidyState()).toEqual({
      status: 'ran',
      counts: { ...QUIET_COUNTS, movedToEarlier: 2, notesSorted: 1 },
      sorting: 'off',
    });
    expect(run.mock.calls[0]?.[0]).toMatchObject({ onRequest: true });
  });

  it('answers at once and goes on tidying, and starts no second tidy-up meanwhile', async () => {
    let finish: (() => void) | undefined;
    run.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = () => resolve(QUIET_COUNTS);
        }),
    );
    const job = start(inMemoryGlobalSettingsStore());
    job.tidyNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(job.tidyState()).toEqual({ status: 'busy' });

    job.tidyNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(job.tidyState()).toEqual({ status: 'busy' });

    finish?.();
    await jest.advanceTimersByTimeAsync(0);
    expect(job.tidyState()).toMatchObject({ status: 'ran' });
  });

  it('gives a page that asked during the daily tidy-up the outcome of that run', async () => {
    let finish: (() => void) | undefined;
    const settings = inMemoryGlobalSettingsStore();
    await settings.setSetting({ key: MEMORY_NIGHTLY_SETTING_KEY, value: 'true' });
    const job = start(settings);
    job.tidyNow();
    await jest.advanceTimersByTimeAsync(0);
    const earlier = job.tidyState();
    expect(earlier).toMatchObject({ status: 'ran' });

    run.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ ...QUIET_COUNTS, pairsListed: 4 });
        }),
    );
    await jest.advanceTimersByTimeAsync(LOOK);
    expect(job.tidyState()).toEqual({ status: 'busy' });

    job.tidyNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    finish?.();
    await jest.advanceTimersByTimeAsync(0);

    expect(job.tidyState()).toEqual({
      status: 'ran',
      counts: { ...QUIET_COUNTS, pairsListed: 4 },
      sorting: 'off',
    });
  });

  it('still tidies when asked while a daily look with nothing to do was reading its settings', async () => {
    const stored = inMemoryGlobalSettingsStore();
    let release: (() => void) | undefined;
    let hold = false;
    const settings: typeof stored = {
      ...stored,
      getSetting: async query => {
        if (hold) {
          hold = false;
          await new Promise<void>(resolve => {
            release = resolve;
          });
        }
        return stored.getSetting(query);
      },
    };
    const job = start(settings);
    hold = true;
    await jest.advanceTimersByTimeAsync(LOOK);
    expect(job.tidyState()).toEqual({ status: 'busy' });

    job.tidyNow();
    release?.();
    await jest.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ onRequest: true });
    expect(job.tidyState()).toMatchObject({ status: 'ran' });
  });

  it('keeps what a tidy-up asked for did when a later daily look runs unasked', async () => {
    const settings = inMemoryGlobalSettingsStore();
    await settings.setSetting({ key: MEMORY_NIGHTLY_SETTING_KEY, value: 'true' });
    const job = start(settings);
    job.tidyNow();
    await jest.advanceTimersByTimeAsync(0);
    const asked = job.tidyState();

    run.mockResolvedValueOnce(QUIET_COUNTS);
    await jest.advanceTimersByTimeAsync(LOOK);

    expect(run).toHaveBeenCalledTimes(2);
    expect(job.tidyState()).toEqual(asked);
  });

  it('says a tidy-up failed when it stopped on an error, and can start again', async () => {
    run.mockRejectedValueOnce(new Error('disk full'));
    const job = start(inMemoryGlobalSettingsStore());

    job.tidyNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(job.tidyState()).toEqual({ status: 'failed' });

    job.tidyNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(job.tidyState()).toMatchObject({ status: 'ran' });
  });

  it('tells a page that comes back what the last tidy-up did, for an hour', async () => {
    const job = start(inMemoryGlobalSettingsStore());
    expect(job.tidyState()).toEqual({ status: 'idle' });

    job.tidyNow();
    await jest.advanceTimersByTimeAsync(0);

    expect(job.tidyState()).toMatchObject({ status: 'ran' });
    jest.setSystemTime(Date.now() + 61 * 60 * 1000);
    expect(job.tidyState()).toEqual({ status: 'idle' });
  });
});

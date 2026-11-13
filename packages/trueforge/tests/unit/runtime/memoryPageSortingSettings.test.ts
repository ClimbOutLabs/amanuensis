/** The page-sorting setting: a stored override beats the env default, and only Markdown memory is sorted. */
import { createLogger } from 'winston';

import configuration from '../../../src/config';
import type { IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import {
  MEMORY_PAGE_SORTING_SETTING_KEY,
  readMemoryPageSortingSetting,
} from '../../../src/runtime/memoryPageSortingSettings';
import { inMemoryGlobalSettingsStore } from '../../fixtures/inMemoryGlobalSettingsStore';

const logger = createLogger({ silent: true });

describe('readMemoryPageSortingSetting', () => {
  const originalDefault = configuration.MEMORY_PAGE_SORTING;

  beforeEach(() => {
    configuration.MEMORY_PAGE_SORTING = 'off';
  });

  afterEach(() => {
    configuration.MEMORY_PAGE_SORTING = originalDefault;
  });

  it('is off when nothing is stored and the default is off', async () => {
    const setting = await readMemoryPageSortingSetting({ globalSettingsStore: inMemoryGlobalSettingsStore(), logger });
    expect(setting).toEqual({ mode: 'off', overridden: false, defaultMode: 'off' });
  });

  it('lets a stored value beat the env default, and falls back when it is cleared', async () => {
    const store = inMemoryGlobalSettingsStore({ [MEMORY_PAGE_SORTING_SETTING_KEY]: 'report' });
    expect(await readMemoryPageSortingSetting({ globalSettingsStore: store, logger })).toEqual({
      mode: 'report',
      overridden: true,
      defaultMode: 'off',
    });
    await store.deleteSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY });
    expect((await readMemoryPageSortingSetting({ globalSettingsStore: store, logger })).mode).toBe('off');
  });

  it('reads a change on the next call', async () => {
    const store = inMemoryGlobalSettingsStore();
    await store.setSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY, value: 'on' });
    expect((await readMemoryPageSortingSetting({ globalSettingsStore: store, logger })).mode).toBe('on');
    await store.setSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY, value: 'off' });
    expect((await readMemoryPageSortingSetting({ globalSettingsStore: store, logger })).mode).toBe('off');
  });

  it('follows an env default of on when nothing is stored', async () => {
    configuration.MEMORY_PAGE_SORTING = 'on';
    const setting = await readMemoryPageSortingSetting({ globalSettingsStore: inMemoryGlobalSettingsStore(), logger });
    expect(setting).toEqual({ mode: 'on', overridden: false, defaultMode: 'on' });
  });

  it('stays off for a stored value it cannot understand, even when the default is on', async () => {
    configuration.MEMORY_PAGE_SORTING = 'on';
    const store = inMemoryGlobalSettingsStore({ [MEMORY_PAGE_SORTING_SETTING_KEY]: 'maybe' });
    const setting = await readMemoryPageSortingSetting({ globalSettingsStore: store, logger });
    expect(setting.overridden).toBe(false);
    expect(setting.mode).toBe('off');
  });

  it('stays off when a stored off cannot be read, even when the default is on', async () => {
    configuration.MEMORY_PAGE_SORTING = 'on';
    const failing: IGlobalSettingsStore = {
      ...inMemoryGlobalSettingsStore({ [MEMORY_PAGE_SORTING_SETTING_KEY]: 'off' }),
      getSetting: () => Promise.reject(new Error('db down')),
    };
    const setting = await readMemoryPageSortingSetting({ globalSettingsStore: failing, logger });
    expect(setting.overridden).toBe(false);
    expect(setting.mode).toBe('off');
  });
});

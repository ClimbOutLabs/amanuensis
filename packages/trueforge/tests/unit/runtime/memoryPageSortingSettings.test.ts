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
  const originalBackend = configuration.MEMORY_BACKEND;

  beforeEach(() => {
    configuration.MEMORY_BACKEND = 'markdown';
    configuration.MEMORY_PAGE_SORTING = 'off';
  });

  afterEach(() => {
    configuration.MEMORY_PAGE_SORTING = originalDefault;
    configuration.MEMORY_BACKEND = originalBackend;
  });

  it('is off when nothing is stored and the default is off', async () => {
    const setting = await readMemoryPageSortingSetting({ globalSettingsStore: inMemoryGlobalSettingsStore(), logger });
    expect(setting).toEqual({ mode: 'off', overridden: false, defaultMode: 'off', effectiveMode: 'off' });
  });

  it('lets a stored value beat the env default, and falls back when it is cleared', async () => {
    const store = inMemoryGlobalSettingsStore({ [MEMORY_PAGE_SORTING_SETTING_KEY]: 'report' });
    expect(await readMemoryPageSortingSetting({ globalSettingsStore: store, logger })).toEqual({
      mode: 'report',
      overridden: true,
      defaultMode: 'off',
      effectiveMode: 'report',
    });
    await store.deleteSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY });
    expect((await readMemoryPageSortingSetting({ globalSettingsStore: store, logger })).mode).toBe('off');
  });

  it('reads a change on the next call', async () => {
    const store = inMemoryGlobalSettingsStore();
    await store.setSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY, value: 'on' });
    expect((await readMemoryPageSortingSetting({ globalSettingsStore: store, logger })).effectiveMode).toBe('on');
    await store.setSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY, value: 'off' });
    expect((await readMemoryPageSortingSetting({ globalSettingsStore: store, logger })).effectiveMode).toBe('off');
  });

  it('is effectively off without Markdown memory', async () => {
    configuration.MEMORY_BACKEND = 'hindsight';
    const store = inMemoryGlobalSettingsStore({ [MEMORY_PAGE_SORTING_SETTING_KEY]: 'on' });
    expect(await readMemoryPageSortingSetting({ globalSettingsStore: store, logger })).toEqual({
      mode: 'on',
      overridden: true,
      defaultMode: 'off',
      effectiveMode: 'off',
    });
  });

  it('ignores a malformed stored value', async () => {
    const store = inMemoryGlobalSettingsStore({ [MEMORY_PAGE_SORTING_SETTING_KEY]: 'maybe' });
    const setting = await readMemoryPageSortingSetting({ globalSettingsStore: store, logger });
    expect(setting.overridden).toBe(false);
    expect(setting.mode).toBe('off');
  });

  it('falls back to the env default when the store cannot be read', async () => {
    const failing: IGlobalSettingsStore = {
      ...inMemoryGlobalSettingsStore(),
      getSetting: () => Promise.reject(new Error('db down')),
    };
    const setting = await readMemoryPageSortingSetting({ globalSettingsStore: failing, logger });
    expect(setting.overridden).toBe(false);
    expect(setting.mode).toBe('off');
  });
});

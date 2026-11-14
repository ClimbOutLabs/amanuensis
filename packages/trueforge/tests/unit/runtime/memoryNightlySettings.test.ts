/** The nightly tidy-up setting: a stored override beats the env default, and only Markdown memory is tidied. */
import { createLogger } from 'winston';

import configuration from '../../../src/config';
import type { IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import { MEMORY_NIGHTLY_SETTING_KEY, readMemoryNightlySetting } from '../../../src/runtime/memoryNightlySettings';
import { inMemoryGlobalSettingsStore } from '../../fixtures/inMemoryGlobalSettingsStore';

const logger = createLogger({ silent: true });

describe('readMemoryNightlySetting', () => {
  const originalDefault = configuration.MEMORY_NIGHTLY_JOB;

  beforeEach(() => {
    configuration.MEMORY_NIGHTLY_JOB = false;
  });

  afterEach(() => {
    configuration.MEMORY_NIGHTLY_JOB = originalDefault;
  });

  it('is off when nothing is stored and the default is off', async () => {
    const setting = await readMemoryNightlySetting({ globalSettingsStore: inMemoryGlobalSettingsStore(), logger });
    expect(setting).toEqual({ enabled: false, overridden: false, defaultEnabled: false, hour: 0 });
  });

  it('lets a stored value beat the env default, and falls back when it is cleared', async () => {
    const store = inMemoryGlobalSettingsStore({ [MEMORY_NIGHTLY_SETTING_KEY]: 'true' });
    expect(await readMemoryNightlySetting({ globalSettingsStore: store, logger })).toEqual({
      enabled: true,
      overridden: true,
      defaultEnabled: false,
      hour: 0,
    });
    await store.deleteSetting({ key: MEMORY_NIGHTLY_SETTING_KEY });
    expect((await readMemoryNightlySetting({ globalSettingsStore: store, logger })).enabled).toBe(false);
  });

  it('follows an env default of on when nothing is stored', async () => {
    configuration.MEMORY_NIGHTLY_JOB = true;
    const setting = await readMemoryNightlySetting({ globalSettingsStore: inMemoryGlobalSettingsStore(), logger });
    expect(setting).toEqual({ enabled: true, overridden: false, defaultEnabled: true, hour: 0 });
  });

  it('stays off for a stored value it cannot understand, even when the default is on', async () => {
    configuration.MEMORY_NIGHTLY_JOB = true;
    const store = inMemoryGlobalSettingsStore({ [MEMORY_NIGHTLY_SETTING_KEY]: 'TRUE' });
    const setting = await readMemoryNightlySetting({ globalSettingsStore: store, logger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(false);
  });

  it('stays off when a stored off cannot be read, even when the default is on', async () => {
    configuration.MEMORY_NIGHTLY_JOB = true;
    const failing: IGlobalSettingsStore = {
      ...inMemoryGlobalSettingsStore({ [MEMORY_NIGHTLY_SETTING_KEY]: 'false' }),
      getSetting: () => Promise.reject(new Error('db down')),
    };
    const setting = await readMemoryNightlySetting({ globalSettingsStore: failing, logger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(false);
  });
});

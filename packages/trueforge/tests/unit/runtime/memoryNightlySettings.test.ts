/** The nightly tidy-up setting: a stored override beats the env default, and only Markdown memory is tidied. */
import { createLogger } from 'winston';

import configuration from '../../../src/config';
import type { IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import { MEMORY_NIGHTLY_SETTING_KEY, readMemoryNightlySetting } from '../../../src/runtime/memoryNightlySettings';
import { inMemoryGlobalSettingsStore } from '../../fixtures/inMemoryGlobalSettingsStore';

const logger = createLogger({ silent: true });

describe('readMemoryNightlySetting', () => {
  const originalDefault = configuration.MEMORY_NIGHTLY_JOB;
  const originalBackend = configuration.MEMORY_BACKEND;

  beforeEach(() => {
    configuration.MEMORY_BACKEND = 'markdown';
    configuration.MEMORY_NIGHTLY_JOB = false;
  });

  afterEach(() => {
    configuration.MEMORY_NIGHTLY_JOB = originalDefault;
    configuration.MEMORY_BACKEND = originalBackend;
  });

  it('is off when nothing is stored and the default is off', async () => {
    const setting = await readMemoryNightlySetting({ globalSettingsStore: inMemoryGlobalSettingsStore(), logger });
    expect(setting).toEqual({ enabled: false, overridden: false, defaultEnabled: false, effectiveEnabled: false });
  });

  it('lets a stored value beat the env default, and falls back when it is cleared', async () => {
    const store = inMemoryGlobalSettingsStore({ [MEMORY_NIGHTLY_SETTING_KEY]: 'true' });
    expect(await readMemoryNightlySetting({ globalSettingsStore: store, logger })).toEqual({
      enabled: true,
      overridden: true,
      defaultEnabled: false,
      effectiveEnabled: true,
    });
    await store.deleteSetting({ key: MEMORY_NIGHTLY_SETTING_KEY });
    expect((await readMemoryNightlySetting({ globalSettingsStore: store, logger })).enabled).toBe(false);
  });

  it('is effectively off without Markdown memory', async () => {
    configuration.MEMORY_BACKEND = 'hindsight';
    const store = inMemoryGlobalSettingsStore({ [MEMORY_NIGHTLY_SETTING_KEY]: 'true' });
    const setting = await readMemoryNightlySetting({ globalSettingsStore: store, logger });
    expect(setting.enabled).toBe(true);
    expect(setting.effectiveEnabled).toBe(false);
  });

  it('ignores a malformed stored value', async () => {
    const store = inMemoryGlobalSettingsStore({ [MEMORY_NIGHTLY_SETTING_KEY]: 'TRUE' });
    const setting = await readMemoryNightlySetting({ globalSettingsStore: store, logger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(false);
  });

  it('falls back to the env default when the store cannot be read', async () => {
    const failing: IGlobalSettingsStore = {
      ...inMemoryGlobalSettingsStore(),
      getSetting: () => Promise.reject(new Error('db down')),
    };
    const setting = await readMemoryNightlySetting({ globalSettingsStore: failing, logger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(false);
  });
});

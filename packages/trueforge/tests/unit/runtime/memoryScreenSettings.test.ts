/**
 * Effective recall screen state: persisted override when stored,
 * otherwise the `MEMORY_SCREEN_ENABLED` env default.
 */
import { createLogger } from 'winston';

import configuration from '../../../src/config';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import {
  MEMORY_SCREEN_ENABLED_SETTING_KEY,
  readMemoryScreenSetting,
  resolveMemoryScreenEnabled,
} from '../../../src/runtime/memoryScreenSettings';

const silentLogger = createLogger({ silent: true });

function record(value: string): GlobalSettingRecord {
  return { key: MEMORY_SCREEN_ENABLED_SETTING_KEY, value, updated_at: '2026-09-21T00:00:00.000Z' };
}

function storeWith(values: Map<string, GlobalSettingRecord>): IGlobalSettingsStore {
  return {
    getSetting: async input => values.get(input.key),
    setSetting: async input => {
      const row = record(input.value);
      values.set(input.key, row);
      return row;
    },
    deleteSetting: async input => {
      values.delete(input.key);
    },
    compareAndSetSetting: async () => false,
  };
}

function emptyStore(): IGlobalSettingsStore {
  return storeWith(new Map());
}

const originalScreenUrl = configuration.MEMORY_SCREEN_URL;

beforeEach(() => {
  // The screening service is configured unless a test unsets it.
  configuration.MEMORY_SCREEN_URL = 'https://screen.internal.example.com';
});

afterEach(() => {
  configuration.MEMORY_SCREEN_URL = originalScreenUrl;
});

describe('readMemoryScreenSetting', () => {
  it('falls back to the env default when nothing is stored', async () => {
    const setting = await readMemoryScreenSetting({ globalSettingsStore: emptyStore(), logger: silentLogger });
    expect(setting).toEqual({
      enabled: configuration.MEMORY_SCREEN_ENABLED,
      overridden: false,
      defaultEnabled: configuration.MEMORY_SCREEN_ENABLED,
    });
  });

  it('returns the stored true override', async () => {
    const store = storeWith(new Map([[MEMORY_SCREEN_ENABLED_SETTING_KEY, record('true')]]));
    const setting = await readMemoryScreenSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({
      enabled: true,
      overridden: true,
      defaultEnabled: configuration.MEMORY_SCREEN_ENABLED,
    });
  });

  it('returns the stored false override', async () => {
    const store = storeWith(new Map([[MEMORY_SCREEN_ENABLED_SETTING_KEY, record('false')]]));
    const setting = await readMemoryScreenSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({
      enabled: false,
      overridden: true,
      defaultEnabled: configuration.MEMORY_SCREEN_ENABLED,
    });
  });

  it('treats a malformed stored value as unset', async () => {
    const store = storeWith(new Map([[MEMORY_SCREEN_ENABLED_SETTING_KEY, record('TRUE')]]));
    const setting = await readMemoryScreenSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(configuration.MEMORY_SCREEN_ENABLED);
  });

  it('fails closed to the env default when the store read throws', async () => {
    const failing: IGlobalSettingsStore = {
      getSetting: async () => {
        throw new Error('db down');
      },
      setSetting: async () => {
        throw new Error('db down');
      },
      deleteSetting: async () => {},
      compareAndSetSetting: async () => false,
    };
    const setting = await readMemoryScreenSetting({ globalSettingsStore: failing, logger: silentLogger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(configuration.MEMORY_SCREEN_ENABLED);
  });

  it('resolveMemoryScreenEnabled returns the effective on/off when the service is configured', async () => {
    const store = storeWith(new Map([[MEMORY_SCREEN_ENABLED_SETTING_KEY, record('false')]]));
    await expect(resolveMemoryScreenEnabled({ globalSettingsStore: store, logger: silentLogger })).resolves.toBe(false);
    await expect(resolveMemoryScreenEnabled({ globalSettingsStore: emptyStore(), logger: silentLogger })).resolves.toBe(
      configuration.MEMORY_SCREEN_ENABLED,
    );
  });

  it('resolveMemoryScreenEnabled is effectively off when no screening service is configured', async () => {
    configuration.MEMORY_SCREEN_URL = '';
    // A stored ON override with no classifier to call must never enable screening:
    // there is nothing to screen with, so the effective state stays off.
    const store = storeWith(new Map([[MEMORY_SCREEN_ENABLED_SETTING_KEY, record('true')]]));
    await expect(resolveMemoryScreenEnabled({ globalSettingsStore: store, logger: silentLogger })).resolves.toBe(false);
    // The env default is equally neutered: nothing can be screened with no service.
    const originalDefault = configuration.MEMORY_SCREEN_ENABLED;
    configuration.MEMORY_SCREEN_ENABLED = true;
    try {
      await expect(
        resolveMemoryScreenEnabled({ globalSettingsStore: emptyStore(), logger: silentLogger }),
      ).resolves.toBe(false);
    } finally {
      configuration.MEMORY_SCREEN_ENABLED = originalDefault;
    }
    // The stored setting is preserved verbatim: readMemoryScreenSetting still reports it.
    const setting = await readMemoryScreenSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({
      enabled: true,
      overridden: true,
      defaultEnabled: configuration.MEMORY_SCREEN_ENABLED,
    });
  });
});

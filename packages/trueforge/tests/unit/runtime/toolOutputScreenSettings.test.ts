/**
 * Effective live tool-output screen state: persisted override when stored,
 * otherwise the `TOOL_OUTPUT_SCREEN_ENABLED` env default.
 */
import { createLogger } from 'winston';

import configuration from '../../../src/config';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import {
  TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY,
  readToolOutputScreenSetting,
  resolveToolOutputScreenEnabled,
} from '../../../src/runtime/toolOutputScreenSettings';

const silentLogger = createLogger({ silent: true });

function record(value: string): GlobalSettingRecord {
  return { key: TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY, value, updated_at: '2026-09-17T00:00:00.000Z' };
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

describe('readToolOutputScreenSetting', () => {
  it('falls back to the env default when nothing is stored', async () => {
    const setting = await readToolOutputScreenSetting({ globalSettingsStore: emptyStore(), logger: silentLogger });
    expect(setting).toEqual({
      enabled: configuration.TOOL_OUTPUT_SCREEN_ENABLED,
      overridden: false,
      defaultEnabled: configuration.TOOL_OUTPUT_SCREEN_ENABLED,
    });
  });

  it('returns the stored true override', async () => {
    const store = storeWith(new Map([[TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY, record('true')]]));
    const setting = await readToolOutputScreenSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({
      enabled: true,
      overridden: true,
      defaultEnabled: configuration.TOOL_OUTPUT_SCREEN_ENABLED,
    });
  });

  it('returns the stored false override', async () => {
    const store = storeWith(new Map([[TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY, record('false')]]));
    const setting = await readToolOutputScreenSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({
      enabled: false,
      overridden: true,
      defaultEnabled: configuration.TOOL_OUTPUT_SCREEN_ENABLED,
    });
  });

  it('treats a malformed stored value as unset', async () => {
    const store = storeWith(new Map([[TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY, record('TRUE')]]));
    const setting = await readToolOutputScreenSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(configuration.TOOL_OUTPUT_SCREEN_ENABLED);
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
    const setting = await readToolOutputScreenSetting({ globalSettingsStore: failing, logger: silentLogger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(configuration.TOOL_OUTPUT_SCREEN_ENABLED);
  });

  it('resolveToolOutputScreenEnabled returns the effective on/off when the service is configured', async () => {
    const store = storeWith(new Map([[TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY, record('false')]]));
    await expect(resolveToolOutputScreenEnabled({ globalSettingsStore: store, logger: silentLogger })).resolves.toBe(
      false,
    );
    await expect(
      resolveToolOutputScreenEnabled({ globalSettingsStore: emptyStore(), logger: silentLogger }),
    ).resolves.toBe(configuration.TOOL_OUTPUT_SCREEN_ENABLED);
  });

  it('resolveToolOutputScreenEnabled is effectively off when no screening service is configured', async () => {
    configuration.MEMORY_SCREEN_URL = '';
    // A stored ON override with no classifier to call must never attach the withholder:
    // an empty classifier URL makes every classification fail closed, so attaching it
    // would silently withhold every open-world tool result.
    const store = storeWith(new Map([[TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY, record('true')]]));
    await expect(resolveToolOutputScreenEnabled({ globalSettingsStore: store, logger: silentLogger })).resolves.toBe(
      false,
    );
    // The env default is equally neutered: nothing can be screened with no service.
    const originalDefault = configuration.TOOL_OUTPUT_SCREEN_ENABLED;
    configuration.TOOL_OUTPUT_SCREEN_ENABLED = true;
    try {
      await expect(
        resolveToolOutputScreenEnabled({ globalSettingsStore: emptyStore(), logger: silentLogger }),
      ).resolves.toBe(false);
    } finally {
      configuration.TOOL_OUTPUT_SCREEN_ENABLED = originalDefault;
    }
    // The stored setting is preserved verbatim: readToolOutputScreenSetting still reports it.
    const setting = await readToolOutputScreenSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({
      enabled: true,
      overridden: true,
      defaultEnabled: configuration.TOOL_OUTPUT_SCREEN_ENABLED,
    });
  });
});

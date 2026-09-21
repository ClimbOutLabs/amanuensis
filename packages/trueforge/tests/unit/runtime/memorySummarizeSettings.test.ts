/**
 * Effective turn-summarization state: persisted override when stored,
 * otherwise the `MEMORY_SUMMARIZE` env default — with the markdown-only gate
 * applied, so the Settings toggle can never disagree with the turn path.
 */
import { createLogger } from 'winston';

import configuration from '../../../src/config';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import {
  MEMORY_SUMMARIZE_SETTING_KEY,
  isMemorySummarizeEffective,
  readMemorySummarizeSetting,
  resolveMemorySummarizeEnabled,
} from '../../../src/runtime/memorySummarizeSettings';

const silentLogger = createLogger({ silent: true });

function record(value: string): GlobalSettingRecord {
  return { key: MEMORY_SUMMARIZE_SETTING_KEY, value, updated_at: '2026-09-21T00:00:00.000Z' };
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
  };
}

function emptyStore(): IGlobalSettingsStore {
  return storeWith(new Map());
}

describe('readMemorySummarizeSetting', () => {
  const originalDefault = configuration.MEMORY_SUMMARIZE;
  const originalBackend = configuration.MEMORY_BACKEND;

  beforeEach(() => {
    configuration.MEMORY_BACKEND = 'markdown';
  });

  afterEach(() => {
    configuration.MEMORY_SUMMARIZE = originalDefault;
    configuration.MEMORY_BACKEND = originalBackend;
  });

  it('falls back to the env default when nothing is stored', async () => {
    configuration.MEMORY_SUMMARIZE = false;
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: emptyStore(), logger: silentLogger });
    expect(setting).toEqual({ enabled: false, overridden: false, defaultEnabled: false, effectiveEnabled: false });
  });

  it('falls back to an env default of true when nothing is stored', async () => {
    configuration.MEMORY_SUMMARIZE = true;
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: emptyStore(), logger: silentLogger });
    expect(setting).toEqual({ enabled: true, overridden: false, defaultEnabled: true, effectiveEnabled: true });
  });

  it('returns the stored true override over an env default of false', async () => {
    configuration.MEMORY_SUMMARIZE = false;
    const store = storeWith(new Map([[MEMORY_SUMMARIZE_SETTING_KEY, record('true')]]));
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({ enabled: true, overridden: true, defaultEnabled: false, effectiveEnabled: true });
  });

  it('returns the stored false override over an env default of true', async () => {
    configuration.MEMORY_SUMMARIZE = true;
    const store = storeWith(new Map([[MEMORY_SUMMARIZE_SETTING_KEY, record('false')]]));
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({ enabled: false, overridden: true, defaultEnabled: true, effectiveEnabled: false });
  });

  it('treats a malformed stored value as unset', async () => {
    const store = storeWith(new Map([[MEMORY_SUMMARIZE_SETTING_KEY, record('TRUE')]]));
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(configuration.MEMORY_SUMMARIZE);
    expect(setting.effectiveEnabled).toBe(isMemorySummarizeEffective(configuration.MEMORY_SUMMARIZE));
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
    };
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: failing, logger: silentLogger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(configuration.MEMORY_SUMMARIZE);
  });

  it('reports effective false on a non-markdown backend even when the stored setting is on', async () => {
    configuration.MEMORY_BACKEND = 'hindsight';
    configuration.MEMORY_SUMMARIZE = true;
    const store = storeWith(new Map([[MEMORY_SUMMARIZE_SETTING_KEY, record('true')]]));
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({ enabled: true, overridden: true, defaultEnabled: true, effectiveEnabled: false });
  });

  it('resolveMemorySummarizeEnabled returns the stored setting verbatim (no external gate)', async () => {
    configuration.MEMORY_SUMMARIZE = false;
    const store = storeWith(new Map([[MEMORY_SUMMARIZE_SETTING_KEY, record('true')]]));
    await expect(resolveMemorySummarizeEnabled({ globalSettingsStore: store, logger: silentLogger })).resolves.toBe(
      true,
    );
    await expect(
      resolveMemorySummarizeEnabled({ globalSettingsStore: emptyStore(), logger: silentLogger }),
    ).resolves.toBe(false);
  });
});

describe('isMemorySummarizeEffective', () => {
  const originalBackend = configuration.MEMORY_BACKEND;

  afterEach(() => {
    configuration.MEMORY_BACKEND = originalBackend;
  });

  it('is the stored value on the markdown backend', () => {
    configuration.MEMORY_BACKEND = 'markdown';
    expect(isMemorySummarizeEffective(true)).toBe(true);
    expect(isMemorySummarizeEffective(false)).toBe(false);
  });

  it('is always false on any other backend', () => {
    configuration.MEMORY_BACKEND = 'hindsight';
    expect(isMemorySummarizeEffective(true)).toBe(false);
    expect(isMemorySummarizeEffective(false)).toBe(false);
  });
});

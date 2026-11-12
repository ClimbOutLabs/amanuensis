import { createLogger } from 'winston';

import type { IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import { MEMORY_RECALL_ENABLED_SETTING_KEY, readMemoryRecallSetting } from '../../../src/runtime/memoryRecallSettings';

const logger = createLogger({ silent: true });

function storeWith(value: string | undefined | Error): IGlobalSettingsStore {
  return {
    getSetting: async ({ key }) => {
      expect(key).toBe(MEMORY_RECALL_ENABLED_SETTING_KEY);
      if (value instanceof Error) {
        throw value;
      }
      return value === undefined ? undefined : { key, value, updated_at: '2026-10-29T00:00:00.000Z' };
    },
    setSetting: async () => {
      throw new Error('not used');
    },
    deleteSetting: async () => {
      throw new Error('not used');
    },
    compareAndSetSetting: async () => {
      throw new Error('not used');
    },
  };
}

describe('readMemoryRecallSetting', () => {
  it.each([
    ['true', true],
    ['false', false],
  ])('reads a stored %s', async (stored, expected) => {
    await expect(readMemoryRecallSetting({ globalSettingsStore: storeWith(stored), logger })).resolves.toBe(expected);
  });

  it('is undefined when nothing is stored, so the agent setting applies', async () => {
    await expect(
      readMemoryRecallSetting({ globalSettingsStore: storeWith(undefined), logger }),
    ).resolves.toBeUndefined();
  });

  it('ignores a malformed value', async () => {
    await expect(readMemoryRecallSetting({ globalSettingsStore: storeWith('maybe'), logger })).resolves.toBeUndefined();
  });

  it('leaves recall to the agent setting when the read fails', async () => {
    await expect(
      readMemoryRecallSetting({ globalSettingsStore: storeWith(new Error('db down')), logger }),
    ).resolves.toBeUndefined();
  });
});

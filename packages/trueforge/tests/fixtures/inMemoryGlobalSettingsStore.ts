import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../src/db/globalSettingsStore';

/** A settings store that keeps its rows in memory, for tests that are not about the database. */
export function inMemoryGlobalSettingsStore(initial: Readonly<Record<string, string>> = {}): IGlobalSettingsStore {
  const rows = new Map<string, GlobalSettingRecord>();
  const row = (key: string, value: string): GlobalSettingRecord => ({
    key,
    value,
    updated_at: '2026-11-11T00:00:00.000Z',
  });
  for (const [key, value] of Object.entries(initial)) {
    rows.set(key, row(key, value));
  }
  return {
    getSetting: input => Promise.resolve(rows.get(input.key)),
    setSetting: input => {
      const written = row(input.key, input.value);
      rows.set(input.key, written);
      return Promise.resolve(written);
    },
    deleteSetting: input => {
      rows.delete(input.key);
      return Promise.resolve();
    },
    compareAndSetSetting: () => Promise.resolve(false),
  };
}

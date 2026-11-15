import { settingsBeforeSchema } from '../../../src/cli/secretsRuntime';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';

function storeThatFails(error: unknown): IGlobalSettingsStore {
  return {
    getSetting: () => Promise.reject(error),
    setSetting: () => Promise.reject(error),
    deleteSetting: () => Promise.reject(error),
    compareAndSetSetting: () => Promise.reject(error),
  };
}

describe('key records in a Postgres database that has no tables yet', () => {
  const noTable = Object.assign(new Error('relation "global_settings" does not exist'), { code: '42P01' });

  it('reads as nothing stored, so setup can go on to make the tables', async () => {
    const settings = settingsBeforeSchema(storeThatFails(noTable));
    await expect(settings.getSetting({ key: 'secrets_key_check' })).resolves.toBeUndefined();
  });

  it('still fails a write, which only happens once the tables are there', async () => {
    const settings = settingsBeforeSchema(storeThatFails(noTable));
    await expect(settings.setSetting({ key: 'secrets_key_check', value: 'x' })).rejects.toBe(noTable);
  });

  it('passes every other failure on, such as a database that cannot be reached', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    await expect(settingsBeforeSchema(storeThatFails(down)).getSetting({ key: 'k' })).rejects.toBe(down);
  });

  it('hands a stored record through unchanged', async () => {
    const record: GlobalSettingRecord = { key: 'k', value: 'v', updated_at: '2026-01-01T00:00:00.000Z' };
    const settings = settingsBeforeSchema({
      ...storeThatFails(noTable),
      getSetting: () => Promise.resolve(record),
    });
    await expect(settings.getSetting({ key: 'k' })).resolves.toBe(record);
  });
});

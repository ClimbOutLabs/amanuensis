/**
 * Settings first-run checklist surface: GET reports whether the owner dismissed it, PUT true
 * persists the dismissal, PUT false brings the checklist back.
 */
import { createLogger } from 'winston';

import { createFirstRunGuideRouter, FIRST_RUN_GUIDE_DISMISSED_SETTING_KEY } from '../../../src/apis/firstRunGuide';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { GetFirstRunGuideResponseSchema } from '../../../src/schemas/firstRunGuide';

const silentLogger = createLogger({ silent: true });

async function createRouter() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const globalSettingsStore = new SqliteGlobalSettingsStore(db);
  const router = createFirstRunGuideRouter({ globalSettingsStore, logger: silentLogger });
  return { router, globalSettingsStore };
}

function putInit(dismissed: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dismissed }),
  };
}

async function readState(response: Response): Promise<boolean> {
  expect(response.status).toBe(200);
  return GetFirstRunGuideResponseSchema.parse(await response.json()).data.dismissed;
}

describe('first-run guide router', () => {
  it('starts not dismissed, remembers a dismissal, and can bring the checklist back', async () => {
    const { router, globalSettingsStore } = await createRouter();

    expect(await readState(await router.request('/'))).toBe(false);

    expect(await readState(await router.request('/', putInit(true)))).toBe(true);
    expect(await readState(await router.request('/'))).toBe(true);
    expect(await globalSettingsStore.getSetting({ key: FIRST_RUN_GUIDE_DISMISSED_SETTING_KEY })).toMatchObject({
      value: 'true',
    });

    expect(await readState(await router.request('/', putInit(false)))).toBe(false);
    expect(await readState(await router.request('/'))).toBe(false);
    expect(await globalSettingsStore.getSetting({ key: FIRST_RUN_GUIDE_DISMISSED_SETTING_KEY })).toBeUndefined();
  });

  it('rejects a body without the flag', async () => {
    const { router } = await createRouter();
    expect((await router.request('/', putInit('yes'))).status).toBe(400);
    expect((await router.request('/', putInit(undefined))).status).toBe(400);
  });

  it('shows the checklist when the store cannot be read', async () => {
    const failing: IGlobalSettingsStore = {
      getSetting: () => Promise.reject(new Error('transient store read failure')),
      setSetting: (): Promise<GlobalSettingRecord> => Promise.reject(new Error('unused')),
      deleteSetting: () => Promise.reject(new Error('unused')),
      compareAndSetSetting: () => Promise.reject(new Error('unused')),
    };
    const router = createFirstRunGuideRouter({ globalSettingsStore: failing, logger: silentLogger });
    expect(await readState(await router.request('/'))).toBe(false);
  });
});

/** Settings page-sorting surface: GET reports the stored setting, PUT stores or clears an override. */
import { createLogger } from 'winston';

import { createMemoryPageSortingRouter } from '../../../src/apis/memoryPageSorting';
import configuration from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';

const silentLogger = createLogger({ silent: true });
const KEY = 'memory_page_sorting_mode';

async function createRouter() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const globalSettingsStore = new SqliteGlobalSettingsStore(db);
  const router = createMemoryPageSortingRouter({ globalSettingsStore, logger: silentLogger });
  return { router, globalSettingsStore };
}

const putInit = (mode: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode }),
});

describe('memoryPageSorting router', () => {
  const originalDefault = configuration.MEMORY_PAGE_SORTING;

  beforeEach(() => {
    configuration.MEMORY_PAGE_SORTING = 'off';
  });

  afterEach(() => {
    configuration.MEMORY_PAGE_SORTING = originalDefault;
  });

  it('GET reports the env default when no override is stored', async () => {
    const { router } = await createRouter();
    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { mode: 'off', overridden: false, default_mode: 'off' },
    });
  });

  it('PUT stores each mode and reports it', async () => {
    const { router, globalSettingsStore } = await createRouter();
    for (const mode of ['report', 'on', 'off'] as const) {
      const response = await router.request('/', putInit(mode));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: { mode, overridden: true, default_mode: 'off' },
      });
      expect((await globalSettingsStore.getSetting({ key: KEY }))?.value).toBe(mode);
    }
  });

  it('PUT null clears the override back to the env default', async () => {
    const { router, globalSettingsStore } = await createRouter();
    await router.request('/', putInit('on'));
    const cleared = await router.request('/', putInit(null));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      data: { mode: 'off', overridden: false, default_mode: 'off' },
    });
    expect(await globalSettingsStore.getSetting({ key: KEY })).toBeUndefined();
  });

  it('refuses a value that is not off, report or on, and stores nothing', async () => {
    const { router, globalSettingsStore } = await createRouter();
    const response = await router.request('/', putInit('sometimes'));
    expect(response.status).toBe(400);
    expect(await globalSettingsStore.getSetting({ key: KEY })).toBeUndefined();
  });
});

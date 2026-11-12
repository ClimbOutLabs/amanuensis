/**
 * Settings memory recall switch: GET reports the stored value (null when never set),
 * PUT true/false stores it, PUT null clears it back to each agent's own setting.
 */
import { createLogger } from 'winston';

import { createMemoryRecallRouter } from '../../../src/apis/memoryRecall';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';

const silentLogger = createLogger({ silent: true });

const KEY = 'memory_recall_enabled';

async function createRouter() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const globalSettingsStore = new SqliteGlobalSettingsStore(db);
  const router = createMemoryRecallRouter({ globalSettingsStore, logger: silentLogger });
  return { router, globalSettingsStore };
}

function putInit(enabled: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  };
}

describe('memoryRecall router', () => {
  it('GET reports null when the switch was never set', async () => {
    const { router } = await createRouter();
    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { enabled: null } });
  });

  it('PUT true and false store the switch and GET reports it', async () => {
    const { router, globalSettingsStore } = await createRouter();

    const putFalse = await router.request('/', putInit(false));
    expect(putFalse.status).toBe(200);
    expect(await putFalse.json()).toEqual({ data: { enabled: false } });
    expect((await globalSettingsStore.getSetting({ key: KEY }))?.value).toBe('false');
    expect(await (await router.request('/')).json()).toEqual({ data: { enabled: false } });

    const putTrue = await router.request('/', putInit(true));
    expect(await putTrue.json()).toEqual({ data: { enabled: true } });
    expect((await globalSettingsStore.getSetting({ key: KEY }))?.value).toBe('true');
  });

  it('PUT null clears the switch', async () => {
    const { router, globalSettingsStore } = await createRouter();
    await router.request('/', putInit(false));

    const cleared = await router.request('/', putInit(null));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ data: { enabled: null } });
    expect(await globalSettingsStore.getSetting({ key: KEY })).toBeUndefined();
  });

  it('PUT with a non-boolean enabled is rejected and stores nothing', async () => {
    const { router, globalSettingsStore } = await createRouter();
    const response = await router.request('/', putInit('yes'));
    expect(response.status).toBe(400);
    expect(await globalSettingsStore.getSetting({ key: KEY })).toBeUndefined();
  });
});

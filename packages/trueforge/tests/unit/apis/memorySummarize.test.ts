/**
 * Settings turn-summarization surface: GET reports the stored setting, PUT
 * true/false persists an override, PUT null clears it back to the env default.
 */
import { createLogger } from 'winston';

import { createMemorySummarizeRouter } from '../../../src/apis/memorySummarize';
import configuration from '../../../src/config';
import type {
  CompareAndSetGlobalSettingInput,
  GetGlobalSettingInput,
  GlobalSettingRecord,
  IGlobalSettingsStore,
  SetGlobalSettingInput,
} from '../../../src/db/globalSettingsStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';

const silentLogger = createLogger({ silent: true });

const KEY = 'memory_summarize_enabled';

/**
 * A store whose reads fail while writes succeed, simulating a transient read outage
 * hitting the PUT confirmation. The write must still land; the confirmation must
 * report what was written rather than fabricate state from the env-default fallback.
 */
class ReadFailingGlobalSettingsStore implements IGlobalSettingsStore {
  private readonly inner: SqliteGlobalSettingsStore;

  constructor(inner: SqliteGlobalSettingsStore) {
    this.inner = inner;
  }

  getSetting(): Promise<GlobalSettingRecord | undefined> {
    return Promise.reject(new Error('transient store read failure'));
  }

  setSetting(input: SetGlobalSettingInput): Promise<GlobalSettingRecord> {
    return this.inner.setSetting(input);
  }

  deleteSetting(input: GetGlobalSettingInput): Promise<void> {
    return this.inner.deleteSetting(input);
  }

  compareAndSetSetting(input: CompareAndSetGlobalSettingInput): Promise<boolean> {
    return this.inner.compareAndSetSetting(input);
  }
}

async function createRouter() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const globalSettingsStore = new SqliteGlobalSettingsStore(db);
  const router = createMemorySummarizeRouter({ globalSettingsStore, logger: silentLogger });
  return { router, globalSettingsStore };
}

function putInit(enabled: boolean | null): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  };
}

describe('memorySummarize router', () => {
  const originalDefault = configuration.MEMORY_SUMMARIZE;
  const originalBackend = configuration.MEMORY_BACKEND;

  beforeEach(() => {
    configuration.MEMORY_SUMMARIZE = false;
    configuration.MEMORY_BACKEND = 'markdown';
  });

  afterEach(() => {
    configuration.MEMORY_SUMMARIZE = originalDefault;
    configuration.MEMORY_BACKEND = originalBackend;
  });

  it('GET reports the env default when no override is stored', async () => {
    const { router } = await createRouter();
    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { enabled: false, overridden: false, default_enabled: false, effective_enabled: false },
    });
  });

  it('PUT true/false persists an override and reports it', async () => {
    const { router, globalSettingsStore } = await createRouter();

    const putTrue = await router.request('/', putInit(true));
    expect(putTrue.status).toBe(200);
    expect(await putTrue.json()).toEqual({
      data: { enabled: true, overridden: true, default_enabled: false, effective_enabled: true },
    });
    expect((await globalSettingsStore.getSetting({ key: KEY }))?.value).toBe('true');

    const putFalse = await router.request('/', putInit(false));
    expect(putFalse.status).toBe(200);
    expect(await putFalse.json()).toEqual({
      data: { enabled: false, overridden: true, default_enabled: false, effective_enabled: false },
    });
    expect((await globalSettingsStore.getSetting({ key: KEY }))?.value).toBe('false');

    const get = await router.request('/');
    expect(await get.json()).toEqual({
      data: { enabled: false, overridden: true, default_enabled: false, effective_enabled: false },
    });
  });

  it('PUT null clears the override back to the env default', async () => {
    const { router, globalSettingsStore } = await createRouter();
    await router.request('/', putInit(true));

    const cleared = await router.request('/', putInit(null));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      data: { enabled: false, overridden: false, default_enabled: false, effective_enabled: false },
    });
    expect(await globalSettingsStore.getSetting({ key: KEY })).toBeUndefined();
  });

  it('PUT with a non-boolean enabled is rejected', async () => {
    const { router } = await createRouter();
    const response = await router.request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(response.status).toBe(400);
  });

  it('reports effective false on a non-markdown backend even when the stored setting is on', async () => {
    configuration.MEMORY_BACKEND = 'hindsight';
    const { router } = await createRouter();
    await router.request('/', putInit(true));

    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { enabled: true, overridden: true, default_enabled: false, effective_enabled: false },
    });
  });

  it('PUT reports the written state instead of fabricating it when the read-back fails', async () => {
    configuration.MEMORY_SUMMARIZE = true;
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const router = createMemorySummarizeRouter({
      globalSettingsStore: new ReadFailingGlobalSettingsStore(new SqliteGlobalSettingsStore(db)),
      logger: silentLogger,
    });

    // The dangerous direction: admin flips summarization OFF while the env default is ON.
    // A read-back failure must not fabricate an `enabled: true` confirmation.
    const putFalse = await router.request('/', putInit(false));
    expect(putFalse.status).toBe(200);
    expect(await putFalse.json()).toEqual({
      data: { enabled: false, overridden: true, default_enabled: true, effective_enabled: false },
    });

    // Clearing the override reports the env default as the effective state.
    const cleared = await router.request('/', putInit(null));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      data: { enabled: true, overridden: false, default_enabled: true, effective_enabled: true },
    });
  });
});

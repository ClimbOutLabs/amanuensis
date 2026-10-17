/**
 * Settings recall screen surface: GET reports the stored state, PUT
 * true/false persists an override, PUT null clears it back to the env default.
 */
import { createLogger } from 'winston';

import { createMemoryScreensRouter } from '../../../src/apis/memoryScreens';
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

const KEY = 'memory_screen_enabled';

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
  const router = createMemoryScreensRouter({ globalSettingsStore, logger: silentLogger });
  return { router, globalSettingsStore };
}

function putInit(enabled: boolean | null): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  };
}

const originalScreenUrl = configuration.MEMORY_SCREEN_URL;

beforeEach(() => {
  // The screening service is configured unless a test unsets it.
  configuration.MEMORY_SCREEN_URL = 'https://screen.internal.example.com';
});

afterEach(() => {
  configuration.MEMORY_SCREEN_URL = originalScreenUrl;
});

describe('memoryScreens router', () => {
  it('GET reports the env default when no override is stored', async () => {
    const { router } = await createRouter();
    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        enabled: configuration.MEMORY_SCREEN_ENABLED,
        overridden: false,
        default_enabled: configuration.MEMORY_SCREEN_ENABLED,
      },
    });
  });

  it('PUT true/false persists an override and reports it', async () => {
    const { router, globalSettingsStore } = await createRouter();

    const putTrue = await router.request('/', putInit(true));
    expect(putTrue.status).toBe(200);
    expect(await putTrue.json()).toEqual({
      data: { enabled: true, overridden: true, default_enabled: configuration.MEMORY_SCREEN_ENABLED },
    });
    expect((await globalSettingsStore.getSetting({ key: KEY }))?.value).toBe('true');

    const putFalse = await router.request('/', putInit(false));
    expect(putFalse.status).toBe(200);
    expect(await putFalse.json()).toEqual({
      data: { enabled: false, overridden: true, default_enabled: configuration.MEMORY_SCREEN_ENABLED },
    });
    expect((await globalSettingsStore.getSetting({ key: KEY }))?.value).toBe('false');

    const get = await router.request('/');
    expect(await get.json()).toEqual({
      data: { enabled: false, overridden: true, default_enabled: configuration.MEMORY_SCREEN_ENABLED },
    });
  });

  it('PUT null clears the override back to the env default', async () => {
    const { router, globalSettingsStore } = await createRouter();
    await router.request('/', putInit(true));

    const cleared = await router.request('/', putInit(null));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      data: {
        enabled: configuration.MEMORY_SCREEN_ENABLED,
        overridden: false,
        default_enabled: configuration.MEMORY_SCREEN_ENABLED,
      },
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

  it('PUT true is rejected with 409 while no screening service is configured', async () => {
    configuration.MEMORY_SCREEN_URL = '';
    const { router, globalSettingsStore } = await createRouter();

    // Turning recall screening on with no classifier to call would promise screening
    // the server cannot perform.
    const putTrue = await router.request('/', putInit(true));
    expect(putTrue.status).toBe(409);
    expect(await putTrue.json()).toEqual({
      error: {
        message:
          'Cannot change the recall screen setting: no screening service is configured (`MEMORY_SCREEN_URL` is unset).',
        code: 'memory_screen_not_configured',
      },
    });
    // The rejection must not persist anything.
    expect(await globalSettingsStore.getSetting({ key: KEY })).toBeUndefined();
  });

  it('PUT false is allowed while unconfigured: explicitly recording "off" is honest', async () => {
    configuration.MEMORY_SCREEN_URL = '';
    const { router, globalSettingsStore } = await createRouter();

    // A user who previously stored ON (when a service was configured) can explicitly
    // record OFF after the service is removed; the stored value stays inert until a
    // service is configured again.
    const putFalse = await router.request('/', putInit(false));
    expect(putFalse.status).toBe(200);
    expect(await putFalse.json()).toEqual({
      data: { enabled: false, overridden: true, default_enabled: configuration.MEMORY_SCREEN_ENABLED },
    });
    expect(await globalSettingsStore.getSetting({ key: KEY })).toMatchObject({ value: 'false' });
  });

  it('PUT null still clears a stale override while unconfigured', async () => {
    configuration.MEMORY_SCREEN_URL = '';
    const { router, globalSettingsStore } = await createRouter();
    // The stale ON override a removed sidecar leaves behind: seeded directly, since
    // PUT true is (correctly) rejected while unconfigured.
    await globalSettingsStore.setSetting({ key: KEY, value: 'true' });

    const cleared = await router.request('/', putInit(null));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      data: {
        enabled: configuration.MEMORY_SCREEN_ENABLED,
        overridden: false,
        default_enabled: configuration.MEMORY_SCREEN_ENABLED,
      },
    });
    expect(await globalSettingsStore.getSetting({ key: KEY })).toBeUndefined();
  });

  it('PUT reports the written state instead of fabricating it when the read-back fails', async () => {
    const originalDefault = configuration.MEMORY_SCREEN_ENABLED;
    configuration.MEMORY_SCREEN_ENABLED = true;
    try {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const router = createMemoryScreensRouter({
        globalSettingsStore: new ReadFailingGlobalSettingsStore(new SqliteGlobalSettingsStore(db)),
        logger: silentLogger,
      });

      // The dangerous direction: admin flips recall screening OFF while the env default is ON.
      // A read-back failure must not fabricate an `enabled: true` confirmation.
      const putFalse = await router.request('/', putInit(false));
      expect(putFalse.status).toBe(200);
      expect(await putFalse.json()).toEqual({
        data: { enabled: false, overridden: true, default_enabled: true },
      });

      // Clearing the override reports the env default as the effective state.
      const cleared = await router.request('/', putInit(null));
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toEqual({
        data: { enabled: true, overridden: false, default_enabled: true },
      });
    } finally {
      configuration.MEMORY_SCREEN_ENABLED = originalDefault;
    }
  });
});

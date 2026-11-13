/**
 * Settings nightly tidy-up surface: GET reports the stored setting, PUT
 * true/false persists an override, PUT null clears it back to the env default.
 */
import { createLogger } from 'winston';

import { createMemoryNightlyRouter } from '../../../src/apis/memoryNightly';
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
import type { TidyNowResult, TidyState } from '../../../src/runtime/memory/nightlyService';

const silentLogger = createLogger({ silent: true });

const KEY = 'memory_nightly_job_enabled';

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
  const tidyNow = jest.fn<Promise<TidyNowResult>, []>();
  const tidyState = jest.fn<TidyState, []>(() => ({ status: 'idle' }));
  const router = createMemoryNightlyRouter({
    globalSettingsStore,
    memoryTidy: { tidyNow, tidyState },
    logger: silentLogger,
  });
  return { router, globalSettingsStore, tidyNow, tidyState };
}

function putInit(enabled: boolean | null): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  };
}

describe('memoryNightly router', () => {
  const originalDefault = configuration.MEMORY_NIGHTLY_JOB;

  beforeEach(() => {
    configuration.MEMORY_NIGHTLY_JOB = false;
  });

  afterEach(() => {
    configuration.MEMORY_NIGHTLY_JOB = originalDefault;
  });

  it('GET reports the env default when no override is stored', async () => {
    const { router } = await createRouter();
    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { enabled: false, overridden: false, default_enabled: false, hour: 0 },
    });
  });

  it('PUT true/false persists an override and reports it', async () => {
    const { router, globalSettingsStore } = await createRouter();

    const putTrue = await router.request('/', putInit(true));
    expect(putTrue.status).toBe(200);
    expect(await putTrue.json()).toEqual({
      data: { enabled: true, overridden: true, default_enabled: false, hour: 0 },
    });
    expect((await globalSettingsStore.getSetting({ key: KEY }))?.value).toBe('true');

    const putFalse = await router.request('/', putInit(false));
    expect(putFalse.status).toBe(200);
    expect(await putFalse.json()).toEqual({
      data: { enabled: false, overridden: true, default_enabled: false, hour: 0 },
    });
    expect((await globalSettingsStore.getSetting({ key: KEY }))?.value).toBe('false');

    const get = await router.request('/');
    expect(await get.json()).toEqual({
      data: { enabled: false, overridden: true, default_enabled: false, hour: 0 },
    });
  });

  it('PUT null clears the override back to the env default', async () => {
    const { router, globalSettingsStore } = await createRouter();
    await router.request('/', putInit(true));

    const cleared = await router.request('/', putInit(null));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      data: { enabled: false, overridden: false, default_enabled: false, hour: 0 },
    });
    expect(await globalSettingsStore.getSetting({ key: KEY })).toBeUndefined();
  });

  it('PUT hour saves the hour and leaves the switch as it is', async () => {
    const { router, globalSettingsStore } = await createRouter();
    await router.request('/', putInit(true));

    const put = await router.request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hour: 21 }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      data: { enabled: true, overridden: true, default_enabled: false, hour: 21 },
    });
    expect((await globalSettingsStore.getSetting({ key: 'memory_nightly_job_hour' }))?.value).toBe('21');

    const off = await router.request('/', putInit(false));
    expect(await off.json()).toEqual({
      data: { enabled: false, overridden: true, default_enabled: false, hour: 21 },
    });
  });

  it.each([24, -1, 1.5, '3'])('PUT with hour %p is rejected', async hour => {
    const { router } = await createRouter();
    const response = await router.request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hour }),
    });
    expect(response.status).toBe(400);
  });

  it('GET reads a stored hour that is not an hour of the day as midnight', async () => {
    const { router, globalSettingsStore } = await createRouter();
    await globalSettingsStore.setSetting({ key: 'memory_nightly_job_hour', value: '99' });
    expect(await (await router.request('/')).json()).toEqual({
      data: { enabled: false, overridden: false, default_enabled: false, hour: 0 },
    });
  });

  it('POST /run tidies now and reports what was done', async () => {
    const { router, tidyNow } = await createRouter();
    tidyNow.mockResolvedValue({
      status: 'ran',
      counts: {
        movedToEarlier: 3,
        notesAsked: 4,
        notesSorted: 2,
        pagesAsked: 5,
        pairsListed: 1,
        vaultsWithoutModel: 0,
        unsortedReasons: ['reply_too_long'],
      },
      sorting: 'on',
    });
    const response = await router.request('/run', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        status: 'ran',
        moved_to_earlier: 3,
        notes_asked: 4,
        notes_sorted: 2,
        pairs_listed: 1,
        sorting: 'on',
        model_missing: false,
        unsorted_reasons: ['reply_too_long'],
      },
    });
  });

  it('POST /run says so when a tidy-up is already running', async () => {
    const { router, tidyNow } = await createRouter();
    tidyNow.mockResolvedValue({ status: 'busy' });
    const response = await router.request('/run', { method: 'POST' });
    expect(await response.json()).toEqual({
      data: {
        status: 'busy',
        moved_to_earlier: 0,
        notes_asked: 0,
        notes_sorted: 0,
        pairs_listed: 0,
        sorting: 'off',
        model_missing: false,
        unsorted_reasons: [],
      },
    });
  });

  it('POST /run says when no model was found for a run with sorting on', async () => {
    const { router, tidyNow } = await createRouter();
    tidyNow.mockResolvedValue({
      status: 'ran',
      counts: {
        movedToEarlier: 0,
        notesAsked: 0,
        notesSorted: 0,
        pagesAsked: 0,
        pairsListed: 0,
        vaultsWithoutModel: 1,
        unsortedReasons: [],
      },
      sorting: 'on',
    });
    const response = await router.request('/run', { method: 'POST' });
    expect(await response.json()).toMatchObject({ data: { status: 'ran', sorting: 'on', model_missing: true } });
  });

  it('GET /run tells where a tidy-up stands and starts nothing', async () => {
    const { router, tidyNow, tidyState } = await createRouter();

    expect(await (await router.request('/run')).json()).toMatchObject({ data: { status: 'idle' } });

    tidyState.mockReturnValue({ status: 'busy' });
    expect(await (await router.request('/run')).json()).toMatchObject({ data: { status: 'busy' } });

    tidyState.mockReturnValue({
      status: 'ran',
      counts: {
        movedToEarlier: 1,
        notesAsked: 2,
        notesSorted: 1,
        pagesAsked: 0,
        pairsListed: 0,
        vaultsWithoutModel: 0,
        unsortedReasons: ['model_slow'],
      },
      sorting: 'on',
    });
    expect(await (await router.request('/run')).json()).toMatchObject({
      data: { status: 'ran', moved_to_earlier: 1, notes_asked: 2, notes_sorted: 1, unsorted_reasons: ['model_slow'] },
    });
    expect(tidyNow).not.toHaveBeenCalled();
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

  it('PUT reports the written state instead of fabricating it when the read-back fails', async () => {
    configuration.MEMORY_NIGHTLY_JOB = true;
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const router = createMemoryNightlyRouter({
      globalSettingsStore: new ReadFailingGlobalSettingsStore(new SqliteGlobalSettingsStore(db)),
      memoryTidy: { tidyNow: () => Promise.resolve({ status: 'busy' }), tidyState: () => ({ status: 'idle' }) },
      logger: silentLogger,
    });

    // The dangerous direction: admin flips the nightly tidy-up OFF while the env default is ON.
    // A read-back failure must not fabricate an `enabled: true` confirmation.
    const putFalse = await router.request('/', putInit(false));
    expect(putFalse.status).toBe(200);
    expect(await putFalse.json()).toEqual({
      data: { enabled: false, overridden: true, default_enabled: true, hour: 0 },
    });

    // Clearing the override reports the env default as the effective state.
    const cleared = await router.request('/', putInit(null));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      data: { enabled: true, overridden: false, default_enabled: true, hour: 0 },
    });
  });
});

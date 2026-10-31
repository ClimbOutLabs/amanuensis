/**
 * Settings maps surface: GET shows each field with its default and whether the
 * environment owns it, PUT saves and clears saved addresses, and the test
 * endpoint reports each service on its own. Admin-only is enforced at the
 * /api/v1/settings mount and covered by the route ownership suite.
 */
import { createLogger } from 'winston';

import { createMapsSettingsRouter } from '../../../src/apis/mapsSettings';
import configuration from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';

const silentLogger = createLogger({ silent: true });

async function createRouter(testFetchUpstream?: (url: string) => Promise<Response>) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const globalSettingsStore = new SqliteGlobalSettingsStore(db);
  const router = createMapsSettingsRouter({
    globalSettingsStore,
    logger: silentLogger,
    ...(testFetchUpstream === undefined ? {} : { testFetchUpstream }),
  });
  return { router, globalSettingsStore };
}

function putInit(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const savedRouterUrl = configuration.MAPS_ROUTER_URL;
const savedFromEnv = { ...configuration.MAPS_URL_FROM_ENV };

beforeEach(() => {
  configuration.MAPS_ROUTER_URL = savedRouterUrl;
  configuration.MAPS_URL_FROM_ENV = { ...savedFromEnv };
});

afterEach(() => {
  configuration.MAPS_ROUTER_URL = savedRouterUrl;
  configuration.MAPS_URL_FROM_ENV = { ...savedFromEnv };
});

interface FieldState {
  value: string | null;
  default_value: string;
  set_by_environment: boolean;
}

async function getFields(router: Awaited<ReturnType<typeof createRouter>>['router']) {
  const response = await router.request('/');
  expect(response.status).toBe(200);
  const body: { data: Record<string, FieldState> } = await response.json();
  return body.data;
}

describe('maps settings router', () => {
  it('GET shows every field unset with its built-in default as the placeholder', async () => {
    const { router } = await createRouter();
    const data = await getFields(router);
    expect(data['maps_router_url']).toEqual({
      value: null,
      default_value: 'https://router.project-osrm.org',
      set_by_environment: false,
    });
    expect(data['maps_tile_url']?.default_value).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(data['maps_geocoder_url']?.set_by_environment).toBe(false);
  });

  it('PUT then GET round-trips a saved address', async () => {
    const { router, globalSettingsStore } = await createRouter();
    const put = await router.request('/', putInit({ maps_router_url: 'https://osrm.example.com' }));
    expect(put.status).toBe(200);
    const putBody: { data: Record<string, FieldState> } = await put.json();
    expect(putBody.data['maps_router_url']?.value).toBe('https://osrm.example.com');
    expect((await globalSettingsStore.getSetting({ key: 'maps_router_url' }))?.value).toBe('https://osrm.example.com');

    const data = await getFields(router);
    expect(data['maps_router_url']?.value).toBe('https://osrm.example.com');
    expect(data['maps_walking_router_url']?.value).toBeNull();
  });

  it('PUT null clears the saved address back to the default', async () => {
    const { router, globalSettingsStore } = await createRouter();
    await router.request('/', putInit({ maps_router_url: 'https://osrm.example.com' }));
    const put = await router.request('/', putInit({ maps_router_url: null }));
    expect(put.status).toBe(200);
    expect(await globalSettingsStore.getSetting({ key: 'maps_router_url' })).toBeUndefined();
    const data = await getFields(router);
    expect(data['maps_router_url']?.value).toBeNull();
  });

  it('leaves fields the PUT does not mention as they were', async () => {
    const { router, globalSettingsStore } = await createRouter();
    await globalSettingsStore.setSetting({ key: 'maps_walking_router_url', value: 'https://foot.example.com' });
    await router.request('/', putInit({ maps_router_url: 'https://osrm.example.com' }));
    const data = await getFields(router);
    expect(data['maps_walking_router_url']?.value).toBe('https://foot.example.com');
  });

  it('rejects an address with a bad scheme and accepts plain http on a home network', async () => {
    const { router } = await createRouter();
    const bad = await router.request('/', putInit({ maps_router_url: 'ftp://osrm.example.com' }));
    expect(bad.status).toBe(400);
    const good = await router.request('/', putInit({ maps_router_url: 'http://192.168.1.10:5000' }));
    expect(good.status).toBe(200);
  });

  it('rejects a map pictures address without the placeholders', async () => {
    const { router } = await createRouter();
    const bad = await router.request('/', putInit({ maps_tile_url: 'https://tile.example.org/tile.png' }));
    expect(bad.status).toBe(400);
    const good = await router.request('/', putInit({ maps_tile_url: 'https://tile.example.org/{z}/{x}/{y}.png' }));
    expect(good.status).toBe(200);
  });

  it('shows an environment address read-only, and it wins over a saved one', async () => {
    const { router, globalSettingsStore } = await createRouter();
    configuration.MAPS_URL_FROM_ENV.MAPS_ROUTER_URL = true;
    configuration.MAPS_ROUTER_URL = 'https://env-osrm.example.com';
    await globalSettingsStore.setSetting({ key: 'maps_router_url', value: 'https://osrm.example.com' });
    const data = await getFields(router);
    expect(data['maps_router_url']).toEqual({
      value: 'https://env-osrm.example.com',
      default_value: 'https://router.project-osrm.org',
      set_by_environment: true,
    });
  });

  it('the test endpoint reports each service separately', async () => {
    const { router } = await createRouter((url: string) => {
      if (url.includes('/route/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ code: 'Ok', routes: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.includes('nominatim.openstreetmap.org')) {
        return Promise.reject(new Error('connect ECONNREFUSED'));
      }
      if (url.includes('/0/0/0')) {
        return Promise.resolve(new Response('png', { status: 200, headers: { 'content-type': 'image/png' } }));
      }
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const response = await router.request('/test', { method: 'POST' });
    expect(response.status).toBe(200);
    const body: { data: Record<string, { ok: boolean; message: string | null }> } = await response.json();
    expect(body.data['maps_router_url']).toEqual({ ok: true, message: null });
    expect(body.data['maps_geocoder_url']?.ok).toBe(false);
    expect(body.data['maps_geocoder_url']?.message).toContain("didn't answer");
    expect(body.data['maps_tile_url']?.ok).toBe(true);
  });
});

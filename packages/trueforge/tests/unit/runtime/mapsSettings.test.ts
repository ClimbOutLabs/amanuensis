/**
 * The maps server address helper: the environment wins, then the value saved
 * in Settings, then the built-in default. Plus the saved-value validation and
 * the per-service connection test.
 */
import { createLogger } from 'winston';

import configuration from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import {
  resolveMapsServers,
  resolveMapsServerUrl,
  testMapsServers,
  type MapsServers,
} from '../../../src/runtime/mapsSettings';
import { mapsServerUrlProblem } from '../../../src/schemas/mapsSettings';

const silentLogger = createLogger({ silent: true });

async function createStore() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  return new SqliteGlobalSettingsStore(db);
}

const CONFIG_KEYS = [
  'MAPS_ROUTER_URL',
  'MAPS_WALKING_ROUTER_URL',
  'MAPS_CYCLING_ROUTER_URL',
  'MAPS_GEOCODER_URL',
  'MAPS_TRANSIT_URL',
  'MAPS_TILE_URL',
] as const;

const savedConfig = CONFIG_KEYS.map(key => [key, configuration[key]] as const);
const savedFromEnv = { ...configuration.MAPS_URL_FROM_ENV };

beforeEach(() => {
  for (const [key, value] of savedConfig) {
    configuration[key] = value;
  }
  configuration.MAPS_URL_FROM_ENV = { ...savedFromEnv };
});

afterEach(() => {
  for (const [key, value] of savedConfig) {
    configuration[key] = value;
  }
  configuration.MAPS_URL_FROM_ENV = { ...savedFromEnv };
});

describe('resolveMapsServerUrl', () => {
  it('uses the built-in default when nothing is saved and the environment sets nothing', async () => {
    const globalSettingsStore = await createStore();
    const deps = { globalSettingsStore, logger: silentLogger };
    configuration.MAPS_URL_FROM_ENV.MAPS_ROUTER_URL = false;
    await expect(resolveMapsServerUrl({ deps, field: 'router' })).resolves.toBe('https://router.project-osrm.org');
  });

  it('uses the saved address over the default', async () => {
    const globalSettingsStore = await createStore();
    const deps = { globalSettingsStore, logger: silentLogger };
    configuration.MAPS_URL_FROM_ENV.MAPS_ROUTER_URL = false;
    await globalSettingsStore.setSetting({ key: 'maps_router_url', value: 'https://osrm.example.com' });
    await expect(resolveMapsServerUrl({ deps, field: 'router' })).resolves.toBe('https://osrm.example.com');
  });

  it('lets the environment win over the saved address', async () => {
    const globalSettingsStore = await createStore();
    const deps = { globalSettingsStore, logger: silentLogger };
    configuration.MAPS_URL_FROM_ENV.MAPS_ROUTER_URL = true;
    configuration.MAPS_ROUTER_URL = 'https://env-osrm.example.com';
    await globalSettingsStore.setSetting({ key: 'maps_router_url', value: 'https://osrm.example.com' });
    await expect(resolveMapsServerUrl({ deps, field: 'router' })).resolves.toBe('https://env-osrm.example.com');
  });

  it('falls back to the default when the saved address is cleared', async () => {
    const globalSettingsStore = await createStore();
    const deps = { globalSettingsStore, logger: silentLogger };
    configuration.MAPS_URL_FROM_ENV.MAPS_ROUTER_URL = false;
    await globalSettingsStore.setSetting({ key: 'maps_router_url', value: 'https://osrm.example.com' });
    await expect(resolveMapsServerUrl({ deps, field: 'router' })).resolves.toBe('https://osrm.example.com');
    await globalSettingsStore.deleteSetting({ key: 'maps_router_url' });
    await expect(resolveMapsServerUrl({ deps, field: 'router' })).resolves.toBe('https://router.project-osrm.org');
  });

  it('ignores a saved address that is not usable and uses the default', async () => {
    const globalSettingsStore = await createStore();
    const deps = { globalSettingsStore, logger: silentLogger };
    configuration.MAPS_URL_FROM_ENV.MAPS_ROUTER_URL = false;
    await globalSettingsStore.setSetting({ key: 'maps_router_url', value: 'not a url' });
    await expect(resolveMapsServerUrl({ deps, field: 'router' })).resolves.toBe('https://router.project-osrm.org');
  });

  it('resolves every server in one call', async () => {
    const globalSettingsStore = await createStore();
    const deps = { globalSettingsStore, logger: silentLogger };
    await globalSettingsStore.setSetting({ key: 'maps_tile_url', value: 'https://tiles.example.com/{z}/{x}/{y}.png' });
    const servers = await resolveMapsServers(deps);
    expect(servers.tile_url).toBe('https://tiles.example.com/{z}/{x}/{y}.png');
    expect(servers.router_url).toBe(configuration.MAPS_ROUTER_URL);
    expect(servers.geocoder_url).toBe(configuration.MAPS_GEOCODER_URL);
  });
});

describe('mapsServerUrlProblem', () => {
  it('accepts https and plain http on a home network', () => {
    expect(mapsServerUrlProblem({ field: 'router', value: 'https://router.project-osrm.org' })).toBeNull();
    expect(mapsServerUrlProblem({ field: 'router', value: 'http://192.168.1.10:5000' })).toBeNull();
    expect(mapsServerUrlProblem({ field: 'router', value: 'http://osrm.home.lan' })).toBeNull();
  });

  it('rejects an address with another scheme, saying what to fix', () => {
    expect(mapsServerUrlProblem({ field: 'router', value: 'ftp://osrm.example.com' })).toBe(
      'The driving route address must start with http:// or https://.',
    );
  });

  it('rejects something that is not an address at all', () => {
    expect(mapsServerUrlProblem({ field: 'geocoder', value: 'down the road' })).toBe(
      'The address search address does not look like a complete web address. Check it and try again.',
    );
  });

  it('rejects a map pictures address without the placeholders, with the example from the brief', () => {
    expect(mapsServerUrlProblem({ field: 'tile', value: 'https://tile.example.org/tile.png' })).toBe(
      'The map pictures address needs {z}, {x} and {y} in it, like https://tile.example.org/{z}/{x}/{y}.png.',
    );
    expect(mapsServerUrlProblem({ field: 'tile', value: 'https://tile.example.org/{z}/{x}/{y}.png' })).toBeNull();
  });
});

const TEST_SERVERS: MapsServers = {
  router_url: 'https://router.example.com',
  walking_router_url: 'https://walking.example.com',
  cycling_router_url: 'https://cycling.example.com',
  geocoder_url: 'https://geocoder.example.com',
  transit_url: 'https://transit.example.com',
  tile_url: 'https://tiles.example.com/{z}/{x}/{y}.png',
};

function okFetch(url: string): Promise<Response> {
  if (url.includes('/route/')) {
    return Promise.resolve(
      new Response(JSON.stringify({ code: 'Ok', routes: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  if (url.includes('/0/0/0')) {
    return Promise.resolve(new Response('png', { status: 200, headers: { 'content-type': 'image/png' } }));
  }
  return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('testMapsServers', () => {
  it('reports ok for every service that answers', async () => {
    const results = await testMapsServers({ servers: TEST_SERVERS, fetchUpstream: okFetch });
    for (const field of ['router', 'walking', 'cycling', 'geocoder', 'transit', 'tile'] as const) {
      expect(results[field]).toEqual({ ok: true, message: null });
    }
  });

  it('reports each service separately when one does not answer', async () => {
    const results = await testMapsServers({
      servers: TEST_SERVERS,
      fetchUpstream: (url: string) =>
        url.startsWith('https://router.example.com') ? Promise.reject(new Error('connect ECONNREFUSED')) : okFetch(url),
    });
    expect(results.router).toEqual({
      ok: false,
      message: "The driving route server didn't answer. Check the address and that the server is running.",
    });
    expect(results.walking.ok).toBe(true);
    expect(results.geocoder.ok).toBe(true);
    expect(results.tile.ok).toBe(true);
  });

  it('treats a timed-out check as that service failing, not as a crash', async () => {
    const results = await testMapsServers({
      servers: TEST_SERVERS,
      fetchUpstream: (url: string) =>
        url.startsWith('https://geocoder.example.com')
          ? Promise.reject(new DOMException('The operation timed out', 'TimeoutError'))
          : okFetch(url),
    });
    expect(results.geocoder.ok).toBe(false);
    expect(results.geocoder.message).toContain("didn't answer");
    expect(results.router.ok).toBe(true);
  });

  it('does not call a route server ok when it answers without a route', async () => {
    const results = await testMapsServers({
      servers: TEST_SERVERS,
      fetchUpstream: (url: string) =>
        url.includes('/route/')
          ? Promise.resolve(
              new Response(JSON.stringify({ code: 'NoRoute' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            )
          : okFetch(url),
    });
    expect(results.router.ok).toBe(false);
    expect(results.walking.ok).toBe(false);
    expect(results.geocoder.ok).toBe(true);
  });

  it('sends the fixed test requests to the addresses in force', async () => {
    const seen: string[] = [];
    await testMapsServers({
      servers: TEST_SERVERS,
      fetchUpstream: (url: string) => {
        seen.push(url);
        return okFetch(url);
      },
    });
    expect(seen.some(url => url.startsWith('https://router.example.com/route/v1/driving/'))).toBe(true);
    expect(seen.some(url => url.startsWith('https://geocoder.example.com/search?q='))).toBe(true);
    expect(seen.some(url => url.startsWith('https://transit.example.com/plan?'))).toBe(true);
    expect(seen).toContain('https://tiles.example.com/0/0/0.png');
  });
});

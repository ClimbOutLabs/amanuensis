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
    expect(mapsServerUrlProblem({ field: 'router', value: 'http://osrm.local:5000' })).toBeNull();
  });

  it('rejects an address with another scheme, saying what to fix', () => {
    expect(mapsServerUrlProblem({ field: 'router', value: 'ftp://osrm.example.com' })).toBe(
      'The driving route address must start with http:// or https://.',
    );
  });

  it('rejects plain http away from this computer and the home network, saying what to use instead', () => {
    expect(mapsServerUrlProblem({ field: 'router', value: 'http://osrm.example.com' })).toBe(
      'The driving route address starts with http://, which is not encrypted. Plain http is only allowed for a server on this computer or your home network. Use the https:// address, or a home network address.',
    );
  });

  it('rejects an address with a user name or password in it', () => {
    expect(mapsServerUrlProblem({ field: 'router', value: 'https://user:secret@osrm.example.com' })).toBe(
      'The driving route address has a user name or password in it. Maps addresses cannot have one. Take it out and try again.',
    );
  });

  it('rejects an address with a query or a # part in it', () => {
    const message =
      'The address search address has a ? or # part in it. Maps addresses cannot have one. Take that part off and try again.';
    expect(mapsServerUrlProblem({ field: 'geocoder', value: 'https://geo.example.com/search?key=1' })).toBe(message);
    expect(mapsServerUrlProblem({ field: 'geocoder', value: 'https://geo.example.com/#frag' })).toBe(message);
  });

  it('rejects link-local and cloud metadata addresses over https as well as http', () => {
    const message =
      'The driving route address is a link-local or cloud metadata address. Those addresses belong to the network itself, so they cannot be a maps server. Check the address and try again.';
    expect(mapsServerUrlProblem({ field: 'router', value: 'http://169.254.169.254' })).toBe(message);
    expect(mapsServerUrlProblem({ field: 'router', value: 'https://169.254.169.254' })).toBe(message);
    expect(mapsServerUrlProblem({ field: 'router', value: 'https://metadata.google.internal' })).toBe(message);
    expect(mapsServerUrlProblem({ field: 'router', value: 'https://metadata' })).toBe(message);
    expect(mapsServerUrlProblem({ field: 'router', value: 'https://100.100.100.200' })).toBe(message);
    expect(mapsServerUrlProblem({ field: 'router', value: 'https://[::ffff:169.254.169.254]' })).toBe(message);
    expect(mapsServerUrlProblem({ field: 'router', value: 'https://metadata.example.com' })).toBeNull();
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
  if (url.includes('/plan')) {
    return Promise.resolve(
      new Response(JSON.stringify({ itineraries: [] }), {
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

  it('says the answer was the wrong kind when a server answers without a route', async () => {
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
    expect(results.router.message).toBe(
      'The driving route server answered, but not with a route. Check the address and try again.',
    );
    expect(results.geocoder.message).toBeNull();
  });

  it('names the error status when a server answers with one, instead of saying it did not answer', async () => {
    const results = await testMapsServers({
      servers: TEST_SERVERS,
      fetchUpstream: (url: string) =>
        url.startsWith('https://geocoder.example.com')
          ? Promise.resolve(new Response('not here', { status: 404 }))
          : okFetch(url),
    });
    expect(results.geocoder).toEqual({
      ok: false,
      message: 'The address search server answered with an error (HTTP 404). Check the address and try again.',
    });
    expect(results.router.ok).toBe(true);
  });

  it('does not call a route server ok when it answers with something that is not a routing answer', async () => {
    const results = await testMapsServers({
      servers: TEST_SERVERS,
      fetchUpstream: (url: string) =>
        url.includes('/route/')
          ? Promise.resolve(
              new Response(JSON.stringify({ hello: 'world' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            )
          : okFetch(url),
    });
    expect(results.router.ok).toBe(false);
    expect(results.walking.ok).toBe(false);
    expect(results.cycling.ok).toBe(false);
    expect(results.geocoder.ok).toBe(true);
    expect(results.transit.ok).toBe(true);
    expect(results.tile.ok).toBe(true);
  });

  it('does not call the address search ok when it answers with something that is not a list of places', async () => {
    const results = await testMapsServers({
      servers: TEST_SERVERS,
      fetchUpstream: (url: string) =>
        url.startsWith('https://geocoder.example.com')
          ? Promise.resolve(
              new Response(JSON.stringify({ results: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            )
          : okFetch(url),
    });
    expect(results.geocoder.ok).toBe(false);
    expect(results.router.ok).toBe(true);
  });

  it('does not call public transport ok when it answers without a journey plan', async () => {
    const results = await testMapsServers({
      servers: TEST_SERVERS,
      fetchUpstream: (url: string) =>
        url.includes('/plan')
          ? Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
          : okFetch(url),
    });
    expect(results.transit.ok).toBe(false);
    expect(results.router.ok).toBe(true);
  });

  it('does not call the map pictures ok when the answer has no picture type', async () => {
    const results = await testMapsServers({
      servers: TEST_SERVERS,
      fetchUpstream: (url: string) =>
        url.includes('/0/0/0')
          ? Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
          : okFetch(url),
    });
    expect(results.tile.ok).toBe(false);
    expect(results.tile.message).toBe(
      'The map pictures server answered, but not with a picture. Check the address and try again.',
    );
    expect(results.router.ok).toBe(true);
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

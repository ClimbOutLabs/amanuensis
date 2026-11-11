/**
 * The maps tools use the server addresses resolved for the answer: an address
 * saved in Settings is used by the next request, with no restart, and the
 * approval destination names the same hosts the calls go to.
 */
import type { FetchedPageScope } from '@truefoundry/trueforge-core/core';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger } from 'winston';

import configuration from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { mapsCapability } from '../../../src/runtime/mapsCapability';
import { encodePolyline } from '../../../src/runtime/mapsPolyline';
import { resolveMapsServers } from '../../../src/runtime/mapsSettings';

const PAGES_SCOPE: FetchedPageScope = { tenant_id: 'tenant-1', conversation_id: 'chat-a' };
const silentLogger = createLogger({ silent: true });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const FROM_PLACE = { lat: '38.7106', lon: '-9.1426', display_name: 'Travessa das Gaivotas 4, Lisboa' };
const TO_PLACE = { lat: '38.7142', lon: '-9.1597', display_name: 'R. de Sao Bernardo 92, Lisboa' };
const ROAD_BODY = {
  code: 'Ok',
  routes: [
    {
      distance: 1940.4,
      duration: 1421,
      geometry: encodePolyline([
        [38.7106, -9.1426],
        [38.7142, -9.1597],
      ]),
    },
  ],
};

async function createStore() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  return new SqliteGlobalSettingsStore(db);
}

const savedFromEnv = { ...configuration.MAPS_URL_FROM_ENV };

beforeEach(() => {
  configuration.MAPS_URL_FROM_ENV = { ...savedFromEnv };
});

afterEach(() => {
  configuration.MAPS_URL_FROM_ENV = { ...savedFromEnv };
  jest.restoreAllMocks();
});

async function callDrivingRoute(globalSettingsStore: SqliteGlobalSettingsStore): Promise<string[]> {
  const urls: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(input => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/search?')) {
      return Promise.resolve(jsonResponse([url.includes('Chiado') ? FROM_PLACE : TO_PLACE]));
    }
    return Promise.resolve(jsonResponse(ROAD_BODY));
  });
  // One capability per answer, resolved from the settings in force at its start.
  const servers = await resolveMapsServers({ globalSettingsStore, logger: silentLogger });
  const capability = mapsCapability({
    tracing: NOOP_AGENT_TRACING,
    logger: silentLogger,
    servers,
    pages_scope: PAGES_SCOPE,
    starts_answer: true,
    timezone: 'Europe/Lisbon',
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('maps capability has no tool sets');
  }
  const response = await toolSet.callTool({
    name: 'render_route',
    arguments: { from_place: 'Chiado', to_place: 'Estrela', mode: 'driving' },
  });
  if (!('result' in response) || response.result.isError === true) {
    throw new Error('render_route failed');
  }
  return urls;
}

describe('maps capability server addresses', () => {
  it('routes through the address saved in Settings', async () => {
    const globalSettingsStore = await createStore();
    await globalSettingsStore.setSetting({ key: 'maps_router_url', value: 'https://osrm.example.com' });
    const urls = await callDrivingRoute(globalSettingsStore);
    expect(urls.find(url => url.includes('/route/v1/'))).toContain('osrm.example.com/route/v1/driving/');
  });

  it('uses a changed address on the next request, without a restart', async () => {
    const globalSettingsStore = await createStore();
    await globalSettingsStore.setSetting({ key: 'maps_router_url', value: 'https://first.example.com' });
    const first = await callDrivingRoute(globalSettingsStore);
    expect(first.find(url => url.includes('/route/v1/'))).toContain('first.example.com');

    await globalSettingsStore.setSetting({ key: 'maps_router_url', value: 'https://second.example.com' });
    const second = await callDrivingRoute(globalSettingsStore);
    expect(second.find(url => url.includes('/route/v1/'))).toContain('second.example.com');
  });

  it('falls back to the default address when the saved one is cleared', async () => {
    const globalSettingsStore = await createStore();
    await globalSettingsStore.setSetting({ key: 'maps_router_url', value: 'https://osrm.example.com' });
    await globalSettingsStore.deleteSetting({ key: 'maps_router_url' });
    const urls = await callDrivingRoute(globalSettingsStore);
    expect(urls.find(url => url.includes('/route/v1/'))).toContain('router.project-osrm.org/route/v1/driving/');
  });

  it('names the saved hosts in the approval destination', async () => {
    const globalSettingsStore = await createStore();
    await globalSettingsStore.setSetting({ key: 'maps_router_url', value: 'https://osrm.example.com' });
    const servers = await resolveMapsServers({ globalSettingsStore, logger: silentLogger });
    const capability = mapsCapability({
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      servers,
      pages_scope: PAGES_SCOPE,
      starts_answer: true,
    });
    const binding = capability.systemToolSets?.[0]?.resolveConnector?.({
      name: 'render_route',
      arguments: { from_place: 'A', to_place: 'B', mode: 'driving' },
    });
    expect(binding?.destination_host).toContain('osrm.example.com');
  });
});

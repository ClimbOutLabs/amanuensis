/**
 * Maps server addresses an admin can change under Settings, Connectors, Maps.
 *
 * One helper decides which address wins for every maps call:
 * 1. the environment variable, when one is set (config.ts is the only place
 *    that reads the environment, and it says which values came from there);
 * 2. the value saved in Settings, stored in the global settings store;
 * 3. the built-in default.
 *
 * Callers look the address up on each call, so a saved change takes effect on
 * the next request with no restart.
 */
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import configuration, {
  MAPS_CYCLING_ROUTER_DEFAULT_URL,
  MAPS_GEOCODER_DEFAULT_URL,
  MAPS_ROUTER_DEFAULT_URL,
  MAPS_TILE_DEFAULT_URL,
  MAPS_TRANSIT_DEFAULT_URL,
  MAPS_WALKING_ROUTER_DEFAULT_URL,
} from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import {
  MAPS_SERVER_FIELDS,
  MAPS_SERVER_LABELS,
  mapsServerUrlProblem,
  type MapsServerField,
  type MapsServerTestResult,
} from '../schemas/mapsSettings';
import { fetchSameOrigin } from './mapsUpstream';

export { MAPS_SERVER_FIELDS, type MapsServerField };

/** The maps server addresses in force, one per service. */
export interface MapsServers {
  router_url: string;
  walking_router_url: string;
  cycling_router_url: string;
  geocoder_url: string;
  transit_url: string;
  tile_url: string;
}

interface MapsServerFieldSpec {
  field: MapsServerField;
  /** Global settings key and wire field name; the two are the same by design. */
  key: string;
  defaultUrl: string;
  configUrl: () => string;
  fromEnv: () => boolean;
  serversKey: keyof MapsServers;
}

const MAPS_SERVER_FIELD_SPECS: readonly MapsServerFieldSpec[] = [
  {
    field: 'router',
    key: 'maps_router_url',
    defaultUrl: MAPS_ROUTER_DEFAULT_URL,
    configUrl: () => configuration.MAPS_ROUTER_URL,
    fromEnv: () => configuration.MAPS_URL_FROM_ENV.MAPS_ROUTER_URL,
    serversKey: 'router_url',
  },
  {
    field: 'walking',
    key: 'maps_walking_router_url',
    defaultUrl: MAPS_WALKING_ROUTER_DEFAULT_URL,
    configUrl: () => configuration.MAPS_WALKING_ROUTER_URL,
    fromEnv: () => configuration.MAPS_URL_FROM_ENV.MAPS_WALKING_ROUTER_URL,
    serversKey: 'walking_router_url',
  },
  {
    field: 'cycling',
    key: 'maps_cycling_router_url',
    defaultUrl: MAPS_CYCLING_ROUTER_DEFAULT_URL,
    configUrl: () => configuration.MAPS_CYCLING_ROUTER_URL,
    fromEnv: () => configuration.MAPS_URL_FROM_ENV.MAPS_CYCLING_ROUTER_URL,
    serversKey: 'cycling_router_url',
  },
  {
    field: 'geocoder',
    key: 'maps_geocoder_url',
    defaultUrl: MAPS_GEOCODER_DEFAULT_URL,
    configUrl: () => configuration.MAPS_GEOCODER_URL,
    fromEnv: () => configuration.MAPS_URL_FROM_ENV.MAPS_GEOCODER_URL,
    serversKey: 'geocoder_url',
  },
  {
    field: 'transit',
    key: 'maps_transit_url',
    defaultUrl: MAPS_TRANSIT_DEFAULT_URL,
    configUrl: () => configuration.MAPS_TRANSIT_URL,
    fromEnv: () => configuration.MAPS_URL_FROM_ENV.MAPS_TRANSIT_URL,
    serversKey: 'transit_url',
  },
  {
    field: 'tile',
    key: 'maps_tile_url',
    defaultUrl: MAPS_TILE_DEFAULT_URL,
    configUrl: () => configuration.MAPS_TILE_URL,
    fromEnv: () => configuration.MAPS_URL_FROM_ENV.MAPS_TILE_URL,
    serversKey: 'tile_url',
  },
];

const SPEC_BY_FIELD: ReadonlyMap<MapsServerField, MapsServerFieldSpec> = new Map(
  MAPS_SERVER_FIELD_SPECS.map(spec => [spec.field, spec]),
);

function specFor(field: MapsServerField): MapsServerFieldSpec {
  const spec = SPEC_BY_FIELD.get(field);
  if (spec === undefined) {
    throw new Error(`Unknown maps server field: ${field}`);
  }
  return spec;
}

/** The global settings key a field is saved under, for example `maps_router_url`. */
export function mapsServerSettingKey(field: MapsServerField): string {
  return specFor(field).key;
}

/** The plain name of a field's server, for messages, for example `driving route`. */
export function mapsServerLabel(field: MapsServerField): string {
  return MAPS_SERVER_LABELS[field];
}

/** The built-in default address for a field. */
export function mapsServerDefaultUrl(field: MapsServerField): string {
  return specFor(field).defaultUrl;
}

/** The saved form of an address: trimmed, with no trailing slash, as config keeps its own values. */
export function normalizeMapsServerUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith('/') && trimmed.length > 1 ? trimmed.slice(0, -1) : trimmed;
}

export interface MapsSettingsDeps {
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}

/**
 * The saved address for one field, or null when none is saved. A stored value
 * that no longer passes validation reads as unset, and a store read failure
 * also reads as unset: maps keep working on the environment value or the
 * default rather than failing because the settings table could not be read.
 */
async function readSavedMapsServerUrl({
  deps,
  spec,
}: {
  deps: MapsSettingsDeps;
  spec: MapsServerFieldSpec;
}): Promise<string | null> {
  let record;
  try {
    record = await deps.globalSettingsStore.getSetting({ key: spec.key });
  } catch (error) {
    deps.logger.warn(
      'Saved maps server address could not be read; using the environment value or the default',
      extractErrorLogFields(error),
    );
    return null;
  }
  if (record === undefined) {
    return null;
  }
  const value = normalizeMapsServerUrl(record.value);
  if (mapsServerUrlProblem({ field: spec.field, value }) !== null) {
    deps.logger.warn('Ignoring a saved maps server address that is not usable', { key: spec.key });
    return null;
  }
  return value;
}

/**
 * The address one maps service uses right now: the environment value when the
 * environment sets one, else the value saved in Settings, else the default.
 * This is the only place that decides which value wins.
 */
export async function resolveMapsServerUrl({
  deps,
  field,
}: {
  deps: MapsSettingsDeps;
  field: MapsServerField;
}): Promise<string> {
  const spec = specFor(field);
  if (spec.fromEnv()) {
    return spec.configUrl();
  }
  const saved = await readSavedMapsServerUrl({ deps, spec });
  return saved ?? spec.configUrl();
}

/** Every maps server address in force right now, resolved by the same rules. */
export async function resolveMapsServers(deps: MapsSettingsDeps): Promise<MapsServers> {
  const urls = await Promise.all(
    MAPS_SERVER_FIELD_SPECS.map(async spec => ({ spec, url: await resolveMapsServerUrl({ deps, field: spec.field }) })),
  );
  const servers: MapsServers = {
    router_url: '',
    walking_router_url: '',
    cycling_router_url: '',
    geocoder_url: '',
    transit_url: '',
    tile_url: '',
  };
  for (const { spec, url } of urls) {
    servers[spec.serversKey] = url;
  }
  return servers;
}

/** One field as the Settings card shows it, before it is put in wire shape. */
export interface MapsServerFieldDisplay {
  /** The environment address when the environment sets one, else the saved address, else null. */
  value: string | null;
  defaultUrl: string;
  setByEnvironment: boolean;
}

/**
 * What the Settings card shows for every field: the address in the box, the
 * default as its placeholder, and whether the environment owns the field.
 */
export async function readMapsSettingsState(
  deps: MapsSettingsDeps,
): Promise<Record<MapsServerField, MapsServerFieldDisplay>> {
  const displayFor = async (field: MapsServerField): Promise<MapsServerFieldDisplay> => {
    const spec = specFor(field);
    if (spec.fromEnv()) {
      return { value: spec.configUrl(), defaultUrl: spec.defaultUrl, setByEnvironment: true };
    }
    const saved = await readSavedMapsServerUrl({ deps, spec });
    return { value: saved, defaultUrl: spec.defaultUrl, setByEnvironment: false };
  };
  const [router, walking, cycling, geocoder, transit, tile] = await Promise.all(MAPS_SERVER_FIELDS.map(displayFor));
  return { router, walking, cycling, geocoder, transit, tile };
}

const TEST_TIMEOUT_MS = 5000;
/** Two nearby points any routing or transit server should answer for. */
const TEST_FROM = { lng: -0.1276, lat: 51.5072 };
const TEST_TO = { lng: -0.126, lat: 51.509 };
const TEST_ADDRESS = '10 Downing Street, London';

/** The upstream fetch the connection test uses; injectable so tests never touch the network. */
export type MapsFetch = (url: string) => Promise<Response>;

function defaultMapsFetch(url: string): Promise<Response> {
  return fetchSameOrigin({
    url,
    headers: { 'User-Agent': configuration.MAPS_USER_AGENT, Accept: 'application/json' },
    timeoutMs: TEST_TIMEOUT_MS,
  });
}

async function probeRouteServer({ baseUrl, fetchUpstream }: { baseUrl: string; fetchUpstream: MapsFetch }) {
  const url =
    `${baseUrl}/route/v1/driving/${String(TEST_FROM.lng)},${String(TEST_FROM.lat)};` +
    `${String(TEST_TO.lng)},${String(TEST_TO.lat)}?overview=false`;
  const response = await fetchUpstream(url);
  if (!response.ok) {
    throw new Error(`route server answered HTTP ${String(response.status)}`);
  }
  // A page that is not a routing answer at all (an error page served with a
  // 200, say) must not read as a working route server.
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body === 'object' && body !== null && 'code' in body && body.code !== 'Ok') {
    throw new Error('route server answered without a route');
  }
}

async function probeGeocoder({ baseUrl, fetchUpstream }: { baseUrl: string; fetchUpstream: MapsFetch }) {
  const url = `${baseUrl}/search?q=${encodeURIComponent(TEST_ADDRESS)}&format=jsonv2&limit=1`;
  const response = await fetchUpstream(url);
  if (!response.ok) {
    throw new Error(`address search server answered HTTP ${String(response.status)}`);
  }
}

async function probeTransit({ baseUrl, fetchUpstream }: { baseUrl: string; fetchUpstream: MapsFetch }) {
  const query = new URLSearchParams({
    fromPlace: `${String(TEST_FROM.lat)},${String(TEST_FROM.lng)}`,
    toPlace: `${String(TEST_TO.lat)},${String(TEST_TO.lng)}`,
  });
  const response = await fetchUpstream(`${baseUrl}/plan?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`public transport server answered HTTP ${String(response.status)}`);
  }
}

async function probeTileServer({ baseUrl, fetchUpstream }: { baseUrl: string; fetchUpstream: MapsFetch }) {
  const url = baseUrl.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
  const response = await fetchUpstream(url);
  if (!response.ok) {
    throw new Error(`map pictures server answered HTTP ${String(response.status)}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType !== '' && !contentType.toLowerCase().startsWith('image/')) {
    throw new Error('map pictures server answered with something that is not a picture');
  }
}

const PROBES: Record<MapsServerField, (input: { baseUrl: string; fetchUpstream: MapsFetch }) => Promise<void>> = {
  router: probeRouteServer,
  walking: probeRouteServer,
  cycling: probeRouteServer,
  geocoder: probeGeocoder,
  transit: probeTransit,
  tile: probeTileServer,
};

/**
 * Tries each maps server once, the way the Test connections button does: a
 * short fixed route for the route servers, one fixed address for the address
 * search, one plan for public transport, one tile for the map pictures. Each
 * check times out after 5 seconds and reports on its own.
 */
export async function testMapsServers({
  servers,
  fetchUpstream = defaultMapsFetch,
}: {
  servers: MapsServers;
  fetchUpstream?: MapsFetch;
}): Promise<Record<MapsServerField, MapsServerTestResult>> {
  const resultFor = async (field: MapsServerField): Promise<MapsServerTestResult> => {
    const spec = specFor(field);
    try {
      await PROBES[field]({ baseUrl: servers[spec.serversKey], fetchUpstream });
      return { ok: true, message: null };
    } catch {
      return {
        ok: false,
        message: `The ${MAPS_SERVER_LABELS[field]} server didn't answer. Check the address and that the server is running.`,
      };
    }
  };
  const [router, walking, cycling, geocoder, transit, tile] = await Promise.all(MAPS_SERVER_FIELDS.map(resultFor));
  return { router, walking, cycling, geocoder, transit, tile };
}

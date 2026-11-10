import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

import {
  MapsSettingsSaveRefused,
  type MapsServerFieldId,
  type MapsServerFieldState,
  type MapsSettingsFieldProblems,
  type MapsSettingsState,
  type MapsSettingsTestResults,
  type MapsSettingsUpdate,
  type MapsSetupPort,
} from '../../../server/mapsSetup.js';

/**
 * Maps the maps server port onto the generated SDK client for the maps
 * settings routes. The server is the one judge of an address: this adapter
 * sends what the person typed, and when the server refuses a save it turns
 * the refusal into the problem for each field, so the card shows the message
 * under the field it belongs to.
 */

/** Each card field with its SDK property name and the wire field name the server names it by in a refusal. */
const FIELD_KEYS: readonly { field: MapsServerFieldId; sdk: keyof TrueForgeApi.MapsSettings; wire: string }[] = [
  { field: 'router', sdk: 'mapsRouterUrl', wire: 'maps_router_url' },
  { field: 'walking', sdk: 'mapsWalkingRouterUrl', wire: 'maps_walking_router_url' },
  { field: 'cycling', sdk: 'mapsCyclingRouterUrl', wire: 'maps_cycling_router_url' },
  { field: 'geocoder', sdk: 'mapsGeocoderUrl', wire: 'maps_geocoder_url' },
  { field: 'transit', sdk: 'mapsTransitUrl', wire: 'maps_transit_url' },
  { field: 'tile', sdk: 'mapsTileUrl', wire: 'maps_tile_url' },
];

const FIELD_BY_WIRE_KEY: ReadonlyMap<string, MapsServerFieldId> = new Map(
  FIELD_KEYS.map(({ field, wire }) => [wire, field]),
);

function toFieldState(field: TrueForgeApi.MapsServerFieldState): MapsServerFieldState {
  return { value: field.value, defaultUrl: field.defaultValue, setByEnvironment: field.setByEnvironment };
}

function toMapsSettingsState(settings: TrueForgeApi.MapsSettings): MapsSettingsState {
  return {
    router: toFieldState(settings.mapsRouterUrl),
    walking: toFieldState(settings.mapsWalkingRouterUrl),
    cycling: toFieldState(settings.mapsCyclingRouterUrl),
    geocoder: toFieldState(settings.mapsGeocoderUrl),
    transit: toFieldState(settings.mapsTransitUrl),
    tile: toFieldState(settings.mapsTileUrl),
  };
}

function toTestResults(test: TrueForgeApi.MapsSettingsTest): MapsSettingsTestResults {
  return {
    router: test.mapsRouterUrl,
    walking: test.mapsWalkingRouterUrl,
    cycling: test.mapsCyclingRouterUrl,
    geocoder: test.mapsGeocoderUrl,
    transit: test.mapsTransitUrl,
    tile: test.mapsTileUrl,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The HTTP status the SDK puts on the errors it throws, when it threw one of those. */
function readHttpStatus(error: unknown): number | undefined {
  if (!isRecord(error) || !('statusCode' in error)) {
    return undefined;
  }
  const statusCode: unknown = error.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/** The server's own message from an SDK error body, when the body carries one. */
function readServerMessage(error: unknown): string | undefined {
  if (!isRecord(error) || !isRecord(error.body) || !isRecord(error.body.error)) {
    return undefined;
  }
  const message: unknown = error.body.error.message;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

/**
 * The per-field problems from a refused save. The server answers a refused
 * save with a 400 whose message lists one problem per field, each naming the
 * wire field it belongs to. Anything that does not read that way is not a
 * per-field refusal and gives null here.
 */
function fieldProblemsFromRefusal(error: unknown): MapsSettingsFieldProblems | null {
  if (readHttpStatus(error) !== 400) {
    return null;
  }
  const message = readServerMessage(error);
  if (message === undefined) {
    return null;
  }
  let issues: unknown;
  try {
    issues = JSON.parse(message);
  } catch {
    return null;
  }
  if (!Array.isArray(issues)) {
    return null;
  }
  const problems: MapsSettingsFieldProblems = {};
  for (const issue of issues) {
    if (!isRecord(issue)) {
      continue;
    }
    const path: unknown = issue.path;
    const text: unknown = issue.message;
    if (!Array.isArray(path) || typeof path[0] !== 'string' || typeof text !== 'string') {
      continue;
    }
    const field = FIELD_BY_WIRE_KEY.get(path[0]);
    if (field !== undefined && problems[field] === undefined) {
      problems[field] = text;
    }
  }
  return Object.keys(problems).length > 0 ? problems : null;
}

/** The error a failed call reports: the server's own message when it sent one. */
function toPortError(error: unknown): Error {
  const message = readServerMessage(error);
  if (message !== undefined) {
    return new Error(message, { cause: error });
  }
  const status = readHttpStatus(error);
  if (status !== undefined) {
    return new Error(`Maps settings failed with HTTP ${String(status)}`, { cause: error });
  }
  return error instanceof Error ? error : new Error('Maps settings failed', { cause: error });
}

export function createMapsSetupApi(client: TrueForge): MapsSetupPort {
  return {
    getMapsSettings: async () => {
      try {
        const response = await client.settings.maps.get();
        return toMapsSettingsState(response.data);
      } catch (error) {
        throw toPortError(error);
      }
    },
    updateMapsSettings: async (update: MapsSettingsUpdate) => {
      const request: TrueForgeApi.settings.MapsServerSettings = {};
      for (const { field, sdk } of FIELD_KEYS) {
        const value = update[field];
        if (value !== undefined) {
          request[sdk] = value;
        }
      }
      try {
        const response = await client.settings.maps.createOrUpdate(request);
        return toMapsSettingsState(response.data);
      } catch (error) {
        const problems = fieldProblemsFromRefusal(error);
        if (problems !== null) {
          throw new MapsSettingsSaveRefused(problems);
        }
        if (readHttpStatus(error) === 400) {
          // A refusal whose problems could not be read: never show the raw
          // validation text, say in plain words that the save was refused.
          throw new Error('The maps addresses could not be saved. Check them and try again.', { cause: error });
        }
        throw toPortError(error);
      }
    },
    testMapsSettings: async () => {
      try {
        const response = await client.settings.maps.test();
        return toTestResults(response.data);
      } catch (error) {
        throw toPortError(error);
      }
    },
  };
}

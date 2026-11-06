import { z } from 'zod';

import {
  MAPS_SERVER_FIELD_IDS,
  type MapsServerFieldId,
  type MapsSettingsState,
  type MapsSettingsTestResults,
  type MapsSettingsUpdate,
  type MapsSetupPort,
} from '../../../server/mapsSetup.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

/**
 * Maps the maps server port onto the server's admin settings routes. Direct
 * fetch rather than the generated SDK client, which does not carry these
 * routes yet; the same base URL, token, and fetch the client was built from
 * are used, so cookie auth rides along on the default same-origin base URL.
 */

const MapsServerFieldStateWireSchema = z.object({
  value: z.string().nullable(),
  default_value: z.string(),
  set_by_environment: z.boolean(),
});

const MapsSettingsWireSchema = z.object({
  maps_router_url: MapsServerFieldStateWireSchema,
  maps_walking_router_url: MapsServerFieldStateWireSchema,
  maps_cycling_router_url: MapsServerFieldStateWireSchema,
  maps_geocoder_url: MapsServerFieldStateWireSchema,
  maps_transit_url: MapsServerFieldStateWireSchema,
  maps_tile_url: MapsServerFieldStateWireSchema,
});

const MapsSettingsResponseSchema = z.object({ data: MapsSettingsWireSchema });

const MapsServerTestResultWireSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable(),
});

const MapsSettingsTestResponseSchema = z.object({
  data: z.object({
    maps_router_url: MapsServerTestResultWireSchema,
    maps_walking_router_url: MapsServerTestResultWireSchema,
    maps_cycling_router_url: MapsServerTestResultWireSchema,
    maps_geocoder_url: MapsServerTestResultWireSchema,
    maps_transit_url: MapsServerTestResultWireSchema,
    maps_tile_url: MapsServerTestResultWireSchema,
  }),
});

const WIRE_KEY_BY_FIELD: Record<MapsServerFieldId, string> = {
  router: 'maps_router_url',
  walking: 'maps_walking_router_url',
  cycling: 'maps_cycling_router_url',
  geocoder: 'maps_geocoder_url',
  transit: 'maps_transit_url',
  tile: 'maps_tile_url',
};

type MapsSettingsWire = z.infer<typeof MapsSettingsWireSchema>;

function toMapsSettings(wire: MapsSettingsWire): MapsSettingsState {
  const field = (wireField: z.infer<typeof MapsServerFieldStateWireSchema>) => ({
    value: wireField.value,
    defaultUrl: wireField.default_value,
    setByEnvironment: wireField.set_by_environment,
  });
  return {
    router: field(wire.maps_router_url),
    walking: field(wire.maps_walking_router_url),
    cycling: field(wire.maps_cycling_router_url),
    geocoder: field(wire.maps_geocoder_url),
    transit: field(wire.maps_transit_url),
    tile: field(wire.maps_tile_url),
  };
}

export function createMapsSetupApi(options: CreateTrueForgeClientOptions = {}): MapsSetupPort {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request({ method, path, body }: { method: string; path: string; body?: unknown }): Promise<unknown> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(responseBody);
      throw new Error(
        failure.success ? failure.data.error.message : `Maps settings failed with HTTP ${String(response.status)}`,
      );
    }
    return responseBody;
  }

  return {
    getMapsSettings: async () => {
      const parsed = MapsSettingsResponseSchema.safeParse(
        await request({ method: 'GET', path: '/api/v1/settings/maps' }),
      );
      if (!parsed.success) {
        throw new Error('The server returned an unexpected maps settings payload');
      }
      return toMapsSettings(parsed.data.data);
    },
    updateMapsSettings: async (update: MapsSettingsUpdate) => {
      const body: Record<string, string | null> = {};
      for (const fieldId of MAPS_SERVER_FIELD_IDS) {
        const value = update[fieldId];
        if (value !== undefined) {
          body[WIRE_KEY_BY_FIELD[fieldId]] = value;
        }
      }
      const parsed = MapsSettingsResponseSchema.safeParse(
        await request({ method: 'PUT', path: '/api/v1/settings/maps', body }),
      );
      if (!parsed.success) {
        throw new Error('The server returned an unexpected maps settings payload');
      }
      return toMapsSettings(parsed.data.data);
    },
    testMapsSettings: async () => {
      const parsed = MapsSettingsTestResponseSchema.safeParse(
        await request({ method: 'POST', path: '/api/v1/settings/maps/test', body: {} }),
      );
      if (!parsed.success) {
        throw new Error('The server returned an unexpected maps test payload');
      }
      const data = parsed.data.data;
      return {
        router: data.maps_router_url,
        walking: data.maps_walking_router_url,
        cycling: data.maps_cycling_router_url,
        geocoder: data.maps_geocoder_url,
        transit: data.maps_transit_url,
        tile: data.maps_tile_url,
      } satisfies MapsSettingsTestResults;
    },
  };
}

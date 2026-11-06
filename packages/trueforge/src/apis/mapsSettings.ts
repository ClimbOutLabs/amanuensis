import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { getMapsSettingsRoute, putMapsSettingsRoute, testMapsSettingsRoute } from '../routes/mapsSettingsRoutes';
import {
  mapsServerSettingKey,
  normalizeMapsServerUrl,
  readMapsSettingsState,
  resolveMapsServers,
  testMapsServers,
  type MapsFetch,
  type MapsServerFieldDisplay,
} from '../runtime/mapsSettings';
import type { MapsServerFieldState, MapsServerSettings, MapsSettings, MapsSettingsTest } from '../schemas/mapsSettings';
import { MAPS_SERVER_FIELDS, type MapsServerField } from '../schemas/mapsSettings';

export interface MapsSettingsRouterDeps<TTransaction> {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  logger: Logger;
  /** Upstream fetch for the connection test; the real one is used when this is absent. */
  testFetchUpstream?: MapsFetch;
}

const WIRE_KEY_BY_FIELD: Record<MapsServerField, keyof MapsServerSettings> = {
  router: 'maps_router_url',
  walking: 'maps_walking_router_url',
  cycling: 'maps_cycling_router_url',
  geocoder: 'maps_geocoder_url',
  transit: 'maps_transit_url',
  tile: 'maps_tile_url',
};

function toWireFieldState(display: MapsServerFieldDisplay): MapsServerFieldState {
  return {
    value: display.value,
    default_value: display.defaultUrl,
    set_by_environment: display.setByEnvironment,
  };
}

function toWireSettings(state: Record<MapsServerField, MapsServerFieldDisplay>): MapsSettings {
  return {
    maps_router_url: toWireFieldState(state.router),
    maps_walking_router_url: toWireFieldState(state.walking),
    maps_cycling_router_url: toWireFieldState(state.cycling),
    maps_geocoder_url: toWireFieldState(state.geocoder),
    maps_transit_url: toWireFieldState(state.transit),
    maps_tile_url: toWireFieldState(state.tile),
  };
}

/**
 * Admin/settings maps server surface (mounted at /api/v1/settings/maps). The
 * addresses are instance settings: the environment wins where it sets one,
 * then the value saved here, then the built-in default.
 */
export function createMapsSettingsRouter<TTransaction>(deps: MapsSettingsRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();
  const settingsDeps = { globalSettingsStore: deps.globalSettingsStore, logger: deps.logger };

  const getHandler: RouteHandler<typeof getMapsSettingsRoute> = async c => {
    const state = await readMapsSettingsState(settingsDeps);
    return c.json({ data: toWireSettings(state) }, 200);
  };

  const putHandler: RouteHandler<typeof putMapsSettingsRoute> = async c => {
    const body: MapsServerSettings = c.req.valid('json');
    const before = await readMapsSettingsState(settingsDeps);
    const after: Record<MapsServerField, MapsServerFieldDisplay> = { ...before };
    for (const field of MAPS_SERVER_FIELDS) {
      const value = body[WIRE_KEY_BY_FIELD[field]];
      if (value === undefined) {
        continue;
      }
      const key = mapsServerSettingKey(field);
      if (value === null) {
        await deps.globalSettingsStore.deleteSetting({ key });
      } else {
        await deps.globalSettingsStore.setSetting({ key, value: normalizeMapsServerUrl(value) });
      }
      // The write above committed, so the response is built from it rather than
      // re-read: a transient read failure must not report a state that
      // contradicts the address just saved. Environment fields never change.
      if (!before[field].setByEnvironment) {
        after[field] = {
          ...before[field],
          value: value === null ? null : normalizeMapsServerUrl(value),
        };
      }
    }
    return c.json({ data: toWireSettings(after) }, 200);
  };

  const testHandler: RouteHandler<typeof testMapsSettingsRoute> = async c => {
    const servers = await resolveMapsServers(settingsDeps);
    const results = await testMapsServers({
      servers,
      ...(deps.testFetchUpstream === undefined ? {} : { fetchUpstream: deps.testFetchUpstream }),
    });
    const data: MapsSettingsTest = {
      maps_router_url: results.router,
      maps_walking_router_url: results.walking,
      maps_cycling_router_url: results.cycling,
      maps_geocoder_url: results.geocoder,
      maps_transit_url: results.transit,
      maps_tile_url: results.tile,
    };
    return c.json({ data }, 200);
  };

  router.openapi(getMapsSettingsRoute, getHandler);
  router.openapi(putMapsSettingsRoute, putHandler);
  router.openapi(testMapsSettingsRoute, testHandler);
  return router;
}

import { describe, expect, it } from 'vitest';

import { createMapsSetupApi } from '@/plugins/trueforge-agent-server-adapter/catalogs/mapsSetup.js';

function fieldState(value: string | null, setByEnvironment = false) {
  return {
    value,
    default_value: 'https://router.project-osrm.org',
    set_by_environment: setByEnvironment,
  };
}

const SETTINGS_BODY = {
  data: {
    maps_router_url: fieldState('https://osrm.example.com'),
    maps_walking_router_url: fieldState(null),
    maps_cycling_router_url: fieldState(null),
    maps_geocoder_url: fieldState('https://env.example.com', true),
    maps_transit_url: fieldState(null),
    maps_tile_url: fieldState(null),
  },
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Seen = { url: string; method: string; body: string | undefined };

function apiWith(handler: (seen: Seen) => Promise<Response>) {
  const seen: Seen[] = [];
  const api = createMapsSetupApi({
    baseUrl: 'http://harness.test',
    fetch: async (input, init) => {
      const entry: Seen = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      seen.push(entry);
      return handler(entry);
    },
  });
  return { api, seen };
}

describe('maps setup api', () => {
  it('reads the settings and maps the wire fields', async () => {
    const { api, seen } = apiWith(async () => reply(SETTINGS_BODY));
    const state = await api.getMapsSettings();
    expect(seen[0]?.url).toBe('http://harness.test/api/v1/settings/maps');
    expect(seen[0]?.method).toBe('GET');
    expect(state.router).toEqual({
      value: 'https://osrm.example.com',
      defaultUrl: 'https://router.project-osrm.org',
      setByEnvironment: false,
    });
    expect(state.geocoder.setByEnvironment).toBe(true);
    expect(state.tile.value).toBeNull();
  });

  it('sends only the fields being changed, with null for a clear', async () => {
    const { api, seen } = apiWith(async () => reply(SETTINGS_BODY));
    await api.updateMapsSettings({ router: 'https://new.example.com', tile: null });
    expect(seen[0]?.method).toBe('PUT');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      maps_router_url: 'https://new.example.com',
      maps_tile_url: null,
    });
  });

  it('maps the per-service test results', async () => {
    const { api, seen } = apiWith(async () =>
      reply({
        data: {
          maps_router_url: { ok: true, message: null },
          maps_walking_router_url: { ok: true, message: null },
          maps_cycling_router_url: { ok: false, message: 'The cycling route server did not answer.' },
          maps_geocoder_url: { ok: true, message: null },
          maps_transit_url: { ok: true, message: null },
          maps_tile_url: { ok: true, message: null },
        },
      }),
    );
    const results = await api.testMapsSettings();
    expect(seen[0]?.url).toBe('http://harness.test/api/v1/settings/maps/test');
    expect(seen[0]?.method).toBe('POST');
    expect(results.router.ok).toBe(true);
    expect(results.cycling).toEqual({ ok: false, message: 'The cycling route server did not answer.' });
  });

  it('surfaces the server error message when a call fails', async () => {
    const { api } = apiWith(async () => reply({ error: { message: 'Admin access required.' } }, 403));
    await expect(api.getMapsSettings()).rejects.toThrow('Admin access required.');
  });
});

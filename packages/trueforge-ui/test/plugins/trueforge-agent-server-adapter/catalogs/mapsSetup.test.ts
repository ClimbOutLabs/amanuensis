import { TrueForge } from '@truefoundry/trueforge-sdk';
import { describe, expect, it } from 'vitest';

import { createMapsSetupApi } from '@/plugins/trueforge-agent-server-adapter/catalogs/mapsSetup.js';
import { MapsSettingsSaveRefused } from '@/server/mapsSetup.js';

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
  const fetchImpl: typeof fetch = async (input, init) => {
    const entry: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    seen.push(entry);
    return handler(entry);
  };
  const api = createMapsSetupApi(new TrueForge({ baseUrl: 'http://harness.test', maxRetries: 0, fetch: fetchImpl }));
  return { api, seen };
}

/** The body the server answers a refused save with: one problem per field, each naming its wire field. */
function refusalBody(problems: { field: string; message: string }[]): unknown {
  return {
    success: false,
    error: {
      name: 'ZodError',
      message: JSON.stringify(problems.map(({ field, message }) => ({ code: 'custom', message, path: [field] }))),
    },
  };
}

describe('maps setup api', () => {
  it('reads the settings through the SDK client and maps the wire fields', async () => {
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

  it('turns a refused save into the problem for each field the server named', async () => {
    const message =
      'The driving route address is a link-local or cloud metadata address. Those addresses belong to the network itself, so they cannot be a maps server. Check the address and try again.';
    const { api } = apiWith(async () => reply(refusalBody([{ field: 'maps_router_url', message }]), 400));
    // This address is the IPv4-mapped form of the cloud metadata address.
    const refused = api.updateMapsSettings({ router: 'https://[::ffff:169.254.169.254]' });
    await expect(refused).rejects.toBeInstanceOf(MapsSettingsSaveRefused);
    await expect(refused).rejects.toMatchObject({ problems: { router: message } });
  });

  it('names each refused field separately when a save has more than one problem', async () => {
    const { api } = apiWith(async () =>
      reply(
        refusalBody([
          { field: 'maps_router_url', message: 'The driving route address must start with http:// or https://.' },
          {
            field: 'maps_tile_url',
            message:
              'The map pictures address needs {z}, {x} and {y} in it, like https://tile.example.org/{z}/{x}/{y}.png.',
          },
        ]),
        400,
      ),
    );
    const refused = api.updateMapsSettings({
      router: 'ftp://osrm.example.com',
      tile: 'https://tile.example.org/tile.png',
    });
    await expect(refused).rejects.toMatchObject({
      problems: {
        router: 'The driving route address must start with http:// or https://.',
        tile: 'The map pictures address needs {z}, {x} and {y} in it, like https://tile.example.org/{z}/{x}/{y}.png.',
      },
    });
  });

  it('never surfaces the raw validation text when a refusal cannot be read per field', async () => {
    const { api } = apiWith(async () => reply({ error: { message: 'some raw validation text' } }, 400));
    await expect(api.updateMapsSettings({ router: 'https://osrm.example.com' })).rejects.toThrow(
      'The maps addresses could not be saved. Check them and try again.',
    );
  });
});

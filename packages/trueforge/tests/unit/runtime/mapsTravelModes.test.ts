import { MapsRouteResultSchema, type FetchedPageScope } from '@truefoundry/trueforge-core/core';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger } from 'winston';
import { mapsCapability } from '../../../src/runtime/mapsCapability';
import { encodePolyline } from '../../../src/runtime/mapsPolyline';

const PAGES_SCOPE: FetchedPageScope = { tenant_id: 'tenant-1', conversation_id: 'chat-a' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CHIADO = { lat: '38.7106', lon: '-9.1426', display_name: 'Rua da Emenda 45, Lisboa' };
const ESTRELA = { lat: '38.7142', lon: '-9.1597', display_name: 'R. de Sao Bernardo 92, Lisboa' };

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

const TRANSIT_BODY = {
  itineraries: [
    {
      startTime: '2026-10-19T08:00:00Z',
      endTime: '2026-10-19T08:20:00Z',
      transfers: 0,
      legs: [
        {
          mode: 'WALK',
          from: { name: 'START', lat: 38.7106, lon: -9.1426, tz: 'Europe/Lisbon' },
          to: { name: 'Calhariz (Bica)', lat: 38.7105, lon: -9.1425, tz: 'Europe/Lisbon' },
          startTime: '2026-10-19T08:00:00Z',
          endTime: '2026-10-19T08:04:00Z',
        },
        {
          mode: 'TRAM',
          routeShortName: '28E',
          headsign: 'Campo Ourique',
          from: { name: 'Calhariz (Bica)', lat: 38.7105, lon: -9.1425, tz: 'Europe/Lisbon' },
          to: { name: 'Estrela', lat: 38.7141, lon: -9.1595, tz: 'Europe/Lisbon' },
          startTime: '2026-10-19T08:06:00Z',
          endTime: '2026-10-19T08:17:00Z',
          intermediateStops: [{}, {}, {}, {}, {}],
        },
        {
          mode: 'WALK',
          from: { name: 'Estrela', lat: 38.7141, lon: -9.1595, tz: 'Europe/Lisbon' },
          to: { name: 'END', lat: 38.7142, lon: -9.1597, tz: 'Europe/Lisbon' },
          startTime: '2026-10-19T08:17:00Z',
          endTime: '2026-10-19T08:20:00Z',
        },
      ],
    },
  ],
};

interface Harness {
  call: (args: Record<string, unknown>) => Promise<{ body: Record<string, unknown>; isError: boolean }>;
  urls: string[];
}

function harness(options: { transit?: unknown; road?: unknown; timezone?: string }): Harness {
  const urls: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(input => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/search?')) {
      return Promise.resolve(jsonResponse([url.includes('Chiado') ? CHIADO : ESTRELA]));
    }
    if (url.includes('/plan?')) {
      return Promise.resolve(jsonResponse(options.transit ?? TRANSIT_BODY));
    }
    return Promise.resolve(jsonResponse(options.road ?? ROAD_BODY));
  });
  const capability = mapsCapability({
    tracing: NOOP_AGENT_TRACING,
    logger: createLogger({ silent: true }),
    pages_scope: PAGES_SCOPE,
    timezone: options.timezone ?? 'Europe/Lisbon',
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('maps capability has no tool sets');
  }
  return {
    urls,
    call: async args => {
      const response = await toolSet.callTool({
        name: 'render_route',
        arguments: { from_place: 'Chiado', to_place: 'Estrela', ...args },
      });
      const first = 'result' in response ? response.result.content[0] : undefined;
      const text = first?.type === 'text' ? first.text : '{}';
      return { body: JSON.parse(text), isError: 'result' in response && response.result.isError === true };
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('render_route travel modes', () => {
  it.each([
    ['walking', 'routing.openstreetmap.de/routed-foot/route/v1/driving/'],
    ['cycling', 'routing.openstreetmap.de/routed-bike/route/v1/driving/'],
    ['driving', 'router.project-osrm.org/route/v1/driving/'],
  ] as const)(
    'routes %s through its own server',
    async (mode, expectedPath) => {
      const { call, urls } = harness({});
      const { body, isError } = await call({ mode });
      expect(isError).toBe(false);
      expect(urls.filter(url => url.includes('/route/v1/'))).toHaveLength(1);
      expect(urls.find(url => url.includes('/route/v1/'))).toContain(expectedPath);
      const parsed = MapsRouteResultSchema.parse(body);
      expect(parsed.mode).toBe(mode);
      expect(parsed.distance_km).toBe(1.9);
      expect(parsed.duration_min).toBe(23.7);
    },
    15_000,
  );

  it('drives when no mode is given, as before', async () => {
    const { call, urls } = harness({});
    const { body } = await call({});
    expect(body['mode']).toBe('driving');
    expect(urls.some(url => url.includes('router.project-osrm.org/route/v1/driving/'))).toBe(true);
  }, 15_000);

  it('plans public transport with steps and sends the origin rounded', async () => {
    const { call, urls } = harness({});
    const { body, isError } = await call({ mode: 'transit' });
    expect(isError).toBe(false);
    const parsed = MapsRouteResultSchema.parse(body);
    if (parsed.mode !== 'transit') {
      throw new Error('expected a transit result');
    }
    expect(parsed.departs).toBe('09:00');
    expect(parsed.arrives).toBe('09:20');
    expect(parsed.steps.map(step => step.kind)).toEqual(['walk', 'ride', 'walk']);
    expect(parsed.attribution).toBe('© OpenStreetMap contributors');
    const plan = new URL(urls.find(url => url.includes('/plan?')) ?? '');
    expect(plan.host).toBe('api.transitous.org');
    expect(plan.searchParams.get('fromPlace')).toBe('38.711,-9.143');
    expect(plan.searchParams.get('toPlace')).toBe('38.7142,-9.1597');
  }, 15_000);

  it('prints clock times in UTC when the user zone is not a real zone', async () => {
    const legs = TRANSIT_BODY.itineraries[0]?.legs.map(leg => ({
      ...leg,
      from: { name: leg.from.name, lat: leg.from.lat, lon: leg.from.lon },
      to: { name: leg.to.name, lat: leg.to.lat, lon: leg.to.lon },
    }));
    const zoneless = { itineraries: [{ ...TRANSIT_BODY.itineraries[0], legs }] };
    const { call } = harness({ transit: zoneless, timezone: 'Not/AZone' });
    const { body, isError } = await call({ mode: 'transit' });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ mode: 'transit', departs: '08:00', arrives: '08:20' });
  }, 15_000);

  it('reads arrive_by as local time in the user zone', async () => {
    const { call, urls } = harness({});
    await call({ mode: 'transit', arrive_by: '2026-10-19T09:20' });
    const plan = new URL(urls.find(url => url.includes('/plan?')) ?? '');
    expect(plan.searchParams.get('time')).toBe('2026-10-19T09:20:00+01:00');
    expect(plan.searchParams.get('arriveBy')).toBe('true');
  }, 15_000);

  it('reads depart_at as a departure', async () => {
    const { call, urls } = harness({});
    await call({ mode: 'transit', depart_at: '2026-10-19T08:30' });
    const plan = new URL(urls.find(url => url.includes('/plan?')) ?? '');
    expect(plan.searchParams.get('arriveBy')).toBe('false');
  }, 15_000);

  it('rejects a time it cannot read, or two times at once, before any request', async () => {
    const unreadable = harness({});
    const first = await unreadable.call({ mode: 'transit', depart_at: 'soon' });
    expect(first.body).toMatchObject({ status: 'error', code: 'invalid_time', field: 'depart_at', mode: 'transit' });
    expect(unreadable.urls).toHaveLength(0);
    const both = harness({});
    const second = await both.call({
      mode: 'transit',
      depart_at: '2026-10-19T08:30',
      arrive_by: '2026-10-19T09:20',
    });
    expect(second.body).toMatchObject({ status: 'error', code: 'invalid_time' });
  });

  it('offers walking when no transit route exists', async () => {
    const { call } = harness({ transit: { itineraries: [] } });
    const { body, isError } = await call({ mode: 'transit' });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ status: 'error', code: 'no_route', mode: 'transit', try_instead: 'walking' });
  }, 15_000);

  it('does not offer another mode when a road route is missing', async () => {
    const { call } = harness({ road: { code: 'NoRoute', routes: [] } });
    const { body } = await call({ mode: 'cycling' });
    expect(body).toMatchObject({ code: 'no_route', mode: 'cycling' });
    expect(body).not.toHaveProperty('try_instead');
  }, 15_000);

  it('rejects an unknown mode', async () => {
    const { call } = harness({});
    const { isError } = await call({ mode: 'teleport' });
    expect(isError).toBe(true);
  });
});

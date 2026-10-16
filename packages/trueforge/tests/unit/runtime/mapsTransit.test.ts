import { decodePolyline, encodePolyline } from '../../../src/runtime/mapsPolyline';
import { MotisTransitProvider, resolveTransitTime } from '../../../src/runtime/mapsTransit';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Precision-6 encoding, as the planner sends leg geometry. */
function encodeSix(points: [number, number][]): string {
  return encodePolyline(points.map(([lat, lng]) => [lat * 10, lng * 10]));
}

const REQUEST = {
  from_lat: 38.711,
  from_lng: -9.143,
  to_lat: 38.7142,
  to_lng: -9.1597,
  time: null,
  arrive_by: false,
  fallback_timezone: 'UTC',
};

const RIDE_POINTS: [number, number][] = [
  [38.7105, -9.1425],
  [38.7118, -9.1498],
  [38.7131, -9.1561],
];

// Invented timetable: walk, tram 28E, walk. Times are UTC; Lisbon is one hour ahead in October.
const PLAN = {
  itineraries: [
    {
      startTime: '2026-10-19T08:00:00Z',
      endTime: '2026-10-19T08:21:00Z',
      transfers: 0,
      legs: [
        {
          mode: 'WALK',
          from: { name: 'START', lat: 38.711, lon: -9.143, tz: 'Europe/Lisbon' },
          to: { name: 'Calhariz (Bica)', lat: 38.7105, lon: -9.1425, tz: 'Europe/Lisbon' },
          startTime: '2026-10-19T08:00:00Z',
          endTime: '2026-10-19T08:04:00Z',
        },
        {
          mode: 'WALK',
          from: { name: 'Calhariz (Bica)', lat: 38.7105, lon: -9.1425, tz: 'Europe/Lisbon' },
          to: { name: 'Calhariz (Bica)', lat: 38.7105, lon: -9.1425, tz: 'Europe/Lisbon' },
          startTime: '2026-10-19T08:04:00Z',
          endTime: '2026-10-19T08:05:00Z',
        },
        {
          mode: 'TRAM',
          routeShortName: '28E',
          headsign: 'Campo Ourique',
          from: { name: 'Calhariz (Bica)', lat: 38.7105, lon: -9.1425, tz: 'Europe/Lisbon' },
          to: { name: 'Estrela', lat: 38.7131, lon: -9.1561, tz: 'Europe/Lisbon' },
          startTime: '2026-10-19T08:06:00Z',
          endTime: '2026-10-19T08:18:00Z',
          intermediateStops: [{}, {}, {}, {}, {}],
          legGeometry: { points: encodeSix(RIDE_POINTS), precision: 6 },
        },
        {
          mode: 'WALK',
          from: { name: 'Estrela', lat: 38.7131, lon: -9.1561, tz: 'Europe/Lisbon' },
          to: { name: 'END', lat: 38.7142, lon: -9.1597, tz: 'Europe/Lisbon' },
          startTime: '2026-10-19T08:18:00Z',
          endTime: '2026-10-19T08:21:00Z',
        },
      ],
    },
  ],
};

describe('resolveTransitTime', () => {
  it('reads a bare local time in the given zone, summer and winter', () => {
    expect(resolveTransitTime({ local: '2026-10-19T09:20', timezone: 'Europe/Lisbon' })).toBe(
      '2026-10-19T09:20:00+01:00',
    );
    expect(resolveTransitTime({ local: '2026-12-01T09:20:30', timezone: 'Europe/Lisbon' })).toBe(
      '2026-12-01T09:20:30+00:00',
    );
    expect(resolveTransitTime({ local: '2026-10-19T09:20', timezone: 'UTC' })).toBe('2026-10-19T09:20:00+00:00');
  });

  it('keeps a time that already carries an offset', () => {
    expect(resolveTransitTime({ local: '2026-10-19T09:20:00+02:00', timezone: 'Europe/Lisbon' })).toBe(
      '2026-10-19T09:20:00+02:00',
    );
    expect(resolveTransitTime({ local: '2026-10-19T09:20:00Z', timezone: 'Europe/Lisbon' })).toBe(
      '2026-10-19T09:20:00Z',
    );
  });

  it('refuses text that is not a date and time', () => {
    for (const bad of ['tomorrow morning', '9:20', '2026-13-45T99:99', '']) {
      expect(resolveTransitTime({ local: bad, timezone: 'Europe/Lisbon' })).toBeNull();
    }
  });
});

describe('MotisTransitProvider', () => {
  function providerFor(respond: (url: string) => Promise<Response>) {
    const seen: string[] = [];
    const provider = new MotisTransitProvider('https://transit.example/api/v6', url => {
      seen.push(url);
      return respond(url);
    });
    return { provider, seen };
  }

  it('turns an itinerary into plain steps with local clock times', async () => {
    const { provider, seen } = providerFor(() => Promise.resolve(jsonResponse(PLAN)));
    const plan = await provider.plan({ ...REQUEST, time: '2026-10-19T09:20:00+01:00', arrive_by: true });
    const url = new URL(seen[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://transit.example/api/v6/plan');
    expect(url.searchParams.get('fromPlace')).toBe('38.711,-9.143');
    expect(url.searchParams.get('toPlace')).toBe('38.7142,-9.1597');
    expect(url.searchParams.get('time')).toBe('2026-10-19T09:20:00+01:00');
    expect(url.searchParams.get('arriveBy')).toBe('true');
    expect(plan.departs).toBe('09:00');
    expect(plan.arrives).toBe('09:21');
    expect(plan.duration_min).toBe(21);
    expect(plan.transfers).toBe(0);
    expect(plan.steps).toEqual([
      { kind: 'walk', duration_min: 5, to_name: 'Calhariz (Bica)' },
      {
        kind: 'ride',
        vehicle: 'tram',
        line_name: '28E',
        headsign: 'Campo Ourique',
        from_name: 'Calhariz (Bica)',
        to_name: 'Estrela',
        departs: '09:06',
        arrives: '09:18',
        stops_count: 6,
      },
      { kind: 'walk', duration_min: 3, to_name: null },
    ]);
  });

  it('omits the time parameters when leaving now', async () => {
    const { provider, seen } = providerFor(() => Promise.resolve(jsonResponse(PLAN)));
    await provider.plan(REQUEST);
    const url = new URL(seen[0] ?? '');
    expect(url.searchParams.has('time')).toBe(false);
    expect(url.searchParams.has('arriveBy')).toBe(false);
  });

  it('draws the ride from its geometry and the walks as straight lines', async () => {
    const { provider } = providerFor(() => Promise.resolve(jsonResponse(PLAN)));
    const plan = await provider.plan(REQUEST);
    const drawn = decodePolyline(plan.geometry);
    expect(drawn).toContainEqual([expect.closeTo(38.7118, 4), expect.closeTo(-9.1498, 4)]);
    expect(plan.distance_km).toBeGreaterThan(1);
    expect(plan.distance_km).toBeLessThan(3);
  });

  it('falls back to straight lines when a leg geometry is garbled', async () => {
    const garbled = structuredClone(PLAN);
    const ride = garbled.itineraries[0]?.legs[2];
    if (ride?.legGeometry === undefined) {
      throw new Error('fixture has no ride geometry');
    }
    ride.legGeometry = { points: encodePolyline([[10, 10]]), precision: 6 };
    const { provider } = providerFor(() => Promise.resolve(jsonResponse(garbled)));
    const plan = await provider.plan(REQUEST);
    expect(decodePolyline(plan.geometry)).toContainEqual([expect.closeTo(38.7131, 4), expect.closeTo(-9.1561, 4)]);
  });

  it('classifies buses, metro and other vehicles', async () => {
    const ride = PLAN.itineraries[0]?.legs[2];
    if (ride === undefined) {
      throw new Error('fixture has no ride');
    }
    const rides = ['BUS', 'SUBWAY', 'FUNICULAR'].map(mode => ({ ...ride, mode, routeShortName: mode.slice(0, 2) }));
    const mixed = { itineraries: [{ ...PLAN.itineraries[0], legs: rides }] };
    const { provider } = providerFor(() => Promise.resolve(jsonResponse(mixed)));
    const plan = await provider.plan(REQUEST);
    expect(plan.steps.map(step => (step.kind === 'ride' ? step.vehicle : 'walk'))).toEqual(['bus', 'metro', 'other']);
  });

  it('reports no_route when the planner finds nothing', async () => {
    const { provider } = providerFor(() => Promise.resolve(jsonResponse({ itineraries: [] })));
    await expect(provider.plan(REQUEST)).rejects.toMatchObject({ code: 'no_route' });
  });

  it('maps 429, server errors, network failures and unreadable bodies', async () => {
    const limited = providerFor(() => Promise.resolve(new Response('slow', { status: 429 })));
    await expect(limited.provider.plan(REQUEST)).rejects.toMatchObject({ code: 'rate_limited', service: 'router' });
    const down = providerFor(() => Promise.resolve(new Response('oops', { status: 503 })));
    await expect(down.provider.plan(REQUEST)).rejects.toMatchObject({ code: 'service_unavailable' });
    const offline = providerFor(() => Promise.reject(new Error('network down')));
    await expect(offline.provider.plan(REQUEST)).rejects.toMatchObject({ code: 'service_unavailable' });
    const odd = providerFor(() => Promise.resolve(jsonResponse({ something: 'else' })));
    await expect(odd.provider.plan(REQUEST)).rejects.toMatchObject({ code: 'service_unavailable' });
  });
});

import { mapsDestinationHosts } from '@truefoundry/trueforge-core/core';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger } from 'winston';
import {
  GeocodeCache,
  MAPS_ORIGIN_COORDINATE_PRECISION,
  MAPS_SERVER_ID,
  MapsService,
  MapsUpstreamError,
  UpstreamLimiter,
  createMapsRoutingProvider,
  decodePolyline,
  encodePolyline,
  mapsCapability,
  roundOriginCoordinate,
  thinPolyline,
} from '../../../src/runtime/mapsCapability';
import { UPSTREAM_JSON_MAX_BODY_BYTES } from '../../../src/runtime/mapsUpstream';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('roundOriginCoordinate', () => {
  it('rounds to MAPS_ORIGIN_COORDINATE_PRECISION decimal places', () => {
    expect(MAPS_ORIGIN_COORDINATE_PRECISION).toBe(3);
    expect(roundOriginCoordinate(48.858844)).toBe(48.859);
    expect(roundOriginCoordinate(-2.294481)).toBe(-2.294);
    expect(roundOriginCoordinate(40.0)).toBe(40.0);
  });
});

describe('polyline helpers', () => {
  it('round-trips through encode and decode', () => {
    const points: Array<[number, number]> = [
      [48.858844, 2.294481],
      [48.86, 2.296],
      [48.862, 2.3],
    ];
    const encoded = encodePolyline(points);
    const decoded = decodePolyline(encoded);
    expect(decoded).toHaveLength(3);
    for (const [index, [lat, lng]] of decoded.entries()) {
      expect(lat).toBeCloseTo(points[index]?.[0] ?? 0, 4);
      expect(lng).toBeCloseTo(points[index]?.[1] ?? 0, 4);
    }
  });

  it('thinPolyline keeps both endpoints and fits the bound', () => {
    const points: Array<[number, number]> = [];
    for (let i = 0; i < 500; i += 1) {
      points.push([48.8 + i * 0.001, 2.29 + i * 0.001]);
    }
    const encoded = encodePolyline(points);
    const thinned = thinPolyline(encoded, 200);
    expect(thinned.length).toBeLessThanOrEqual(200);
    const decoded = decodePolyline(thinned);
    expect(decoded[0]).toEqual([expect.closeTo(48.8, 4), expect.closeTo(2.29, 4)]);
    const last = decoded[decoded.length - 1];
    expect(last?.[0]).toBeCloseTo(48.8 + 499 * 0.001, 4);
  });

  it('thinPolyline leaves short geometries alone', () => {
    const encoded = encodePolyline([
      [48.85, 2.29],
      [48.86, 2.3],
    ]);
    expect(thinPolyline(encoded, 8000)).toBe(encoded);
  });
});

describe('UpstreamLimiter', () => {
  it('waits out the one-second interval between calls', async () => {
    jest.useFakeTimers();
    try {
      let now = 1_000_000;
      const limiter = new UpstreamLimiter(() => now);
      const starts: number[] = [];
      const first = limiter.run(() => {
        starts.push(now);
        return Promise.resolve(1);
      });
      const second = limiter.run(() => {
        starts.push(now);
        return Promise.resolve(2);
      });
      await first;
      // Second call is waiting on the interval timer.
      expect(starts).toHaveLength(1);
      // Advance time past the interval.
      now += 1_100;
      await jest.advanceTimersByTimeAsync(1_100);
      await second;
      expect(starts).toHaveLength(2);
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('GeocodeCache', () => {
  it('returns cached entries and expires them after 24h', () => {
    let now = 0;
    const cache = new GeocodeCache(() => now);
    const places = [
      { resolved_name: 'Paris, France', address: 'Paris, France', lat: 48.85, lng: 2.35, bounding_box: null },
    ];
    cache.set('search:Paris', places);
    expect(cache.get('search:Paris')).toEqual(places);
    now = 24 * 60 * 60 * 1000 + 1;
    expect(cache.get('search:Paris')).toBeUndefined();
  });

  it('evicts the oldest entry past 500', () => {
    const cache = new GeocodeCache();
    for (let i = 0; i < 501; i += 1) {
      cache.set(`k${i}`, []);
    }
    expect(cache.get('k0')).toBeUndefined();
    expect(cache.get('k500')).toEqual([]);
  });
});

describe('OsrmRoutingProvider', () => {
  it('builds the route URL from the coordinates it is given', async () => {
    const seen: string[] = [];
    const provider = createMapsRoutingProvider({
      provider_id: 'osrm',
      router_url: 'https://router.example',
      fetch_limited: url => {
        seen.push(url);
        return Promise.resolve(
          jsonResponse({ code: 'Ok', routes: [{ distance: 1234.5, duration: 600, geometry: '_p~iF~ps|U' }] }),
        );
      },
    });
    const result = await provider.route({ from_lat: 48.8588444, from_lng: 2.2944811, to_lat: 48.86, to_lng: 2.3 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/2.2944811,48.8588444;2.3,48.86');
    expect(result.distance_km).toBe(1.2);
    expect(result.duration_min).toBe(10);
    expect(result.traffic).toBe(false);
  });

  it('maps NoRoute to the no_route error', async () => {
    const provider = createMapsRoutingProvider({
      provider_id: 'osrm',
      router_url: 'https://router.example',
      fetch_limited: () => Promise.resolve(jsonResponse({ code: 'NoRoute', routes: [] })),
    });
    await expect(provider.route({ from_lat: 0, from_lng: 0, to_lat: 1, to_lng: 1 })).rejects.toMatchObject({
      code: 'no_route',
    });
  });

  it('maps 429 to rate_limited', async () => {
    const provider = createMapsRoutingProvider({
      provider_id: 'osrm',
      router_url: 'https://router.example',
      fetch_limited: () => Promise.resolve(new Response('slow down', { status: 429 })),
    });
    await expect(provider.route({ from_lat: 0, from_lng: 0, to_lat: 1, to_lng: 1 })).rejects.toMatchObject({
      code: 'rate_limited',
      service: 'router',
    });
  });

  it('treats an oversize router body as service_unavailable', async () => {
    const provider = createMapsRoutingProvider({
      provider_id: 'osrm',
      router_url: 'https://router.example',
      fetch_limited: () =>
        Promise.resolve(new Response('x', { headers: { 'Content-Length': String(UPSTREAM_JSON_MAX_BODY_BYTES + 1) } })),
    });
    await expect(provider.route({ from_lat: 0, from_lng: 0, to_lat: 1, to_lng: 1 })).rejects.toMatchObject({
      code: 'service_unavailable',
      service: 'router',
    });
  });

  it('rejects unknown provider ids', () => {
    expect(() =>
      createMapsRoutingProvider({
        provider_id: 'trafficorp',
        router_url: 'https://x',
        fetch_limited: () => {
          throw new Error('no');
        },
      }),
    ).toThrow('Unknown maps routing provider');
  });
});

describe('MapsService.geocode', () => {
  const nominatimHit = {
    lat: '48.858844',
    lon: '2.294481',
    display_name: 'Eiffel Tower, Paris, France',
    address: { city: 'Paris' },
    boundingbox: ['48.85', '48.86', '2.29', '2.3'],
  };

  function serviceWith(fetch_limited: (url: string) => Promise<Response>): { service: MapsService; seen: string[] } {
    const seen: string[] = [];
    const service = new MapsService({
      geocoder_url: 'https://geocode.example',
      router_provider: createMapsRoutingProvider({
        provider_id: 'osrm',
        router_url: 'https://router.example',
        fetch_limited: () => Promise.reject(new Error('unused')),
      }),
      logger: createLogger({ silent: true }),
      fetch_limited: url => {
        seen.push(url);
        return fetch_limited(url);
      },
    });
    return { service, seen };
  }

  it('treats an oversize or unparseable geocoder body as service_unavailable', async () => {
    const oversize = serviceWith(() =>
      Promise.resolve(new Response('[]', { headers: { 'Content-Length': String(UPSTREAM_JSON_MAX_BODY_BYTES + 1) } })),
    );
    await expect(oversize.service.geocode('Paris')).rejects.toMatchObject({
      code: 'service_unavailable',
      service: 'geocoder',
    });
    const garbled = serviceWith(() => Promise.resolve(new Response('<html>')));
    await expect(garbled.service.geocode('Paris')).rejects.toMatchObject({ code: 'service_unavailable' });
    const poi = serviceWith(() => Promise.resolve(new Response('<html>')));
    const place = { resolved_name: 'Paris', address: null, lat: 48.85, lng: 2.35, bounding_box: null };
    await expect(poi.service.searchPoi(place, 'cafe')).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('returns the top match and caches the exact request', async () => {
    const { service, seen } = serviceWith(() => Promise.resolve(jsonResponse([nominatimHit])));
    const first = await service.geocode('Eiffel Tower');
    expect(first?.resolved_name).toBe('Eiffel Tower, Paris, France');
    expect(first?.lat).toBeCloseTo(48.858844, 5);
    expect(seen).toHaveLength(1);
    const second = await service.geocode('Eiffel Tower');
    expect(second).toEqual(first);
    expect(seen).toHaveLength(1);
  });

  it('returns null on zero hits (not an error)', async () => {
    const { service } = serviceWith(() => Promise.resolve(jsonResponse([])));
    await expect(service.geocode('nowhere xyz')).resolves.toBeNull();
  });

  it('maps 429 to rate_limited with the geocoder service', async () => {
    const { service } = serviceWith(() => Promise.resolve(new Response('slow', { status: 429 })));
    await expect(service.geocode('Paris')).rejects.toMatchObject({ code: 'rate_limited', service: 'geocoder' });
  });

  it('maps upstream failure to service_unavailable', async () => {
    const { service } = serviceWith(() => Promise.reject(new Error('boom')));
    const error = await service.geocode('Paris').catch(e => e);
    expect(error).toBeInstanceOf(MapsUpstreamError);
    expect(error.code).toBe('service_unavailable');
  });

  it('searchPoi returns up to 5 pins and zero hits is not an error', async () => {
    const { service } = serviceWith(url => {
      if (url.includes('q=coffee')) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(jsonResponse([nominatimHit]));
    });
    const place = (await service.geocode('Paris'))!;
    const pins = await service.searchPoi(place, 'coffee');
    expect(pins).toEqual([]);
  });
});

describe('MapsService.route origin privacy', () => {
  it('hands every provider a rounded origin and an untouched destination', async () => {
    const received: { from_lat: number; from_lng: number; to_lat: number; to_lng: number }[] = [];
    const service = new MapsService({
      geocoder_url: 'https://geocode.example',
      router_provider: {
        provider_id: 'recording',
        route: input => {
          received.push(input);
          return Promise.resolve({ distance_km: 1, duration_min: 1, geometry: '_p~iF~ps|U', traffic: false });
        },
      },
      logger: createLogger({ silent: true }),
      fetch_limited: () => Promise.reject(new Error('unused')),
    });
    const place = (lat: number, lng: number) => ({
      resolved_name: 'x',
      address: null,
      lat,
      lng,
      bounding_box: null,
    });
    await service.route(place(48.8588444, 2.2944811), place(48.8606111, 2.3376222));
    expect(received).toEqual([{ from_lat: 48.859, from_lng: 2.294, to_lat: 48.8606111, to_lng: 2.3376222 }]);
  });
});

describe('maps connector binding', () => {
  it('binds approvals to the configured upstream hosts, matching what the approval card names', async () => {
    const capability = mapsCapability({ tracing: NOOP_AGENT_TRACING, logger: createLogger({ silent: true }) });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('maps capability has no tool sets');
    }
    const binding = toolSet.resolveConnector?.({ name: 'render_map', arguments: { place_name: 'Paris' } });
    const info = await toolSet.toolCallInfo({ name: 'render_map', arguments: { place_name: 'Paris' } });
    if (info.maps_hosts === undefined) {
      throw new Error('maps hosts were not stamped');
    }
    expect(binding).toEqual({ server_id: MAPS_SERVER_ID, destination_host: mapsDestinationHosts(info.maps_hosts) });
  });
});

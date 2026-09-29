import {
  RENDER_MAP_TOOL_NAME,
  RENDER_ROUTE_TOOL_NAME,
  RenderMap,
} from '../../../../src/core/capabilities/builtins/RenderMap';
import { isCallToolResponseResult } from '../../../../src/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';

interface NominatimPlaceJson {
  lat: string;
  lon: string;
  display_name: string;
}

interface MapPayload {
  map_card_id: string;
  resolved_name: string;
  address?: string;
  lat: number;
  lng: number;
  zoom: number;
  pins?: Array<{ name: string; lat: number; lng: number }>;
}

interface RoutePayload {
  map_card_id: string;
  from_resolved: string;
  to_resolved: string;
  distance_km: number;
  duration_min: number;
  route_geometry: string;
}

interface ErrorPayload {
  error: string;
  field?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMapPayload(value: unknown): value is MapPayload {
  return (
    isObject(value) &&
    typeof value['map_card_id'] === 'string' &&
    typeof value['resolved_name'] === 'string' &&
    typeof value['lat'] === 'number' &&
    typeof value['lng'] === 'number' &&
    typeof value['zoom'] === 'number'
  );
}

function isRoutePayload(value: unknown): value is RoutePayload {
  return (
    isObject(value) &&
    typeof value['map_card_id'] === 'string' &&
    typeof value['from_resolved'] === 'string' &&
    typeof value['to_resolved'] === 'string' &&
    typeof value['distance_km'] === 'number' &&
    typeof value['duration_min'] === 'number' &&
    typeof value['route_geometry'] === 'string'
  );
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  return isObject(value) && typeof value['error'] === 'string';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RENDER_MAP_DESCRIPTION =
  "Render an interactive map with a pin for a named place. Pass the place name as the user gave it (e.g. 'Paris', 'Eiffel Tower'). The tool geocodes the name and returns an inline map card. Use when the user explicitly asks to see a place on a map or asks where a place is.";

const RENDER_ROUTE_DESCRIPTION =
  "Render a route map between two named places. Pass both place names as the user gave them (e.g. from_place 'Madrid', to_place 'Barcelona'). The tool geocodes both endpoints, routes via OSRM, and returns an inline map card with the route polyline, distance, and duration. Use when the user asks for directions between two named places. Both endpoints must be named by the user; there is no current-location mode.";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(handler: (url: string) => Response): jest.SpiedFunction<typeof globalThis.fetch> {
  return jest.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString();
    return Promise.resolve(handler(url));
  });
}

function nominatimQuery(url: string): string | null {
  try {
    return new URL(url).searchParams.get('q');
  } catch {
    return null;
  }
}

function placeJson(displayName: string, lat: string, lon: string): NominatimPlaceJson {
  return { lat, lon, display_name: displayName };
}

async function callTool<T>(
  tool: RenderMap,
  name: string,
  args: Record<string, unknown>,
  guard: (value: unknown) => value is T,
): Promise<{ isError: boolean; payload: T }> {
  const response = await tool.callTool({ name, arguments: args });
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a resolved call_tool response');
  }
  const first = response.result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('Expected text content');
  }
  const parsed: unknown = JSON.parse(first.text);
  if (!guard(parsed)) {
    throw new Error('Unexpected payload shape');
  }
  return { isError: response.result.isError === true, payload: parsed };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('RenderMap', () => {
  describe('render_map', () => {
    it('returns the resolved place for a known name', async () => {
      mockFetch(url => {
        expect(url).toContain('nominatim.openstreetmap.org');
        expect(nominatimQuery(url)).toBe('Paris');
        return jsonResponse([placeJson('Paris, France', '48.8566', '2.3522')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_MAP_TOOL_NAME, {
        place_name: 'Paris',
      }, isMapPayload);
      expect(isError).toBe(false);
      expect(payload.map_card_id).toMatch(UUID_PATTERN);
      expect(payload.resolved_name).toBe('Paris, France');
      expect(payload.address).toBe('Paris, France');
      expect(payload.lat).toBeCloseTo(48.8566);
      expect(payload.lng).toBeCloseTo(2.3522);
      expect(payload.pins).toBeUndefined();
    });

    it('carries the requested zoom through to the payload', async () => {
      mockFetch(url => {
        expect(nominatimQuery(url)).toBe('Paris');
        return jsonResponse([placeJson('Paris, France', '48.8566', '2.3522')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_MAP_TOOL_NAME, {
        place_name: 'Paris',
        zoom: 10,
      }, isMapPayload);
      expect(isError).toBe(false);
      expect(payload.zoom).toBe(10);
    });

    it('clamps an out-of-range zoom to the valid range', async () => {
      mockFetch(url => {
        expect(nominatimQuery(url)).toBe('Paris');
        return jsonResponse([placeJson('Paris, France', '48.8566', '2.3522')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { payload } = await callTool(tool, RENDER_MAP_TOOL_NAME, {
        place_name: 'Paris',
        zoom: 99,
      }, isMapPayload);
      expect(payload.zoom).toBe(18);
    });

    it('returns not_found for an unknown place', async () => {
      mockFetch(() => jsonResponse([]));
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_MAP_TOOL_NAME, {
        place_name: 'Xyzqpl',
      }, isErrorPayload);
      expect(isError).toBe(true);
      expect(payload).toEqual({ error: 'not_found' });
    });

    it('returns service_unavailable when the geocoder is unreachable', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_MAP_TOOL_NAME, {
        place_name: 'Nowheretown',
      }, isErrorPayload);
      expect(isError).toBe(true);
      expect(payload).toEqual({ error: 'service_unavailable' });
    });

    it('returns up to 5 POI pins from a category search when poi is given', async () => {
      mockFetch(url => {
        if (url.includes('overpass-api.de')) {
          // Category query for amenity=cafe around Lyon; the encoded QL keeps
          // the tag key/value as literal substrings.
          expect(url).toContain('amenity');
          expect(url).toContain('cafe');
          expect(url).toContain('around');
          return jsonResponse({
            elements: [
              { type: 'node', lat: 45.78, lon: 4.85, tags: { name: 'Cafe Far' } },
              { type: 'node', lat: 45.765, lon: 4.836, tags: { name: 'Cafe Near' } },
              // Unnamed elements are skipped: a pin without a name is useless.
              { type: 'node', lat: 45.766, lon: 4.837, tags: {} },
              {
                type: 'way',
                center: { lat: 45.767, lon: 4.838 },
                tags: { name: 'Cafe Way' },
              },
            ],
          });
        }
        expect(nominatimQuery(url)).toBe('Lyon');
        return jsonResponse([placeJson('Lyon, France', '45.764', '4.8357')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_MAP_TOOL_NAME, {
        place_name: 'Lyon',
        poi: 'coffee shop',
      }, isMapPayload);
      expect(isError).toBe(false);
      expect(payload.resolved_name).toBe('Lyon, France');
      // Sorted by distance from Lyon center; the unnamed node is skipped.
      expect(payload.pins).toHaveLength(3);
      expect(payload.pins?.[0]).toEqual({ name: 'Cafe Near', lat: 45.765, lng: 4.836 });
      expect(payload.pins?.[1]).toEqual({ name: 'Cafe Way', lat: 45.767, lng: 4.838 });
      expect(payload.pins?.[2]).toEqual({ name: 'Cafe Far', lat: 45.78, lng: 4.85 });
    });

    it('returns pins: [] when the POI category search finds nothing', async () => {
      mockFetch(url => {
        if (url.includes('overpass-api.de')) {
          return jsonResponse({ elements: [] });
        }
        expect(nominatimQuery(url)).toBe('Nice');
        return jsonResponse([placeJson('Nice, France', '43.7034', '7.2663')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_MAP_TOOL_NAME, {
        place_name: 'Nice',
        poi: 'parking',
      }, isMapPayload);
      expect(isError).toBe(false);
      expect(payload.resolved_name).toBe('Nice, France');
      expect(payload.pins).toEqual([]);
    });

    it('falls back to a viewbox-biased name search for uncategorized poi queries', async () => {
      mockFetch(url => {
        const query = nominatimQuery(url);
        if (query === 'Lyon') {
          return jsonResponse([placeJson('Lyon, France', '45.764', '4.8357')]);
        }
        expect(query).toBe('souvenir');
        // Area scoping comes from the bounding box, not appended name text.
        expect(url).toContain('viewbox=');
        expect(url).toContain('bounded=1');
        expect(url).not.toContain('overpass-api.de');
        return jsonResponse([placeJson('Souvenir Shop, Lyon, France', '45.765', '4.836')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_MAP_TOOL_NAME, {
        place_name: 'Lyon',
        poi: 'souvenir',
      }, isMapPayload);
      expect(isError).toBe(false);
      expect(payload.pins).toEqual([{ name: 'Souvenir Shop, Lyon, France', lat: 45.765, lng: 4.836 }]);
    });

    it('returns service_unavailable when the POI category search is unreachable', async () => {
      mockFetch(url => {
        if (url.includes('overpass-api.de')) {
          throw new Error('network down');
        }
        expect(nominatimQuery(url)).toBe('Marseille');
        return jsonResponse([placeJson('Marseille, France', '43.2965', '5.3698')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_MAP_TOOL_NAME, {
        place_name: 'Marseille',
        poi: 'coffee shop',
      }, isErrorPayload);
      expect(isError).toBe(true);
      expect(payload).toEqual({ error: 'service_unavailable' });
    });

    it('defaults to zoom 13 when zoom is omitted', async () => {
      mockFetch(url => {
        expect(nominatimQuery(url)).toBe('Paris');
        return jsonResponse([placeJson('Paris, France', '48.8566', '2.3522')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { payload } = await callTool(tool, RENDER_MAP_TOOL_NAME, {
        place_name: 'Paris',
      }, isMapPayload);
      expect(payload.zoom).toBe(13);
    });
  });

  describe('render_route', () => {
    it('returns distance, duration, and geometry for a routed pair', async () => {
      mockFetch(url => {
        if (url.includes('router.project-osrm.org')) {
          expect(url).toContain('overview=full');
          expect(url).toContain('geometries=polyline');
          return jsonResponse({
            code: 'Ok',
            waypoints: [{ distance: 8 }, { distance: 15 }],
            routes: [{ distance: 621000, duration: 22200, geometry: 'abc123' }],
          });
        }
        const query = nominatimQuery(url);
        if (query === 'Madrid') {
          return jsonResponse([placeJson('Madrid, Spain', '40.4168', '-3.7038')]);
        }
        expect(query).toBe('Barcelona');
        return jsonResponse([placeJson('Barcelona, Spain', '41.3851', '2.1734')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_ROUTE_TOOL_NAME, {
        from_place: 'Madrid',
        to_place: 'Barcelona',
      }, isRoutePayload);
      expect(isError).toBe(false);
      expect(payload.map_card_id).toMatch(UUID_PATTERN);
      expect(payload.from_resolved).toBe('Madrid, Spain');
      expect(payload.to_resolved).toBe('Barcelona, Spain');
      expect(payload.distance_km).toBe(621);
      expect(payload.duration_min).toBe(370);
      expect(payload.route_geometry).toBe('abc123');
    });

    it('names from_place when the origin does not geocode', async () => {
      mockFetch(url => {
        expect(nominatimQuery(url)).toBe('Xyzqpl');
        return jsonResponse([]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_ROUTE_TOOL_NAME, {
        from_place: 'Xyzqpl',
        to_place: 'Barcelona',
      }, isErrorPayload);
      expect(isError).toBe(true);
      expect(payload).toEqual({ error: 'not_found', field: 'from_place' });
    });

    it('names to_place when the destination does not geocode', async () => {
      mockFetch(url => {
        const query = nominatimQuery(url);
        if (query === 'Madrid') {
          return jsonResponse([placeJson('Madrid, Spain', '40.4168', '-3.7038')]);
        }
        expect(query).toBe('Xyzqpl');
        return jsonResponse([]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_ROUTE_TOOL_NAME, {
        from_place: 'Madrid',
        to_place: 'Xyzqpl',
      }, isErrorPayload);
      expect(isError).toBe(true);
      expect(payload).toEqual({ error: 'not_found', field: 'to_place' });
    });

    it('returns no_route when OSRM finds no road connection', async () => {
      mockFetch(url => {
        if (url.includes('router.project-osrm.org')) {
          return jsonResponse({ code: 'NoRoute', routes: [] });
        }
        const query = nominatimQuery(url);
        if (query === 'Mallorca') {
          return jsonResponse([placeJson('Mallorca, Spain', '39.5696', '2.6502')]);
        }
        expect(query).toBe('Ibiza');
        return jsonResponse([placeJson('Ibiza, Spain', '38.9067', '1.4206')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_ROUTE_TOOL_NAME, {
        from_place: 'Mallorca',
        to_place: 'Ibiza',
      }, isErrorPayload);
      expect(isError).toBe(true);
      expect(payload).toEqual({ error: 'no_route' });
    });

    it('returns no_route when OSRM snaps an endpoint absurdly far away', async () => {
      mockFetch(url => {
        if (url.includes('router.project-osrm.org')) {
          // OSRM answers Ok but snapped New York to a road near Lisbon.
          return jsonResponse({
            code: 'Ok',
            waypoints: [{ distance: 12 }, { distance: 553480 }],
            routes: [{ distance: 621000, duration: 22200, geometry: 'abc123' }],
          });
        }
        const query = nominatimQuery(url);
        if (query === 'Madrid') {
          return jsonResponse([placeJson('Madrid, Spain', '40.4168', '-3.7038')]);
        }
        expect(query).toBe('New York');
        return jsonResponse([placeJson('New York, USA', '40.7128', '-74.006')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_ROUTE_TOOL_NAME, {
        from_place: 'Madrid',
        to_place: 'New York',
      }, isErrorPayload);
      expect(isError).toBe(true);
      expect(payload).toEqual({ error: 'no_route' });
    });

    it('returns service_unavailable when OSRM is unreachable', async () => {
      mockFetch(url => {
        if (url.includes('router.project-osrm.org')) {
          throw new Error('network down');
        }
        const query = nominatimQuery(url);
        if (query === 'Porto') {
          return jsonResponse([placeJson('Porto, Portugal', '41.1579', '-8.6291')]);
        }
        expect(query).toBe('Lisbon');
        return jsonResponse([placeJson('Lisbon, Portugal', '38.7223', '-9.1393')]);
      });
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { isError, payload } = await callTool(tool, RENDER_ROUTE_TOOL_NAME, {
        from_place: 'Porto',
        to_place: 'Lisbon',
      }, isErrorPayload);
      expect(isError).toBe(true);
      expect(payload).toEqual({ error: 'service_unavailable' });
    });
  });

  describe('tool manifests', () => {
    it('marks both tools as requiring network with the spec descriptions', async () => {
      const tool = new RenderMap(NOOP_AGENT_TRACING);
      const { result } = await tool.listTools();
      const byName = new Map(result.tools.map(t => [t.name, t]));
      expect(byName.get(RENDER_MAP_TOOL_NAME)?.requiresNetwork).toBe(true);
      expect(byName.get(RENDER_ROUTE_TOOL_NAME)?.requiresNetwork).toBe(true);
      expect(byName.get(RENDER_MAP_TOOL_NAME)?.description).toBe(RENDER_MAP_DESCRIPTION);
      expect(byName.get(RENDER_ROUTE_TOOL_NAME)?.description).toBe(RENDER_ROUTE_DESCRIPTION);
    });
  });
});

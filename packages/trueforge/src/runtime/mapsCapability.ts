/**
 * Embedded maps: `render_map` and `render_route` model-callable tools.
 *
 * The tools run in the server process, not the sandbox. Each call geocodes
 * place names through the configured geocoder and (for routes) asks the
 * configured routing provider for a driving route. Map tiles reach the browser
 * only through the same-origin tile proxy (`/api/maps/tiles/{z}/{x}/{y}.png`);
 * the tool results carry coordinates and metadata, never tile URLs.
 *
 * Every call is Tier 3 (see the maps branch in the Sentinel classifier). The
 * tools are registered in FIRST_PARTY_REQUIRES_NETWORK, so offline mode filters
 * them from the model's tool list and auto-denies stale calls.
 */
import type { AgentCapability, AgentTracing } from '@truefoundry/trueforge-core/core';
import { defineTool, LocalToolMCP, toolResultResponse, type ToolDefinition } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import { z } from 'zod';
import configuration from '../config';

export const MAPS_SERVER_ID = 'maps';
export const RENDER_MAP_TOOL_NAME = 'render_map';
export const RENDER_ROUTE_TOOL_NAME = 'render_route';

/**
 * Origin privacy: coordinates sent to the routing provider for the origin are
 * rounded to this many decimal places (3 is about 100 m). The destination is
 * not rounded. One constant controls the precision.
 */
export const MAPS_ORIGIN_COORDINATE_PRECISION = 3;

/** Round a coordinate to MAPS_ORIGIN_COORDINATE_PRECISION decimal places. */
export function roundOriginCoordinate(value: number): number {
  const factor = 10 ** MAPS_ORIGIN_COORDINATE_PRECISION;
  return Math.round(value * factor) / factor;
}

/** One upstream request per second per service; the fetch wrapper enforces the 10 s timeout. */
const UPSTREAM_MIN_INTERVAL_MS = 1000;
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Geocode cache: 500 entries, 24 h TTL, in process memory only. */
const GEOCODE_CACHE_MAX_ENTRIES = 500;
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_ZOOM = 13;
const MAX_POI_PINS = 5;
const MAX_GEOMETRY_CHARS = 8000;

/** Input schemas are .strict(); every bound is 128 or under; no regex. */
const RENDER_MAP_INPUT_SCHEMA = z
  .object({
    place_name: z.string().min(1).max(128),
    poi: z.string().min(1).max(64).optional(),
    zoom: z.number().int().min(1).max(18).default(DEFAULT_ZOOM),
  })
  .strict();

const RENDER_ROUTE_INPUT_SCHEMA = z
  .object({
    from_place: z.string().min(1).max(128),
    to_place: z.string().min(1).max(128),
  })
  .strict();

export type RenderMapInput = z.infer<typeof RENDER_MAP_INPUT_SCHEMA>;
export type RenderRouteInput = z.infer<typeof RENDER_ROUTE_INPUT_SCHEMA>;

export type MapsErrorCode = 'not_found' | 'no_route' | 'service_unavailable' | 'rate_limited';

export interface MapsErrorBody {
  status: 'error';
  code: MapsErrorCode;
  field?: string | undefined;
  service?: 'geocoder' | 'router' | undefined;
}

export interface GeocodedPlace {
  resolved_name: string;
  address: string | null;
  lat: number;
  lng: number;
  /** Bounding box [south, north, west, east] for POI viewbox searches. */
  bounding_box: [number, number, number, number] | null;
}

/** Routing provider interface: the provider id plus URL come from config. */
export interface MapsRouteRequest {
  from_lat: number;
  from_lng: number;
  to_lat: number;
  to_lng: number;
}

export interface MapsRouteResult {
  distance_km: number;
  duration_min: number;
  /** Encoded polyline, precision 5, at most 8,000 chars. */
  geometry: string;
  /** True when the duration includes live traffic. OSRM never sets this. */
  traffic: boolean;
}

export interface MapsRoutingProvider {
  readonly provider_id: string;
  route(input: MapsRouteRequest): Promise<MapsRouteResult>;
}

/** OSRM routing provider: the first implementation of the interface. */
class OsrmRoutingProvider implements MapsRoutingProvider {
  readonly provider_id = 'osrm';

  constructor(
    private readonly base_url: string,
    private readonly fetch_limited: (url: string) => Promise<Response>,
  ) {}

  async route(input: MapsRouteRequest): Promise<MapsRouteResult> {
    // Origin privacy: round the origin before the request leaves the server.
    const from_lat = roundOriginCoordinate(input.from_lat);
    const from_lng = roundOriginCoordinate(input.from_lng);
    const url =
      `${this.base_url}/route/v1/driving/${String(from_lng)},${String(from_lat)};${String(input.to_lng)},${String(input.to_lat)}` +
      `?overview=simplified&geometries=polyline`;
    let response: Response;
    try {
      response = await this.fetch_limited(url);
    } catch (error) {
      throw new MapsUpstreamError('service_unavailable', 'router', error);
    }
    if (response.status === 429) {
      throw new MapsUpstreamError('rate_limited', 'router');
    }
    if (!response.ok) {
      throw new MapsUpstreamError('service_unavailable', 'router');
    }
    const body: unknown = await response.json();
    const parsed = osrmRouteSchema.safeParse(body);
    if (!parsed.success || parsed.data.code === 'NoRoute' || parsed.data.routes.length === 0) {
      throw new MapsUpstreamError('no_route');
    }
    const route = parsed.data.routes[0];
    if (route === undefined) {
      throw new MapsUpstreamError('no_route');
    }
    return {
      distance_km: Math.round((route.distance / 1000) * 10) / 10,
      duration_min: Math.round((route.duration / 60) * 10) / 10,
      geometry: thinPolyline(route.geometry, MAX_GEOMETRY_CHARS),
      traffic: false,
    };
  }
}

export function createMapsRoutingProvider(input: {
  provider_id: string;
  router_url: string;
  fetch_limited: (url: string) => Promise<Response>;
}): MapsRoutingProvider {
  if (input.provider_id === 'osrm') {
    return new OsrmRoutingProvider(input.router_url, input.fetch_limited);
  }
  throw new Error(`Unknown maps routing provider: ${input.provider_id}`);
}

/** Upstream failure with a maps error code for the tool result body. */
export class MapsUpstreamError extends Error {
  readonly code: MapsErrorCode;
  readonly service: 'geocoder' | 'router' | undefined;

  constructor(code: MapsErrorCode, service?: 'geocoder' | 'router', cause?: unknown) {
    super(
      `Maps upstream failure: ${code}${service ? ` (${service})` : ''}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'MapsUpstreamError';
    this.code = code;
    this.service = service;
  }
}

const osrmRouteSchema = z.object({
  code: z.string(),
  routes: z.array(
    z.object({
      distance: z.number(),
      duration: z.number(),
      geometry: z.string(),
    }),
  ),
});

const nominatimResultSchema = z.object({
  lat: z.string(),
  lon: z.string(),
  display_name: z.string(),
  address: z.record(z.string(), z.unknown()).optional(),
  boundingbox: z.array(z.string()).optional(),
});

/**
 * Thin an encoded polyline to at most maxChars by dropping points evenly,
 * always keeping both endpoints so the line still draws.
 */
export function thinPolyline(encoded: string, maxChars: number): string {
  if (encoded.length <= maxChars) {
    return encoded;
  }
  // Decode to points, thin, re-encode. Precision 5.
  const points = decodePolyline(encoded);
  if (points.length <= 2) {
    return encoded;
  }
  // Binary search the stride that fits.
  let low = 2;
  let high = points.length;
  let best = encoded;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) {
    return encoded;
  }
  while (low <= high) {
    const stride = Math.floor((low + high) / 2);
    const thinned: [number, number][] = [first];
    for (let i = stride; i < points.length - 1; i += stride) {
      const point = points[i];
      if (point !== undefined) {
        thinned.push(point);
      }
    }
    thinned.push(last);
    const candidate = encodePolyline(thinned);
    if (candidate.length <= maxChars) {
      best = candidate;
      high = stride - 1;
    } else {
      low = stride + 1;
    }
  }
  return best;
}

/** Decode a precision-5 encoded polyline to [lat, lng] pairs. */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let lat = 0;
  let lng = 0;
  let index = 0;
  while (index < encoded.length) {
    const latResult = decodePolylineValue(encoded, { index });
    lat += latResult.value;
    index = latResult.nextIndex;
    const lngResult = decodePolylineValue(encoded, { index });
    lng += lngResult.value;
    index = lngResult.nextIndex;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function decodePolylineValue(encoded: string, state: { index: number }): { value: number; nextIndex: number } {
  let shift = 0;
  let result = 0;
  let index = state.index;
  let byte: number;
  do {
    byte = encoded.charCodeAt(index) - 63;
    index += 1;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20);
  const value = (result & 1) === 1 ? ~(result >> 1) : result >> 1;
  return { value, nextIndex: index };
}

/** Encode [lat, lng] pairs as a precision-5 polyline. */
export function encodePolyline(points: [number, number][]): string {
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  for (const [lat, lng] of points) {
    const latInt = Math.round(lat * 1e5);
    const lngInt = Math.round(lng * 1e5);
    out += encodePolylineValue(latInt - lastLat);
    out += encodePolylineValue(lngInt - lastLng);
    lastLat = latInt;
    lastLng = lngInt;
  }
  return out;
}

function encodePolylineValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

/** One in-process limiter per instance: at most one request per second, queued in order. */
export class UpstreamLimiter {
  private lastStart = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly now: () => number = Date.now) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = UPSTREAM_MIN_INTERVAL_MS - (this.now() - this.lastStart);
      if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait));
      }
      this.lastStart = this.now();
      return await work();
    });
    // Keep the queue alive across rejections; the caller still sees its error.
    this.queue = run.catch(() => undefined);
    return run;
  }
}

interface GeocodeCacheEntry {
  places: GeocodedPlace[];
  expires_at: number;
}

/** In-memory geocode cache: 500 entries, 24 h TTL, keyed by the exact request. */
export class GeocodeCache {
  private readonly entries = new Map<string, GeocodeCacheEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): GeocodedPlace[] | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expires_at <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.places;
  }

  set(key: string, places: GeocodedPlace[]): void {
    if (this.entries.size >= GEOCODE_CACHE_MAX_ENTRIES && !this.entries.has(key)) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { places, expires_at: this.now() + GEOCODE_CACHE_TTL_MS });
  }
}

export interface MapsServiceDeps {
  geocoder_url: string;
  router_provider: MapsRoutingProvider;
  logger: Logger;
  fetch_limited: (url: string) => Promise<Response>;
}

/** Server-side maps service: geocoding, POI search, routing. */
export class MapsService {
  private readonly geocodeLimiter = new UpstreamLimiter();
  private readonly routeLimiter = new UpstreamLimiter();
  private readonly geocodeCache = new GeocodeCache();

  constructor(private readonly deps: MapsServiceDeps) {}

  /** Geocode a place name; returns the top match or null. */
  async geocode(place: string): Promise<GeocodedPlace | null> {
    const cacheKey = `search:${place}`;
    const cached = this.geocodeCache.get(cacheKey);
    if (cached !== undefined) {
      return cached[0] ?? null;
    }
    const url = `${this.deps.geocoder_url}/search?q=${encodeURIComponent(place)}&format=jsonv2&limit=1&addressdetails=1`;
    let response: Response;
    try {
      response = await this.geocodeLimiter.run(() => this.deps.fetch_limited(url));
    } catch (error) {
      throw new MapsUpstreamError('service_unavailable', 'geocoder', error);
    }
    if (response.status === 429) {
      throw new MapsUpstreamError('rate_limited', 'geocoder');
    }
    if (!response.ok) {
      throw new MapsUpstreamError('service_unavailable', 'geocoder');
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body) || body.length === 0) {
      return null;
    }
    const parsed = nominatimResultSchema.safeParse(body[0]);
    if (!parsed.success) {
      throw new MapsUpstreamError('service_unavailable', 'geocoder');
    }
    const place0 = toGeocodedPlace(parsed.data);
    this.geocodeCache.set(cacheKey, [place0]);
    return place0;
  }

  /** POI search near a geocoded place; zero hits is not an error. */
  async searchPoi(place: GeocodedPlace, poi: string): Promise<GeocodedPlace[]> {
    const bbox = place.bounding_box;
    const viewbox =
      bbox !== null
        ? `${String(bbox[2])},${String(bbox[0])},${String(bbox[3])},${String(bbox[1])}`
        : `${String(place.lng - 0.1)},${String(place.lat - 0.1)},${String(place.lng + 0.1)},${String(place.lat + 0.1)}`;
    const cacheKey = `poi:${poi}:${viewbox}`;
    const cached = this.geocodeCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const url =
      `${this.deps.geocoder_url}/search?q=${encodeURIComponent(poi)}` +
      `&viewbox=${viewbox}&bounded=1&limit=${String(MAX_POI_PINS)}&format=jsonv2&addressdetails=1`;
    let response: Response;
    try {
      response = await this.geocodeLimiter.run(() => this.deps.fetch_limited(url));
    } catch (error) {
      throw new MapsUpstreamError('service_unavailable', 'geocoder', error);
    }
    if (response.status === 429) {
      throw new MapsUpstreamError('rate_limited', 'geocoder');
    }
    if (!response.ok) {
      throw new MapsUpstreamError('service_unavailable', 'geocoder');
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      throw new MapsUpstreamError('service_unavailable', 'geocoder');
    }
    const places: GeocodedPlace[] = [];
    for (const item of body.slice(0, MAX_POI_PINS)) {
      const parsed = nominatimResultSchema.safeParse(item);
      if (parsed.success) {
        places.push(toGeocodedPlace(parsed.data));
      }
    }
    this.geocodeCache.set(cacheKey, places);
    return places;
  }

  /** Route between two geocoded places via the configured provider. */
  async route(from: GeocodedPlace, to: GeocodedPlace): Promise<MapsRouteResult> {
    try {
      return await this.routeLimiter.run(() =>
        this.deps.router_provider.route({
          from_lat: from.lat,
          from_lng: from.lng,
          to_lat: to.lat,
          to_lng: to.lng,
        }),
      );
    } catch (error) {
      if (error instanceof MapsUpstreamError) {
        throw error;
      }
      throw new MapsUpstreamError('service_unavailable', 'router', error);
    }
  }
}

function toGeocodedPlace(data: z.infer<typeof nominatimResultSchema>): GeocodedPlace {
  const lat = Number(data.lat);
  const lng = Number(data.lon);
  let bounding_box: GeocodedPlace['bounding_box'] = null;
  if (data.boundingbox?.length === 4) {
    const [southRaw, northRaw, westRaw, eastRaw] = data.boundingbox;
    const south = Number(southRaw);
    const north = Number(northRaw);
    const west = Number(westRaw);
    const east = Number(eastRaw);
    if ([south, north, west, east].every(Number.isFinite)) {
      bounding_box = [south, north, west, east];
    }
  }
  return {
    resolved_name: data.display_name,
    address: data.display_name,
    lat,
    lng,
    bounding_box,
  };
}

function mapsErrorResult(error: MapsUpstreamError, field?: string): ReturnType<typeof toolResultResponse> {
  const body: MapsErrorBody = { status: 'error', code: error.code };
  if (field !== undefined) {
    body.field = field;
  }
  if (error.service !== undefined) {
    body.service = error.service;
  }
  return toolResultResponse({ text: JSON.stringify(body), isError: true });
}

class MapsTool extends LocalToolMCP {
  readonly name = MAPS_SERVER_ID;
  readonly displayName = 'Maps';

  constructor(
    private readonly service: MapsService,
    private readonly logger: Logger,
    tracing: AgentTracing,
  ) {
    super({ tracing });
  }

  /** Stamp the configured upstream hosts for the classifier card destination. */
  override async toolCallInfo(
    params: Parameters<LocalToolMCP['toolCallInfo']>[0],
    resolveUnderlyingTool?: boolean,
  ): Promise<Awaited<ReturnType<LocalToolMCP['toolCallInfo']>>> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    return {
      ...info,
      maps_hosts: {
        geocoder: configuration.MAPS_GEOCODER_URL,
        router: configuration.MAPS_ROUTER_URL,
        tile: configuration.MAPS_TILE_URL,
      },
    };
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: RENDER_MAP_TOOL_NAME,
      description:
        "Render an interactive map with a pin for a named place. Pass the place name as the user gave it (e.g. 'Paris', 'Eiffel Tower'); never pass coordinates. The tool geocodes the name and returns an inline map card; the user is asked to approve each call. Use when the user explicitly asks to see a place on a map, asks where a place is, or asks for a kind of place near a named place.",
      schema: RENDER_MAP_INPUT_SCHEMA,
      handler: async input => this.renderMap(input),
    }),
    defineTool({
      name: RENDER_ROUTE_TOOL_NAME,
      description:
        "Render a route map between two named places. Pass both place names as the user gave them (e.g. from_place 'Madrid', to_place 'Barcelona'); never pass coordinates. The tool geocodes both endpoints, routes by road, and returns an inline map card with the route, distance, and duration; the user is asked to approve each call. Use only when the user has named both the origin and the destination; there is no current-location mode.",
      schema: RENDER_ROUTE_INPUT_SCHEMA,
      handler: async input => this.renderRoute(input),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  private async renderMap(input: RenderMapInput): Promise<ReturnType<typeof toolResultResponse>> {
    try {
      const place = await this.service.geocode(input.place_name);
      if (place === null) {
        return mapsErrorResult(new MapsUpstreamError('not_found'));
      }
      const pins = input.poi === undefined ? [] : await this.service.searchPoi(place, input.poi);
      return toolResultResponse({
        text: JSON.stringify({
          status: 'ok',
          resolved_name: place.resolved_name,
          address: place.address,
          lat: place.lat,
          lng: place.lng,
          zoom: input.zoom,
          pins: pins.map(pin => ({ name: pin.resolved_name, lat: pin.lat, lng: pin.lng })),
          attribution: '© OpenStreetMap contributors',
        }),
      });
    } catch (error) {
      if (error instanceof MapsUpstreamError) {
        return mapsErrorResult(error);
      }
      this.logger.error('render_map failed', { error });
      return mapsErrorResult(new MapsUpstreamError('service_unavailable', 'geocoder', error));
    }
  }

  private async renderRoute(input: RenderRouteInput): Promise<ReturnType<typeof toolResultResponse>> {
    try {
      const from = await this.service.geocode(input.from_place);
      if (from === null) {
        return mapsErrorResult(new MapsUpstreamError('not_found'), 'from_place');
      }
      const to = await this.service.geocode(input.to_place);
      if (to === null) {
        return mapsErrorResult(new MapsUpstreamError('not_found'), 'to_place');
      }
      const route = await this.service.route(from, to);
      return toolResultResponse({
        text: JSON.stringify({
          status: 'ok',
          from: { resolved_name: from.resolved_name, lat: from.lat, lng: from.lng },
          to: { resolved_name: to.resolved_name, lat: to.lat, lng: to.lng },
          distance_km: route.distance_km,
          duration_min: route.duration_min,
          ...(route.traffic ? { traffic: true } : {}),
          route_geometry: route.geometry,
          attribution: '© OpenStreetMap contributors',
        }),
      });
    } catch (error) {
      if (error instanceof MapsUpstreamError) {
        return mapsErrorResult(error);
      }
      this.logger.error('render_route failed', { error });
      return mapsErrorResult(new MapsUpstreamError('service_unavailable', 'router', error));
    }
  }
}

export interface MapsCapabilityOptions {
  tracing: AgentTracing;
  logger: Logger;
}

/** Build the maps capability from server config. One instance per server. */
export function mapsCapability(options: MapsCapabilityOptions): AgentCapability {
  const user_agent = configuration.MAPS_USER_AGENT;
  // The fetch wrapper attaches the identifying User-Agent and strips nothing
  // else: these are server-to-upstream requests, never browser requests.
  const fetch_limited = (url: string): Promise<Response> =>
    fetch(url, {
      headers: { 'User-Agent': user_agent, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  const router_provider = createMapsRoutingProvider({
    provider_id: configuration.MAPS_ROUTER_PROVIDER,
    router_url: configuration.MAPS_ROUTER_URL,
    fetch_limited,
  });
  const service = new MapsService({
    geocoder_url: configuration.MAPS_GEOCODER_URL,
    router_provider,
    logger: options.logger,
    fetch_limited,
  });
  return {
    systemToolSets: [new MapsTool(service, options.logger, options.tracing)],
  };
}

/**
 * Embedded maps: `render_map`, `render_route` and `render_places` model-callable tools.
 *
 * The tools run in the server process, not the sandbox. Each call geocodes
 * place names through the configured geocoder and (for routes) asks the
 * routing service for the chosen travel mode. Map tiles reach the browser
 * only through the same-origin tile proxy (`/api/maps/tiles/{z}/{x}/{y}.png`);
 * the tool results carry coordinates and metadata, never tile URLs.
 *
 * Every call is Tier 3 (see the maps branch in the Sentinel classifier). The
 * tools are registered in FIRST_PARTY_REQUIRES_NETWORK, so offline mode filters
 * them from the model's tool list and auto-denies stale calls.
 */
import type { AgentCapability, AgentTracing, ConnectorBinding } from '@truefoundry/trueforge-core/core';
import {
  DEFAULT_MAPS_TRAVEL_MODE,
  defineTool,
  fetchedPages,
  groundPlace,
  isInCalendar,
  LocalToolMCP,
  mapsDestinationHosts,
  MapsTravelModeSchema,
  normalizedWords,
  RENDER_MAP_TOOL_NAME,
  RENDER_PLACES_TOOL_NAME,
  RENDER_ROUTE_TOOL_NAME,
  resolveLocalTime,
  toolResultResponse,
  type FetchedPageScope,
  type FetchedPageStore,
  type MapsRouteResult as MapsRouteResultBody,
  type MapsTravelMode,
  type PreSendContextProcessor,
  type ToolDefinition,
} from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import { z } from 'zod';
import configuration from '../config';
import { MapsUpstreamError, type MapsErrorBody } from './mapsErrors';
import { MAX_GEOMETRY_CHARS, thinPolyline } from './mapsPolyline';
import {
  MotisTransitProvider,
  resolveTransitTime,
  type MapsTransitPlan,
  type MapsTransitProvider,
} from './mapsTransit';
import { fetchSameOrigin, readCappedJson } from './mapsUpstream';

export const MAPS_SERVER_ID = 'maps';

/**
 * Origin privacy: coordinates sent to a routing provider for the origin are
 * rounded to this many decimal places (3 is about 100 m). The destination is
 * not rounded. One constant controls the precision, applied in MapsService so
 * every provider receives a rounded origin.
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

const MAPS_ATTRIBUTION = '© OpenStreetMap contributors';

const DEFAULT_ZOOM = 13;
const MAX_POI_PINS = 5;

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
    mode: MapsTravelModeSchema.default(DEFAULT_MAPS_TRAVEL_MODE),
    depart_at: z.string().min(1).max(40).optional(),
    arrive_by: z.string().min(1).max(40).optional(),
  })
  .strict();

const PLACE_TEXT_SCHEMA = z.string().min(1).max(128);
const MAX_PLACES = 3;
const MAX_CALENDAR_LOCATIONS = 10;

/** One place as the model read it off a fetched page; the host keeps only what that page really says. */
const PLACE_CLAIM_SCHEMA = z
  .object({
    name: PLACE_TEXT_SCHEMA,
    address: PLACE_TEXT_SCHEMA,
    languages: PLACE_TEXT_SCHEMA.optional(),
    hours: PLACE_TEXT_SCHEMA.optional(),
    price: PLACE_TEXT_SCHEMA.optional(),
    phone: PLACE_TEXT_SCHEMA.optional(),
    source_url: z.string().min(1),
  })
  .strict();

const RENDER_PLACES_INPUT_SCHEMA = z
  .object({
    places: z.array(PLACE_CLAIM_SCHEMA).min(1).max(MAX_PLACES),
    calendar_locations: z.array(PLACE_TEXT_SCHEMA).max(MAX_CALENDAR_LOCATIONS).default([]),
  })
  .strict();

export type RenderMapInput = z.infer<typeof RENDER_MAP_INPUT_SCHEMA>;
export type RenderRouteInput = z.infer<typeof RENDER_ROUTE_INPUT_SCHEMA>;
export type RenderPlacesInput = z.infer<typeof RENDER_PLACES_INPUT_SCHEMA>;

export interface GeocodedPlace {
  resolved_name: string;
  address: string | null;
  lat: number;
  lng: number;
  /** Bounding box [south, north, west, east] for POI viewbox searches. */
  bounding_box: [number, number, number, number] | null;
}

/** Routing provider interface: the provider id plus URL come from config. */
/** Origin coordinates arrive already rounded by MapsService. */
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

/** OSRM-compatible routing provider. The profile comes from the server the base URL points at. */
class OsrmRoutingProvider implements MapsRoutingProvider {
  readonly provider_id = 'osrm';

  // The driving path segment is kept for every profile: FOSSGIS selects foot or bike by base path.
  constructor(
    private readonly base_url: string,
    private readonly fetch_limited: (url: string) => Promise<Response>,
  ) {}

  async route(input: MapsRouteRequest): Promise<MapsRouteResult> {
    const url =
      `${this.base_url}/route/v1/driving/${String(input.from_lng)},${String(input.from_lat)};${String(input.to_lng)},${String(input.to_lat)}` +
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
    const body = await readCappedJson(response);
    if (body === null) {
      throw new MapsUpstreamError('service_unavailable', 'router');
    }
    const parsed = osrmRouteSchema.safeParse(body.value);
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

export type MapsRoadMode = Exclude<MapsTravelMode, 'transit'>;

export interface MapsServiceDeps {
  geocoder_url: string;
  road_providers: Record<MapsRoadMode, MapsRoutingProvider>;
  transit_provider: MapsTransitProvider;
  logger: Logger;
  fetch_limited: (url: string) => Promise<Response>;
}

/** Server-side maps service: geocoding, POI search, road and public transport routing. */
export class MapsService {
  private readonly geocodeLimiter = new UpstreamLimiter();
  private readonly routeLimiter = new UpstreamLimiter();
  private readonly transitLimiter = new UpstreamLimiter();
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
    const json = await readCappedJson(response);
    if (json === null) {
      throw new MapsUpstreamError('service_unavailable', 'geocoder');
    }
    const body = json.value;
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
    const json = await readCappedJson(response);
    const body = json?.value;
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

  /** Road route between two geocoded places for walking, cycling or driving. */
  async route({
    from,
    to,
    mode,
  }: {
    from: GeocodedPlace;
    to: GeocodedPlace;
    mode: MapsRoadMode;
  }): Promise<MapsRouteResult> {
    try {
      return await this.routeLimiter.run(() =>
        this.deps.road_providers[mode].route({
          // Origin privacy: round the origin before any provider can send it off the machine.
          from_lat: roundOriginCoordinate(from.lat),
          from_lng: roundOriginCoordinate(from.lng),
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

  /** Public transport itinerary between two geocoded places. */
  async planTransit({
    from,
    to,
    time,
    arrive_by,
    timezone,
  }: {
    from: GeocodedPlace;
    to: GeocodedPlace;
    time: string | null;
    arrive_by: boolean;
    timezone: string;
  }): Promise<MapsTransitPlan> {
    try {
      return await this.transitLimiter.run(() =>
        this.deps.transit_provider.plan({
          from_lat: roundOriginCoordinate(from.lat),
          from_lng: roundOriginCoordinate(from.lng),
          to_lat: to.lat,
          to_lng: to.lng,
          time,
          arrive_by,
          fallback_timezone: timezone,
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

function mapsErrorResult({
  error,
  field,
  mode,
  refused,
  stop,
}: {
  error: MapsUpstreamError;
  field?: string;
  mode?: MapsTravelMode;
  refused?: { name: string; reason: string }[];
  stop?: string | undefined;
}): ReturnType<typeof toolResultResponse> {
  const body: MapsErrorBody = { status: 'error', code: error.code };
  if (refused !== undefined) {
    body.refused = refused;
  }
  if (stop !== undefined) {
    body.stop = stop;
  }
  if (field !== undefined) {
    body.field = field;
  }
  if (error.service !== undefined) {
    body.service = error.service;
  }
  if (mode !== undefined) {
    body.mode = mode;
    if (error.code === 'no_route' && mode === 'transit') {
      body.try_instead = 'walking';
    }
  }
  return toolResultResponse({ text: JSON.stringify(body), isError: true });
}

/** A refused place may be sent once more in the same turn; a second refusal ends the map for it. */
const MAX_PLACE_REFUSALS_PER_TURN = 2;

const TURN_LIMIT_REASON = 'This place was refused twice in this answer. Stop trying the map for it.';

const PLACE_STOP_MESSAGE =
  'The map check refused these places twice in this answer. Stop trying the map. Answer in text instead: give each place with its address and its link, and say the map could not check it.';

/** Refusals per place in the current turn. The next turn starts with a clear count. */
export class PlaceRefusalLedger {
  readonly #refusals = new Map<string, number>();

  refusalsOf(key: string): number {
    return this.#refusals.get(key) ?? 0;
  }

  record(key: string): void {
    this.#refusals.set(key, this.refusalsOf(key) + 1);
  }

  startTurn(): void {
    this.#refusals.clear();
  }
}

function placeKey(place: { name: string; address: string; source_url: string }): string {
  return `${place.source_url}\u0000${normalizedWords(place.name)}\u0000${normalizedWords(place.address)}`;
}

const REFUSAL_REASONS = {
  source_not_fetched:
    'Aman has not read that page, so the details cannot be checked. Read that page first, then try again.',
  name_not_found: 'The name is not on that page. Copy it word for word from the page and try again.',
  address_not_found: 'The address is not on that page. Copy it word for word from the page and try again.',
  place_only_in_address:
    "That place only appears in the page's web address. Read a page that lists it, then try again.",
  address_apart_from_name:
    'The name and address are not together on that page. Copy them from one listing and try again.',
} as const;

const OUT_OF_AREA_REASON =
  'The place the map found is in a different area. Try again with a fuller address, adding the town or postcode.';

/**
 * US states, under the spellings normalizedWords folds their names to, with the code a geocoder
 * shortens them to. A query and a result may spell the same state either way, so both forms count
 * as the same area, and a different state in the result contradicts the one the query named.
 */
const US_STATE_CODES: Readonly<Record<string, string>> = {
  alabama: 'al',
  alaska: 'ak',
  arizona: 'az',
  arkansas: 'ar',
  california: 'ca',
  colorado: 'co',
  connecticut: 'ct',
  delaware: 'de',
  'district of columbia': 'dc',
  florida: 'fl',
  georgia: 'ga',
  hawaii: 'hi',
  idaho: 'id',
  illinois: 'il',
  indiana: 'in',
  iowa: 'ia',
  kansas: 'ks',
  kentucky: 'ky',
  louisiana: 'la',
  maine: 'me',
  maryland: 'md',
  massachusetts: 'ma',
  michigan: 'mi',
  minnesota: 'mn',
  mississippi: 'ms',
  missouri: 'mo',
  montana: 'mt',
  nebraska: 'ne',
  nevada: 'nv',
  'new hampshire': 'nh',
  'new jersey': 'nj',
  'new mexico': 'nm',
  'new york': 'ny',
  'n carolina': 'nc',
  'n dakota': 'nd',
  ohio: 'oh',
  oklahoma: 'ok',
  oregon: 'or',
  pennsylvania: 'pa',
  'rhode island': 'ri',
  's carolina': 'sc',
  's dakota': 'sd',
  tennessee: 'tn',
  texas: 'tx',
  utah: 'ut',
  vermont: 'vt',
  virginia: 'va',
  washington: 'wa',
  'w virginia': 'wv',
  wisconsin: 'wi',
  wyoming: 'wy',
};

const US_STATE_NAMES_BY_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(US_STATE_CODES).map(([name, code]) => [code, name]),
);
const US_STATE_CODE_SET: ReadonlySet<string> = new Set(Object.values(US_STATE_CODES));

/** The spellings one area part may appear under: itself, plus the other form of a US state. */
function areaSpellings(tokens: readonly string[]): string[] {
  const phrase = tokens.join(' ');
  const code = US_STATE_CODES[phrase];
  if (code !== undefined) {
    return [phrase, code];
  }
  if (tokens.length === 1 && US_STATE_CODE_SET.has(phrase)) {
    const name = US_STATE_NAMES_BY_CODE[phrase];
    return name === undefined ? [phrase] : [phrase, name];
  }
  return [phrase];
}

/** Whether an area part appears in the result name under any of its spellings. */
function areaPartAppears(tokens: readonly string[], displayWords: string): boolean {
  return areaSpellings(tokens).some(spelling => displayWords.includes(` ${spelling} `));
}

/** The US state code an area part names, spelled out or as the code itself; undefined for any other part. */
function stateCodeOf(tokens: readonly string[]): string | undefined {
  const phrase = tokens.join(' ');
  const code = US_STATE_CODES[phrase];
  if (code !== undefined) {
    return code;
  }
  return tokens.length === 1 && US_STATE_CODE_SET.has(phrase) ? phrase : undefined;
}

/** Whether the result name names a US state of its own, by name or by code, other than the given one. */
function displayNamesOtherState({ displayWords, ownCode }: { displayWords: string; ownCode: string }): boolean {
  for (const [name, code] of Object.entries(US_STATE_CODES)) {
    if (code !== ownCode && displayWords.includes(` ${name} `)) {
      return true;
    }
  }
  return displayWords.split(' ').some(token => token !== '' && token !== ownCode && US_STATE_CODE_SET.has(token));
}

/**
 * Whether a geocoder result sits in the area the query itself names. The area is what follows the
 * first comma, in parts. It matches when every long number after the comma (a postcode) appears
 * in the result name, or when the last part (the region) appears there, spelled out or, for a US
 * state, as its code. The first part matching counts too, unless a later part names a US state
 * the result contradicts with a different state of its own; parts between the two, such as a
 * district, may be left out by the geocoder. A query that names no area passes.
 */
export function isInRequestedArea({ query, displayName }: { query: string; displayName: string }): boolean {
  const segments = query.split(',');
  if (segments.length < 2) {
    return true;
  }
  const areaParts = segments
    .slice(1)
    .map(segment =>
      normalizedWords(segment)
        .trim()
        .split(' ')
        .filter(token => /^\p{L}+$/u.test(token)),
    )
    .filter(part => part.length > 0);
  const numbers: string[] =
    segments
      .slice(1)
      .join(',')
      .match(/\d{3,}/g) ?? [];
  if (areaParts.length === 0 && numbers.length === 0) {
    return true;
  }
  const displayNumbers: string[] = displayName.match(/\d{3,}/g) ?? [];
  if (numbers.length > 0 && numbers.every(number => displayNumbers.includes(number))) {
    return true;
  }
  if (areaParts.length === 0) {
    return false;
  }
  const displayWords = normalizedWords(displayName);
  const lastPart = areaParts[areaParts.length - 1];
  if (lastPart !== undefined && areaPartAppears(lastPart, displayWords)) {
    return true;
  }
  const firstPart = areaParts[0];
  if (firstPart === undefined || !areaPartAppears(firstPart, displayWords)) {
    return false;
  }
  return !areaParts.slice(1).some(part => {
    const code = stateCodeOf(part);
    return (
      code !== undefined &&
      !areaPartAppears(part, displayWords) &&
      displayNamesOtherState({ displayWords, ownCode: code })
    );
  });
}

/**
 * Pins places the model found on pages this server fetched for this chat. A place is kept only
 * when its name and address are on its source page, and each detail only when the page states it;
 * the source and the fetch time are the server's. Only the addresses go to the geocoder.
 */
export async function renderPlaces({
  service,
  pages,
  scope,
  retries,
  input,
}: {
  service: MapsService;
  pages: FetchedPageStore;
  scope: FetchedPageScope;
  retries: PlaceRefusalLedger;
  input: RenderPlacesInput;
}): Promise<ReturnType<typeof toolResultResponse>> {
  const refused: { name: string; reason: string }[] = [];
  const grounded = [];
  // Once a place has been refused twice this turn, it is not checked again.
  const stopIfSpent = (): string | undefined =>
    input.places.some(claim => retries.refusalsOf(placeKey(claim)) >= MAX_PLACE_REFUSALS_PER_TURN)
      ? PLACE_STOP_MESSAGE
      : undefined;
  for (const claim of input.places) {
    if (retries.refusalsOf(placeKey(claim)) >= MAX_PLACE_REFUSALS_PER_TURN) {
      refused.push({ name: claim.name, reason: TURN_LIMIT_REASON });
      continue;
    }
    const result = groundPlace({
      claim: {
        name: claim.name,
        address: claim.address,
        languages: claim.languages ?? null,
        hours: claim.hours ?? null,
        price: claim.price ?? null,
        phone: claim.phone ?? null,
        source_url: claim.source_url,
      },
      pages,
      scope,
    });
    if (result.ok) {
      grounded.push(result.place);
    } else {
      retries.record(placeKey(claim));
      refused.push({ name: claim.name, reason: REFUSAL_REASONS[result.reason] });
    }
  }
  if (grounded.length === 0) {
    return mapsErrorResult({ error: new MapsUpstreamError('not_grounded'), refused, stop: stopIfSpent() });
  }
  try {
    const places = [];
    for (const place of grounded) {
      const found = await service.geocode(place.address);
      if (found !== null && !isInRequestedArea({ query: place.address, displayName: found.resolved_name })) {
        retries.record(placeKey(place));
        refused.push({ name: place.name, reason: OUT_OF_AREA_REASON });
        continue;
      }
      places.push({
        ...place,
        lat: found?.lat ?? null,
        lng: found?.lng ?? null,
        already_in_calendar: isInCalendar({ place, locations: input.calendar_locations }),
      });
    }
    const stop = stopIfSpent();
    if (places.length === 0) {
      return mapsErrorResult({ error: new MapsUpstreamError('not_grounded'), refused, stop });
    }
    return toolResultResponse({
      text: JSON.stringify({
        status: 'ok',
        places,
        refused,
        attribution: MAPS_ATTRIBUTION,
        ...(stop === undefined ? {} : { stop }),
      }),
    });
  } catch (error) {
    if (error instanceof MapsUpstreamError) {
      return mapsErrorResult({ error });
    }
    throw error;
  }
}

class MapsTool extends LocalToolMCP {
  readonly name = MAPS_SERVER_ID;
  readonly displayName = 'Maps';

  constructor(
    private readonly service: MapsService,
    private readonly pagesScope: FetchedPageScope,
    private readonly logger: Logger,
    private readonly timezone: string,
    private readonly retries: PlaceRefusalLedger,
    tracing: AgentTracing,
  ) {
    super({ tracing });
  }

  private upstreamHosts() {
    return {
      geocoder: configuration.MAPS_GEOCODER_URL,
      router: configuration.MAPS_ROUTER_URL,
      walking: configuration.MAPS_WALKING_ROUTER_URL,
      cycling: configuration.MAPS_CYCLING_ROUTER_URL,
      transit: configuration.MAPS_TRANSIT_URL,
      tile: configuration.MAPS_TILE_URL,
    };
  }

  /** Rebuilt from config at dispatch, so an approval stops working once an upstream host changes. */
  resolveConnector(): ConnectorBinding {
    return { server_id: MAPS_SERVER_ID, destination_host: mapsDestinationHosts(this.upstreamHosts()) };
  }

  /** Stamp the configured upstream hosts for the classifier card destination. */
  override async toolCallInfo(
    params: Parameters<LocalToolMCP['toolCallInfo']>[0],
    resolveUnderlyingTool?: boolean,
  ): Promise<Awaited<ReturnType<LocalToolMCP['toolCallInfo']>>> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    return {
      ...info,
      maps_hosts: this.upstreamHosts(),
    };
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: RENDER_MAP_TOOL_NAME,
      description:
        "Render an interactive map with a pin for a named place. Pass the place name as the user gave it (e.g. 'Paris', 'Eiffel Tower'); never pass coordinates. The tool geocodes the name and returns an inline map card; the user is asked to approve each call. Use only for a place or address the user typed themselves. A place that came from a web page goes through render_places instead, never this tool. Use when the user explicitly asks to see a place on a map, asks where a place is, or asks for a kind of place near a named place.",
      schema: RENDER_MAP_INPUT_SCHEMA,
      handler: async input => this.renderMap(input),
    }),
    defineTool({
      name: RENDER_ROUTE_TOOL_NAME,
      description:
        "Render a route map between two named places, by walking, cycling, driving or public transport (transit). Pass both place names as the user gave them (e.g. from_place 'Chiado, Lisboa', to_place 'Basilica da Estrela, Lisboa'); never pass coordinates. Pick mode from the user's words; when they do not say, in a city prefer walking for a short trip and transit for a longer one, and mention the other options in the answer. For transit, depart_at or arrive_by (local time like 2026-10-19T09:20, in the user's timezone) answers 'I need to be there at 9:20'; leave both out to leave now. The tool geocodes both endpoints and returns an inline map card with the route, distance, and duration; transit also lists the steps. If no transit route is found, say so and offer walking. The user is asked to approve each call. Use only when the user has named both the origin and the destination; there is no current-location mode.",
      schema: RENDER_ROUTE_INPUT_SCHEMA,
      handler: async input => this.renderRoute(input),
    }),
    defineTool({
      name: RENDER_PLACES_TOOL_NAME,
      description:
        "Pin places on one map card, each with the details found on the page it came from. Use after a page reading tool has read the pages, whichever one it was: tavily_extract, web_fetch, or another provider's fetch tool all count. Copy each name, address, language, opening hours, price and phone word for word from the page text; leave a detail out when the page does not state it. Short forms such as St for Street are fine. Pass the page's own link as source_url. Every refused place comes back with its name and the reason, so fix that one detail and call again for it, once. If a place is refused a second time in the same answer, the tool says to stop trying the map: answer in text with the places and their links instead. If the user's calendar already lists a place, pass its location text in calendar_locations. The tool checks every detail against the page and drops what it cannot find; the user is asked to approve each call.",
      schema: RENDER_PLACES_INPUT_SCHEMA,
      handler: async input =>
        renderPlaces({
          service: this.service,
          pages: fetchedPages,
          scope: this.pagesScope,
          retries: this.retries,
          input,
        }),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  private async renderMap(input: RenderMapInput): Promise<ReturnType<typeof toolResultResponse>> {
    try {
      const place = await this.service.geocode(input.place_name);
      if (place === null || !isInRequestedArea({ query: input.place_name, displayName: place.resolved_name })) {
        return mapsErrorResult({ error: new MapsUpstreamError('not_found') });
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
          attribution: MAPS_ATTRIBUTION,
        }),
      });
    } catch (error) {
      if (error instanceof MapsUpstreamError) {
        return mapsErrorResult({ error });
      }
      this.logger.error('render_map failed', { error });
      return mapsErrorResult({ error: new MapsUpstreamError('service_unavailable', 'geocoder', error) });
    }
  }

  private async renderRoute(input: RenderRouteInput): Promise<ReturnType<typeof toolResultResponse>> {
    const { mode } = input;
    try {
      const when = this.resolveWhen(input);
      if (when instanceof MapsUpstreamError) {
        return mapsErrorResult({ error: when, mode, field: input.arrive_by === undefined ? 'depart_at' : 'arrive_by' });
      }
      const from = await this.service.geocode(input.from_place);
      if (from === null) {
        return mapsErrorResult({ error: new MapsUpstreamError('not_found'), mode, field: 'from_place' });
      }
      const to = await this.service.geocode(input.to_place);
      if (to === null) {
        return mapsErrorResult({ error: new MapsUpstreamError('not_found'), mode, field: 'to_place' });
      }
      const endpoints = {
        from: { resolved_name: from.resolved_name, lat: from.lat, lng: from.lng },
        to: { resolved_name: to.resolved_name, lat: to.lat, lng: to.lng },
      };
      let body: MapsRouteResultBody;
      if (mode === 'transit') {
        const plan = await this.service.planTransit({ from, to, ...when, timezone: this.timezone });
        body = {
          status: 'ok',
          mode,
          ...endpoints,
          distance_km: plan.distance_km,
          duration_min: plan.duration_min,
          departs: plan.departs,
          arrives: plan.arrives,
          transfers: plan.transfers,
          steps: plan.steps,
          route_geometry: plan.geometry,
          attribution: MAPS_ATTRIBUTION,
        };
      } else {
        const route = await this.service.route({ from, to, mode });
        const road = {
          status: 'ok',
          ...endpoints,
          distance_km: route.distance_km,
          duration_min: route.duration_min,
          route_geometry: route.geometry,
          attribution: MAPS_ATTRIBUTION,
        } as const;
        body = mode === 'driving' ? { ...road, mode, ...(route.traffic ? { traffic: true } : {}) } : { ...road, mode };
      }
      return toolResultResponse({ text: JSON.stringify(body) });
    } catch (error) {
      if (error instanceof MapsUpstreamError) {
        return mapsErrorResult({ error, mode });
      }
      this.logger.error('render_route failed', { error });
      return mapsErrorResult({ error: new MapsUpstreamError('service_unavailable', 'router', error), mode });
    }
  }

  /** The transit time as an offset ISO string, or an invalid_time error. Other modes ignore times. */
  private resolveWhen(input: RenderRouteInput): { time: string | null; arrive_by: boolean } | MapsUpstreamError {
    if (input.mode !== 'transit') {
      return { time: null, arrive_by: false };
    }
    if (input.depart_at !== undefined && input.arrive_by !== undefined) {
      return new MapsUpstreamError('invalid_time');
    }
    const requested = input.arrive_by ?? input.depart_at;
    if (requested === undefined) {
      return { time: null, arrive_by: false };
    }
    const time = resolveTransitTime({ local: requested, timezone: this.timezone });
    return time === null ? new MapsUpstreamError('invalid_time') : { time, arrive_by: input.arrive_by !== undefined };
  }
}

export interface MapsCapabilityOptions {
  tracing: AgentTracing;
  logger: Logger;
  /** The tenant and chat read pages are checked for; a page read in another chat does not count. */
  pages_scope: FetchedPageScope;
  /** IANA zone the user's local times are read in; UTC when the client sent none. */
  timezone?: string | undefined;
}

/** Starts each turn with no place refusals counted, so a new answer gets its own retry. */
function clearPlaceRefusalsEachTurn(retries: PlaceRefusalLedger): PreSendContextProcessor {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- async *: AsyncIterable contract; body is sync
    async *processPreSend() {
      retries.startTurn();
      // Adds nothing to the context; the generator only has to finish.
      yield* [];
    },
  };
}

/** Build the maps capability from server config. One instance per server. */
export function mapsCapability(options: MapsCapabilityOptions): AgentCapability {
  const user_agent = configuration.MAPS_USER_AGENT;
  // The fetch wrapper attaches the identifying User-Agent and strips nothing
  // else: these are server-to-upstream requests, never browser requests.
  const fetch_limited = (url: string): Promise<Response> =>
    fetchSameOrigin({
      url,
      headers: { 'User-Agent': user_agent, Accept: 'application/json' },
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
  const road_providers: Record<MapsRoadMode, MapsRoutingProvider> = {
    driving: createMapsRoutingProvider({
      provider_id: configuration.MAPS_ROUTER_PROVIDER,
      router_url: configuration.MAPS_ROUTER_URL,
      fetch_limited,
    }),
    walking: createMapsRoutingProvider({
      provider_id: configuration.MAPS_ROUTER_PROVIDER,
      router_url: configuration.MAPS_WALKING_ROUTER_URL,
      fetch_limited,
    }),
    cycling: createMapsRoutingProvider({
      provider_id: configuration.MAPS_ROUTER_PROVIDER,
      router_url: configuration.MAPS_CYCLING_ROUTER_URL,
      fetch_limited,
    }),
  };
  const retries = new PlaceRefusalLedger();
  const service = new MapsService({
    geocoder_url: configuration.MAPS_GEOCODER_URL,
    road_providers,
    transit_provider: new MotisTransitProvider(configuration.MAPS_TRANSIT_URL, fetch_limited),
    logger: options.logger,
    fetch_limited,
  });
  return {
    systemToolSets: [
      new MapsTool(
        service,
        options.pages_scope,
        options.logger,
        resolveLocalTime(new Date(), options.timezone).zone,
        retries,
        options.tracing,
      ),
    ],
    preSendProcessors: [clearPlaceRefusalsEachTurn(retries)],
  };
}

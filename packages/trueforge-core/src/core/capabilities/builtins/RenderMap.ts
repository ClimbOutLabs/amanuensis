import { z } from 'zod';
import { type CallToolResponse, toolResultResponse } from '../../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../mcp/LocalToolMCP';
import type { AgentTracing } from '../../tracing/AgentTracing';
import type { AgentCapability } from '../AgentCapability';

export const RENDER_MAP_SERVER_ID = 'render-map';
export const RENDER_MAP_TOOL_NAME = 'render_map';
export const RENDER_ROUTE_TOOL_NAME = 'render_route';

export interface MapPoiPin {
  name: string;
  lat: number;
  lng: number;
}

export interface RenderMapResult {
  map_card_id: string;
  resolved_name: string;
  address?: string | undefined;
  lat: number;
  lng: number;
  zoom: number;
  pins?: MapPoiPin[] | undefined;
}

export interface RenderRouteResult {
  map_card_id: string;
  from_resolved: string;
  to_resolved: string;
  distance_km: number;
  duration_min: number;
  route_geometry: string;
}

// A descriptive User-Agent on every map API request (Nominatim's usage policy
// requires it; OSRM and Overpass ask for one too).
const NOMINATIM_USER_AGENT = 'Amanuensis/1.0 (embedded-maps)';
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const OSRM_ROUTE_URL = 'https://router.project-osrm.org/route/v1/driving';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const REQUEST_TIMEOUT_MS = 10_000;
// Cap parsed response bodies: the timeout bounds time, not bytes.
const MAX_RESPONSE_BYTES = 1_000_000;
const MIN_ZOOM = 1;
const MAX_ZOOM = 18;
const DEFAULT_ZOOM = 13;
const MAX_POI_PINS = 5;
// Category POI search radius around the geocoded place.
const POI_SEARCH_RADIUS_M = 3000;
// Overpass returns up to this many raw elements; named results are then sorted
// by distance and trimmed to MAX_POI_PINS.
const OVERPASS_MAX_ELEMENTS = 25;
// OSRM snaps each endpoint to its road network; a snap farther than this means
// the "route" is provider garbage (e.g. New York snapping to Lisbon), so the
// tool reports no_route instead of a confidently wrong map.
const MAX_OSRM_SNAP_DISTANCE_M = 50_000;
// Nominatim's usage policy caps clients at 1 request/second.
const NOMINATIM_MIN_INTERVAL_MS = 1100;
// Place-name inputs have no legitimate use past this length; it bounds the
// outbound request URL.
const MAX_NAME_LENGTH = 200;

// Nominatim lookups cached in memory, keyed by normalized query plus result
// limit (and bounding box when biased). Empty results are cached too: a miss is
// stable, and error paths are where callers retry most.
const SEARCH_CACHE_MAX_ENTRIES = 200;
const searchCache = new Map<string, GeocodedPlace[]>();

// Timestamp of the last Nominatim request; requests are spaced to respect the
// 1 request/second usage policy.
let lastNominatimRequestAt = 0;

async function throttleNominatim(): Promise<void> {
  const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimRequestAt);
  if (wait > 0) {
    await new Promise(resolve => setTimeout(resolve, wait));
  }
  lastNominatimRequestAt = Date.now();
}

// Bounding-box bias for Nominatim searches, in degrees:
// left = min lon, top = max lat, right = max lon, bottom = min lat.
interface SearchBias {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface GeocodedPlace {
  name: string;
  lat: number;
  lng: number;
}

const nominatimResultSchema = z.object({
  lat: z.string(),
  lon: z.string(),
  display_name: z.string(),
});

type NominatimResult = z.infer<typeof nominatimResultSchema>;

const osrmRouteSchema = z.object({
  code: z.string(),
  // Meters from each requested coordinate to the road OSRM snapped it to.
  waypoints: z.array(z.object({ distance: z.number() })),
  routes: z.array(
    z.object({
      distance: z.number(),
      duration: z.number(),
      geometry: z.string(),
    }),
  ),
});

type OsrmRouteResponse = z.infer<typeof osrmRouteSchema>;

export function clampZoom(value: number): number {
  // Out-of-range zoom requests settle to the nearest valid level.
  if (!Number.isFinite(value)) {
    return DEFAULT_ZOOM;
  }
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function setCachedPlaces(key: string, places: GeocodedPlace[]): void {
  // FIFO eviction once the cache is full.
  if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES && !searchCache.has(key)) {
    const oldest = searchCache.keys().next();
    if (!oldest.done) {
      searchCache.delete(oldest.value);
    }
  }
  searchCache.set(key, places);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type JsonFetchOutcome = { reachable: true; data: unknown } | { reachable: false };

// Bounded JSON GET. Transport failures (network error, non-2xx status, timeout)
// surface as unreachable so callers report service_unavailable instead of hanging.
async function fetchJson(url: string, headers: Record<string, string>): Promise<JsonFetchOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      return { reachable: false };
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      return { reachable: false };
    }
    return { reachable: true, data: JSON.parse(text) };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timeout);
  }
}

type NominatimOutcome = { kind: 'results'; places: GeocodedPlace[] } | { kind: 'unreachable' };

function toPlace(result: NominatimResult): GeocodedPlace | undefined {
  const lat = Number(result.lat);
  const lng = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return undefined;
  }
  return { name: result.display_name, lat, lng };
}

// Runs a Nominatim search with the usage-policy discipline: identifying
// User-Agent, at most 1 request/second, bounded timeout, validated responses.
// With a bias, results are restricted to the bounding box instead of relying
// on appended display-name text for area scoping.
async function searchNominatim(query: string, limit: number, bias?: SearchBias): Promise<NominatimOutcome> {
  const normalized = normalizeQuery(query);
  const cacheKey =
    bias === undefined
      ? `${String(limit)}:${normalized}`
      : `${String(limit)}:vb:${normalized}:${bias.left.toFixed(3)},${bias.top.toFixed(3)},${bias.right.toFixed(3)},${bias.bottom.toFixed(3)}`;
  const cached = searchCache.get(cacheKey);
  if (cached !== undefined) {
    return { kind: 'results', places: cached };
  }
  await throttleNominatim();
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: String(limit) });
  if (bias !== undefined) {
    params.set('viewbox', `${String(bias.left)},${String(bias.top)},${String(bias.right)},${String(bias.bottom)}`);
    params.set('bounded', '1');
  }
  const outcome = await fetchJson(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
    'User-Agent': NOMINATIM_USER_AGENT,
  });
  if (!outcome.reachable) {
    return { kind: 'unreachable' };
  }
  const places: GeocodedPlace[] = [];
  if (Array.isArray(outcome.data)) {
    for (const item of outcome.data) {
      if (!isRecord(item)) {
        continue;
      }
      const parsed = nominatimResultSchema.safeParse(item);
      if (!parsed.success) {
        continue;
      }
      const place = toPlace(parsed.data);
      if (place !== undefined) {
        places.push(place);
      }
    }
  }
  setCachedPlaces(cacheKey, places);
  return { kind: 'results', places };
}

// Category-aware POI search via Overpass. Free-text Nominatim search matches
// place *names*, so "coffee shop in Paris" only finds venues literally named
// that. Known POI kinds map to OpenStreetMap tags and are searched by category
// in a radius around the geocoded place. Queries outside the table fall back
// to a viewbox-biased Nominatim name search.
interface OverpassTagFilter {
  key: string;
  value: string;
  regex: boolean;
}

function tag(key: string, value: string): OverpassTagFilter[][] {
  return [[{ key, value, regex: false }]];
}

const PIZZA_SELECTORS: OverpassTagFilter[][] = [
  [
    { key: 'amenity', value: 'restaurant', regex: false },
    { key: 'cuisine', value: 'pizza', regex: true },
  ],
  [
    { key: 'amenity', value: 'fast_food', regex: false },
    { key: 'cuisine', value: 'pizza', regex: true },
  ],
];

// Normalized POI query -> OR of AND-groups of Overpass tag filters.
const POI_CATEGORIES = new Map<string, OverpassTagFilter[][]>([
  ['atm', tag('amenity', 'atm')],
  ['atms', tag('amenity', 'atm')],
  ['cash machine', tag('amenity', 'atm')],
  ['bank', tag('amenity', 'bank')],
  ['banks', tag('amenity', 'bank')],
  ['bar', tag('amenity', 'bar')],
  ['bars', tag('amenity', 'bar')],
  ['cocktail bar', tag('amenity', 'bar')],
  ['wine bar', tag('amenity', 'bar')],
  ['bookstore', tag('shop', 'books')],
  ['bookstores', tag('shop', 'books')],
  ['book shop', tag('shop', 'books')],
  ['cafe', tag('amenity', 'cafe')],
  ['cafes', tag('amenity', 'cafe')],
  ['coffee', tag('amenity', 'cafe')],
  ['coffee shop', tag('amenity', 'cafe')],
  ['coffee shops', tag('amenity', 'cafe')],
  ['coffeeshop', tag('amenity', 'cafe')],
  ['espresso', tag('amenity', 'cafe')],
  ['tea house', tag('amenity', 'cafe')],
  ['bubble tea', tag('amenity', 'cafe')],
  ['fast food', tag('amenity', 'fast_food')],
  ['burger', tag('amenity', 'fast_food')],
  ['burgers', tag('amenity', 'fast_food')],
  ['gas station', tag('amenity', 'fuel')],
  ['gas stations', tag('amenity', 'fuel')],
  ['petrol station', tag('amenity', 'fuel')],
  ['fuel', tag('amenity', 'fuel')],
  ['hospital', tag('amenity', 'hospital')],
  ['hospitals', tag('amenity', 'hospital')],
  ['hotel', tag('tourism', 'hotel')],
  ['hotels', tag('tourism', 'hotel')],
  ['hostel', tag('tourism', 'hostel')],
  ['hostels', tag('tourism', 'hostel')],
  ['museum', tag('tourism', 'museum')],
  ['museums', tag('tourism', 'museum')],
  ['park', tag('leisure', 'park')],
  ['parks', tag('leisure', 'park')],
  ['parking', tag('amenity', 'parking')],
  ['car park', tag('amenity', 'parking')],
  ['car parks', tag('amenity', 'parking')],
  ['parking lot', tag('amenity', 'parking')],
  ['parking garage', tag('amenity', 'parking')],
  ['pharmacy', tag('amenity', 'pharmacy')],
  ['pharmacies', tag('amenity', 'pharmacy')],
  ['drugstore', tag('amenity', 'pharmacy')],
  ['drugstores', tag('amenity', 'pharmacy')],
  ['chemist', tag('amenity', 'pharmacy')],
  ['pizza', PIZZA_SELECTORS],
  ['pizzeria', PIZZA_SELECTORS],
  ['pizzerias', PIZZA_SELECTORS],
  ['pub', tag('amenity', 'pub')],
  ['pubs', tag('amenity', 'pub')],
  ['restaurant', tag('amenity', 'restaurant')],
  ['restaurants', tag('amenity', 'restaurant')],
  ['supermarket', tag('shop', 'supermarket')],
  ['supermarkets', tag('shop', 'supermarket')],
  ['grocery', tag('shop', 'supermarket')],
  ['grocery store', tag('shop', 'supermarket')],
  ['toilet', tag('amenity', 'toilets')],
  ['toilets', tag('amenity', 'toilets')],
  ['restroom', tag('amenity', 'toilets')],
  ['restrooms', tag('amenity', 'toilets')],
]);

function normalizePoiQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ');
}

function overpassFilterText(filter: OverpassTagFilter): string {
  return filter.regex ? `["${filter.key}"~"${filter.value}",i]` : `["${filter.key}"="${filter.value}"]`;
}

// Builds an Overpass QL query: nodes and ways matching any selector group
// within POI_SEARCH_RADIUS_M of the center. Tag keys/values come from the fixed
// category table; only the center coordinates are dynamic, and those are
// finite numbers validated at geocode time.
function buildOverpassQuery(selectors: OverpassTagFilter[][], center: GeocodedPlace): string {
  const around = `(around:${String(POI_SEARCH_RADIUS_M)},${String(center.lat)},${String(center.lng)})`;
  const statements: string[] = [];
  for (const group of selectors) {
    const filters = group.map(overpassFilterText).join('');
    statements.push(`node${filters}${around};`);
    statements.push(`way${filters}${around};`);
  }
  return `[out:json][timeout:10];(${statements.join('')});out center ${String(OVERPASS_MAX_ELEMENTS)};`;
}

const overpassElementSchema = z.object({
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

const overpassResponseSchema = z.object({
  elements: z.array(overpassElementSchema),
});

type OverpassElement = z.infer<typeof overpassElementSchema>;

function haversineM(options: { fromLat: number; fromLng: number; toLat: number; toLng: number }): number {
  const { fromLat, fromLng, toLat, toLng } = options;
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const halfLat = toRad(toLat - fromLat) / 2;
  const halfLng = toRad(toLng - fromLng) / 2;
  const a = Math.sin(halfLat) ** 2 + Math.cos(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.sin(halfLng) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

interface PoiCandidate {
  name: string;
  lat: number;
  lng: number;
  distanceM: number;
}

function overpassElementToCandidate(element: OverpassElement, center: GeocodedPlace): PoiCandidate | undefined {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  const name = element.tags?.['name']?.trim();
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return undefined;
  }
  if (name === undefined || name.length === 0) {
    return undefined;
  }
  return {
    name,
    lat,
    lng: lon,
    distanceM: haversineM({ fromLat: center.lat, fromLng: center.lng, toLat: lat, toLng: lon }),
  };
}

type OverpassOutcome = { kind: 'results'; places: GeocodedPlace[] } | { kind: 'unreachable' };

async function searchOverpass(
  categoryKey: string,
  selectors: OverpassTagFilter[][],
  center: GeocodedPlace,
): Promise<OverpassOutcome> {
  const cacheKey = `overpass:${categoryKey}:${center.lat.toFixed(4)},${center.lng.toFixed(4)}`;
  const cached = searchCache.get(cacheKey);
  if (cached !== undefined) {
    return { kind: 'results', places: cached };
  }
  const params = new URLSearchParams({ data: buildOverpassQuery(selectors, center) });
  const outcome = await fetchJson(`${OVERPASS_URL}?${params.toString()}`, {
    'User-Agent': NOMINATIM_USER_AGENT,
  });
  if (!outcome.reachable) {
    return { kind: 'unreachable' };
  }
  const parsed = overpassResponseSchema.safeParse(outcome.data);
  if (!parsed.success) {
    return { kind: 'unreachable' };
  }
  const places = parsed.data.elements
    .map(element => overpassElementToCandidate(element, center))
    .filter((candidate): candidate is PoiCandidate => candidate !== undefined)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, MAX_POI_PINS)
    .map(({ name, lat, lng }) => ({ name, lat, lng }));
  setCachedPlaces(cacheKey, places);
  return { kind: 'results', places };
}

// Viewbox bias around the place so uncategorized POI name searches stay near it
// instead of relying on appended display-name text for area scoping.
function poiBias(place: GeocodedPlace): SearchBias {
  const halfDegrees = 0.05; // ~5 km
  return {
    left: place.lng - halfDegrees,
    top: place.lat + halfDegrees,
    right: place.lng + halfDegrees,
    bottom: place.lat - halfDegrees,
  };
}

/**
 * Trims a place query to its trailing comma-separated address portion.
 * Business names missing from OSM (e.g. "X-Clinic, Av. Engenheiro Duarte
 * Pacheco 26, Lisboa") poison the full query; the street address alone
 * often resolves. Returns undefined when there is nothing to trim.
 */
function trimToAddress(query: string): string | undefined {
  const parts = query.split(',').map(p => p.trim()).filter(p => p.length > 0);
  if (parts.length < 2) {
    return undefined;
  }
  // Drop the leading business/venue name, keep the address portion.
  const trimmed = parts.slice(1).join(', ');
  return trimmed.length > 0 && trimmed !== query.trim() ? trimmed : undefined;
}

/**
 * Geocodes a query, falling back to the trimmed address portion on not_found.
 * Returns the outcome and whether the fallback was used.
 */
async function geocodeWithFallback(
  query: string,
  limit: number,
  bias?: SearchBias,
): Promise<{ outcome: NominatimOutcome; usedFallback: boolean }> {
  const outcome = await searchNominatim(query, limit, bias);
  if (outcome.kind !== 'results' || outcome.places.length > 0) {
    return { outcome, usedFallback: false };
  }
  const trimmed = trimToAddress(query);
  if (trimmed === undefined) {
    return { outcome, usedFallback: false };
  }
  const fallback = await searchNominatim(trimmed, limit, bias);
  return { outcome: fallback, usedFallback: true };
}

type RouteFetchOutcome =
  | { kind: 'route'; distanceM: number; durationS: number; geometry: string }
  | { kind: 'no_route' }
  | { kind: 'unreachable' };

// OSRM with geometries=polyline returns the route as a precision-5 encoded polyline.
async function fetchRoute(options: { from: GeocodedPlace; to: GeocodedPlace }): Promise<RouteFetchOutcome> {
  const { from, to } = options;
  const coordinates = `${String(from.lng)},${String(from.lat)};${String(to.lng)},${String(to.lat)}`;
  const params = new URLSearchParams({ overview: 'full', geometries: 'polyline' });
  const outcome = await fetchJson(`${OSRM_ROUTE_URL}/${coordinates}?${params.toString()}`, {
    'User-Agent': NOMINATIM_USER_AGENT,
  });
  if (!outcome.reachable) {
    return { kind: 'unreachable' };
  }
  const parsed = osrmRouteSchema.safeParse(outcome.data);
  const body: OsrmRouteResponse | undefined = parsed.success ? parsed.data : undefined;
  if (body?.code !== 'Ok') {
    return { kind: 'no_route' };
  }
  const [route] = body.routes;
  const [waypointFrom, waypointTo] = body.waypoints;
  if (route === undefined || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) {
    return { kind: 'no_route' };
  }
  // OSRM snaps unroutable endpoints to far-away roads instead of failing; a
  // huge snap distance means the route is garbage, not a real connection.
  if (
    waypointFrom === undefined ||
    waypointTo === undefined ||
    !Number.isFinite(waypointFrom.distance) ||
    !Number.isFinite(waypointTo.distance) ||
    waypointFrom.distance > MAX_OSRM_SNAP_DISTANCE_M ||
    waypointTo.distance > MAX_OSRM_SNAP_DISTANCE_M
  ) {
    return { kind: 'no_route' };
  }
  return { kind: 'route', distanceM: route.distance, durationS: route.duration, geometry: route.geometry };
}

const renderMapInputSchema = z
  .object({
    place_name: z
      .string()
      .min(1)
      .max(MAX_NAME_LENGTH)
      .describe('Place name to show on the map, e.g. "Paris" or "Eiffel Tower".'),
    poi: z
      .string()
      .min(1)
      .max(MAX_NAME_LENGTH)
      .optional()
      .describe('Point-of-interest type to search near the place, e.g. "coffee shop".'),
    zoom: z.number().default(DEFAULT_ZOOM).transform(clampZoom).describe('Initial map zoom level from 1 to 18.'),
  })
  .strict();

type RenderMapInput = z.infer<typeof renderMapInputSchema>;

const renderRouteInputSchema = z
  .object({
    from_place: z.string().min(1).max(MAX_NAME_LENGTH).describe('Starting place name, e.g. "Madrid".'),
    to_place: z.string().min(1).max(MAX_NAME_LENGTH).describe('Destination place name, e.g. "Barcelona".'),
  })
  .strict();

type RenderRouteInput = z.infer<typeof renderRouteInputSchema>;

function errorPayload(payload: { error: string; field?: string }): CallToolResponse {
  return toolResultResponse({ text: JSON.stringify(payload), isError: true });
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export class RenderMap extends LocalToolMCP {
  readonly name = RENDER_MAP_SERVER_ID;
  readonly displayName = 'RenderMap';

  constructor(tracing: AgentTracing) {
    super({ tracing });
  }

  private tools: ToolDefinition[] = [
    defineTool({
      name: RENDER_MAP_TOOL_NAME,
      description:
        "Render an interactive map with a pin for a named place. Pass the place name as the user gave it (e.g. 'Paris', 'Eiffel Tower'). The tool geocodes the name and returns an inline map card. Use when the user explicitly asks to see a place on a map or asks where a place is. Do not call for a location mentioned in passing. If the user asks for 'nearest X' without naming a place, ask which area to search instead of calling; the tool does not track the user's location.",
      schema: renderMapInputSchema,
      requiresNetwork: true,
      handler: (input: RenderMapInput) => this.renderMap(input),
    }),
    defineTool({
      name: RENDER_ROUTE_TOOL_NAME,
      description:
        "Render a route map between two named places. Pass both place names as the user gave them (e.g. from_place 'Madrid', to_place 'Barcelona'). The tool geocodes both endpoints, routes via OSRM, and returns an inline map card with the route polyline, distance, and duration. Use when the user asks for directions between two named places. Both endpoints must be named by the user; there is no current-location mode. If the user asks for directions without a starting point, or uses a user-centric shorthand like 'from home' or 'my place', ask for a named starting point instead of calling. Never resolve 'home' to a memorized address.",
      schema: renderRouteInputSchema,
      requiresNetwork: true,
      handler: (input: RenderRouteInput) => this.renderRoute(input),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  private async renderMap(input: RenderMapInput): Promise<CallToolResponse> {
    const { outcome: geocode } = await geocodeWithFallback(input.place_name, 1);
    if (geocode.kind === 'unreachable') {
      return errorPayload({ error: 'service_unavailable' });
    }
    const [place] = geocode.places;
    if (place === undefined) {
      return errorPayload({ error: 'not_found' });
    }
    let pins: MapPoiPin[] | undefined;
    if (input.poi !== undefined) {
      const categoryKey = normalizePoiQuery(input.poi);
      const selectors = POI_CATEGORIES.get(categoryKey);
      // Known POI kinds search by OSM category around the place; anything else
      // falls back to a viewbox-biased name search.
      const poiSearch =
        selectors === undefined
          ? await searchNominatim(input.poi, MAX_POI_PINS, poiBias(place))
          : await searchOverpass(categoryKey, selectors, place);
      if (poiSearch.kind === 'unreachable') {
        return errorPayload({ error: 'service_unavailable' });
      }
      pins = poiSearch.places.map(p => ({ name: p.name, lat: p.lat, lng: p.lng }));
    }
    const result: RenderMapResult = {
      map_card_id: crypto.randomUUID(),
      resolved_name: place.name,
      address: place.name,
      lat: place.lat,
      lng: place.lng,
      zoom: input.zoom,
      ...(pins === undefined ? {} : { pins }),
    };
    return toolResultResponse({ text: JSON.stringify(result) });
  }

  private async renderRoute(input: RenderRouteInput): Promise<CallToolResponse> {
    // Geocode the destination first so the origin search can be biased to a
    // viewbox around it. Colloquial origin names ("Rossio square") resolve to
    // the wrong city without this bias.
    const { outcome: toSearch } = await geocodeWithFallback(input.to_place, 1);
    if (toSearch.kind === 'unreachable') {
      return errorPayload({ error: 'service_unavailable' });
    }
    const [toPlace] = toSearch.places;
    if (toPlace === undefined) {
      return errorPayload({ error: 'not_found', field: 'to_place' });
    }
    const { outcome: fromSearch } = await geocodeWithFallback(input.from_place, 1, poiBias(toPlace));
    if (fromSearch.kind === 'unreachable') {
      return errorPayload({ error: 'service_unavailable' });
    }
    const [fromPlace] = fromSearch.places;
    if (fromPlace === undefined) {
      return errorPayload({ error: 'not_found', field: 'from_place' });
    }
    const route = await fetchRoute({ from: fromPlace, to: toPlace });
    if (route.kind === 'unreachable') {
      return errorPayload({ error: 'service_unavailable' });
    }
    if (route.kind === 'no_route') {
      return errorPayload({ error: 'no_route' });
    }
    const result: RenderRouteResult = {
      map_card_id: crypto.randomUUID(),
      from_resolved: fromPlace.name,
      to_resolved: toPlace.name,
      distance_km: roundToTenth(route.distanceM / 1000),
      duration_min: roundToTenth(route.durationS / 60),
      route_geometry: route.geometry,
    };
    return toolResultResponse({ text: JSON.stringify(result) });
  }
}

export function renderMap(options: { tracing: AgentTracing }): AgentCapability {
  return {
    systemToolSets: [new RenderMap(options.tracing)],
  };
}

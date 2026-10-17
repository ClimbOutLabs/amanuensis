/**
 * Same-origin tile proxy for embedded maps.
 *
 * Serves GET /api/maps/tiles/{z}/{x}/{y}.png. The browser never contacts the
 * tile host directly: the server fetches from the configured MAPS_TILE_URL,
 * forwards only raster image bodies up to a size cap, and sends no cookies or
 * Referer upstream.
 *
 * Limits: at most 4 upstream fetches in flight with a bounded wait queue, and
 * a per-user budget of upstream fetches per minute (429 above; cache hits are
 * free). Tiles are cached in memory, bounded by entry count and total bytes,
 * honouring upstream Cache-Control/Expires up to 7 days. Answers 503 while
 * offline mode is on or when upstream fails.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import { fetchSameOrigin, readCappedBody } from '../runtime/mapsUpstream';
import { TENANT_ID } from '../tenancy';

const MAX_IN_FLIGHT = 4;
const MAX_WAITING = 32;
export const MAX_UPSTREAM_TILES_PER_USER_PER_MINUTE = 240;
const RATE_BUCKET_MAX_ENTRIES = 1000;
const TILE_CACHE_MAX_ENTRIES = 2000;
export const TILE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const TILE_MAX_BODY_BYTES = 512 * 1024;
const MAX_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 60_000;
const TILE_CACHE_CONTROL = 'private, max-age=86400';
/** A tile is only ever an inert image: no sniffing, no script or framing if it is opened as a document. */
const TILE_SAFETY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Content-Disposition': 'inline; filename="tile"',
};
const SERVABLE_TILE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);

interface TileCacheEntry {
  body: Uint8Array;
  content_type: string;
  expires_at: number;
}

interface RateBucket {
  window_start: number;
  count: number;
}

export interface MapsRouterDeps {
  sentinelSettingsStore: ISentinelSettingsStore;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
  now?: () => number;
}

/** In-memory tile cache shared by the proxy, bounded by entry count and total bytes. */
export class TileCache {
  private readonly entries = new Map<string, TileCacheEntry>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: { now?: () => number; maxEntries?: number; maxBytes?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? TILE_CACHE_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? TILE_CACHE_MAX_BYTES;
  }

  get(key: string): TileCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    // Entries from before a stricter type policy are purged rather than served.
    if (entry.expires_at <= this.now() || !SERVABLE_TILE_TYPES.has(entry.content_type)) {
      this.remove(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, entry: TileCacheEntry): void {
    if (entry.body.byteLength > this.maxBytes) {
      return;
    }
    this.remove(key);
    while (this.entries.size >= this.maxEntries || this.bytes + entry.body.byteLength > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.remove(oldest.value);
    }
    this.entries.set(key, entry);
    this.bytes += entry.body.byteLength;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  get size(): number {
    return this.entries.size;
  }

  private remove(key: string): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.bytes -= existing.body.byteLength;
      this.entries.delete(key);
    }
  }
}

/** Per-key fixed-window counter whose key table is capped: expired windows go first, then the oldest key. */
export class UpstreamBudget {
  private readonly buckets = new Map<string, RateBucket>();

  constructor(
    private readonly now: () => number,
    private readonly limit: number = MAX_UPSTREAM_TILES_PER_USER_PER_MINUTE,
    private readonly maxKeys: number = RATE_BUCKET_MAX_ENTRIES,
  ) {}

  /** Spends one unit for `key`; false when the key's budget for this window is gone. */
  take(key: string): boolean {
    const windowStart = this.now() - (this.now() % RATE_WINDOW_MS);
    let bucket = this.buckets.get(key);
    if (bucket?.window_start !== windowStart) {
      this.buckets.delete(key);
      this.makeRoom(windowStart);
      bucket = { window_start: windowStart, count: 0 };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }

  private makeRoom(windowStart: number): void {
    if (this.buckets.size < this.maxKeys) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (bucket.window_start < windowStart) {
        this.buckets.delete(key);
      }
    }
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) {
        return;
      }
      this.buckets.delete(oldest.value);
    }
  }
}

/** Parse max-age from a Cache-Control header; undefined when absent/invalid. */
export function parseCacheMaxAge(cache_control: string | null): number | undefined {
  if (cache_control === null) {
    return undefined;
  }
  const match = /max-age=(\d+)/.exec(cache_control);
  if (match === null) {
    return undefined;
  }
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** Plain decimal digits only: `Number()` alone also accepts `1e1`, `0x5`, `5.0` and padded spaces. */
export function parseTileIndex(raw: string): number {
  if (raw === '' || raw.length > 8) {
    return Number.NaN;
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 48 || code > 57) {
      return Number.NaN;
    }
  }
  return Number(raw);
}

/**
 * Normalized media type of an upstream tile, or undefined when it is not an allowed raster type.
 * Anything with parameters or a list of types is refused; callers serve the returned value, never the raw header.
 */
export function servableTileType(contentType: string): string | undefined {
  const normalized = contentType.trim().toLowerCase();
  return SERVABLE_TILE_TYPES.has(normalized) ? normalized : undefined;
}

/** Validate tile coordinates: z in 0..18, x/y in 0..2^z-1. */
export function validTileCoords({ z, x, y }: { z: number; x: number; y: number }): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return false;
  }
  if (z < 0 || z > 18) {
    return false;
  }
  const max = 2 ** z - 1;
  return x >= 0 && x <= max && y >= 0 && y <= max;
}

export function createMapsRouter(deps: MapsRouterDeps): OpenAPIHono {
  const now = deps.now ?? Date.now;
  const cache = new TileCache({ now });
  const budget = new UpstreamBudget(now);
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  /** False when the wait queue is full: shed load instead of queueing without bound. */
  async function acquireSlot(): Promise<boolean> {
    if (inFlight < MAX_IN_FLIGHT) {
      inFlight += 1;
      return true;
    }
    if (waiting.length >= MAX_WAITING) {
      return false;
    }
    await new Promise<void>(resolve => {
      waiting.push(resolve);
    });
    inFlight += 1;
    return true;
  }

  function releaseSlot(): void {
    inFlight -= 1;
    const next = waiting.shift();
    if (next !== undefined) {
      next();
    }
  }

  const app = new OpenAPIHono();

  app.use('/tiles/*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(TILE_SAFETY_HEADERS)) {
      c.res.headers.set(name, value);
    }
  });

  // Note: the route omits the `.png` suffix because Hono does not extract
  // params correctly from patterns like `:y.png`; the suffix is stripped below.
  app.get('/tiles/:z/:x/:y', async c => {
    const requestContext = deps.resolveRequestContext(c);
    const z = parseTileIndex(c.req.param('z'));
    const x = parseTileIndex(c.req.param('x'));
    const yRaw = c.req.param('y');
    const y = parseTileIndex(yRaw.endsWith('.png') ? yRaw.slice(0, -'.png'.length) : yRaw);
    if (!validTileCoords({ z, x, y })) {
      return c.json({ error: { message: 'Invalid tile coordinates.' } }, 400);
    }

    // Offline mode: refuse. The toggle is stored under the default tenant by the settings API.
    const settings = await deps.sentinelSettingsStore.get({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
    });
    if (settings.offline_mode) {
      return c.json({ error: { message: 'Map tiles unavailable while offline.' } }, 503);
    }

    const cacheKey = `${String(z)}/${String(x)}/${String(y)}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return new Response(cached.body, {
        status: 200,
        headers: { 'Content-Type': cached.content_type, 'Cache-Control': TILE_CACHE_CONTROL },
      });
    }

    // Budget upstream fetches per authenticated user; never per client-supplied value.
    if (!budget.take(JSON.stringify([requestContext.tenant_id, requestContext.subject.id]))) {
      return c.json({ error: { message: 'Tile rate limit exceeded.' } }, 429);
    }

    const upstreamUrl = configuration.MAPS_TILE_URL.replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    if (!(await acquireSlot())) {
      return c.json({ error: { message: 'Tile proxy is busy.' } }, 429);
    }
    try {
      const upstream = await fetchSameOrigin({
        url: upstreamUrl,
        headers: { 'User-Agent': configuration.MAPS_USER_AGENT, Accept: 'image/png,image/*' },
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return c.json({ error: { message: 'Tile upstream unavailable.' } }, 503);
      }
      const rawContentType = upstream.headers.get('content-type') ?? '';
      const mimeType = servableTileType(rawContentType);
      if (mimeType === undefined) {
        deps.logger.warn('maps tile proxy dropped non-image upstream body', { contentType: rawContentType });
        await upstream.body?.cancel();
        return c.json({ error: { message: 'Tile upstream returned a non-image response.' } }, 503);
      }
      const body = await readCappedBody({ response: upstream, maxBytes: TILE_MAX_BODY_BYTES });
      if (body === null) {
        deps.logger.warn('maps tile proxy dropped oversize upstream body', { limit: TILE_MAX_BODY_BYTES });
        return c.json({ error: { message: 'Tile upstream returned an oversize response.' } }, 503);
      }
      const maxAge = parseCacheMaxAge(upstream.headers.get('cache-control'));
      const expiresHeader = upstream.headers.get('expires');
      let ttl = maxAge ?? 24 * 60 * 60 * 1000;
      if (maxAge === undefined && expiresHeader !== null) {
        const expiresAt = Date.parse(expiresHeader);
        if (Number.isFinite(expiresAt)) {
          ttl = Math.max(0, Math.min(expiresAt - now(), MAX_CACHE_TTL_MS));
        }
      }
      ttl = Math.min(ttl, MAX_CACHE_TTL_MS);
      cache.set(cacheKey, { body, content_type: mimeType, expires_at: now() + ttl });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': mimeType, 'Cache-Control': TILE_CACHE_CONTROL },
      });
    } catch (error) {
      deps.logger.warn('maps tile proxy upstream failure', { error });
      return c.json({ error: { message: 'Tile upstream unavailable.' } }, 503);
    } finally {
      releaseSlot();
    }
  });

  return app;
}

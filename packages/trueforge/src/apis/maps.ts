/**
 * Same-origin tile proxy for embedded maps.
 *
 * Serves GET /api/maps/tiles/{z}/{x}/{y}.png. The browser never contacts the
 * tile host directly: the server fetches from the configured MAPS_TILE_URL,
 * forwards only image/* bodies, and sends no cookies or Referer upstream.
 *
 * Limits: at most 4 upstream fetches in flight; at most 128 upstream tiles per
 * card per minute (429 above). Tiles are cached in memory (2,000 entries,
 * honouring upstream Cache-Control/Expires up to 7 days). Answers 503 while
 * offline mode is on or when upstream fails.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Logger } from 'winston';
import configuration from '../config';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';

const MAX_IN_FLIGHT = 4;
const MAX_TILES_PER_CARD_PER_MINUTE = 128;
const TILE_CACHE_MAX_ENTRIES = 2000;
const MAX_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 10_000;

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
  resolveRequestContext: (c: Context) => { subject: { id: string } };
  logger: Logger;
  now?: () => number;
}

/** In-memory tile cache shared by the proxy. */
export class TileCache {
  private readonly entries = new Map<string, TileCacheEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): TileCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expires_at <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, entry: TileCacheEntry): void {
    if (this.entries.size >= TILE_CACHE_MAX_ENTRIES && !this.entries.has(key)) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, entry);
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

/** Validate tile coordinates: z in 0..18, x/y in 0..2^z-1. */
export function validTileCoords(z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return false;
  }
  if (z < 0 || z > 18) {
    return false;
  }
  const max = 2 ** z - 1;
  return x >= 0 && x <= max && y >= 0 && y <= max;
}

/**
 * Resolve a redirect target, returning null when it points at another host.
 * The proxy never follows the browser to a host outside the configured tile URL.
 */
export function safeRedirectTarget(upstreamUrl: string, location: string): string | null {
  let target: URL;
  try {
    target = new URL(location, upstreamUrl);
  } catch {
    return null;
  }
  const upstreamHost = new URL(upstreamUrl).host;
  return target.host === upstreamHost ? target.toString() : null;
}

export function createMapsRouter(deps: MapsRouterDeps): OpenAPIHono {
  const now = deps.now ?? Date.now;
  const cache = new TileCache(now);
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  const rateBuckets = new Map<string, RateBucket>();

  async function acquireSlot(): Promise<void> {
    if (inFlight < MAX_IN_FLIGHT) {
      inFlight += 1;
      return;
    }
    await new Promise<void>(resolve => {
      waiting.push(resolve);
    });
    inFlight += 1;
  }

  function releaseSlot(): void {
    inFlight -= 1;
    const next = waiting.shift();
    if (next !== undefined) {
      next();
    }
  }

  function checkRateLimit(key: string): boolean {
    const windowStart = now() - (now() % 60_000);
    let bucket = rateBuckets.get(key);
    if (bucket?.window_start !== windowStart) {
      bucket = { window_start: windowStart, count: 0 };
      rateBuckets.set(key, bucket);
    }
    if (bucket.count >= MAX_TILES_PER_CARD_PER_MINUTE) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  const app = new OpenAPIHono();

  app.get('/tiles/:z/:x/:y.png', async c => {
    const subject = deps.resolveRequestContext(c).subject;
    const z = Number(c.req.param('z'));
    const x = Number(c.req.param('x'));
    const y = Number(c.req.param('y'));
    if (!validTileCoords(z, x, y)) {
      return c.json({ error: { message: 'Invalid tile coordinates.' } }, 400);
    }

    // Offline mode: refuse.
    const settings = await deps.sentinelSettingsStore.get({ tenant_id: 'default', created_by: subject.id });
    if (settings.offline_mode) {
      return c.json({ error: { message: 'Map tiles unavailable while offline.' } }, 503);
    }

    // Rate limit: per card (tool call id) when the UI passes it, else per user.
    const card = c.req.query('card');
    const rateKey = card !== undefined && card !== '' ? `card:${card}` : `user:${subject.id}`;
    if (!checkRateLimit(rateKey)) {
      return c.json({ error: { message: 'Tile rate limit exceeded.' } }, 429);
    }

    const cacheKey = `${String(z)}/${String(x)}/${String(y)}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return new Response(cached.body, {
        status: 200,
        headers: { 'Content-Type': cached.content_type, 'Cache-Control': 'public, max-age=86400' },
      });
    }

    const upstreamUrl = configuration.MAPS_TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    await acquireSlot();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => { controller.abort(); }, UPSTREAM_TIMEOUT_MS);
      let upstream: Response;
      try {
        upstream = await fetch(upstreamUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': configuration.MAPS_USER_AGENT },
          // Follow redirects manually so a redirect to another host is rejected.
          redirect: 'manual',
        });
      } finally {
        clearTimeout(timeout);
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get('location');
        const target = location === null ? null : safeRedirectTarget(upstreamUrl, location);
        if (target === null) {
          deps.logger.warn('maps tile proxy dropped redirect to another host', { location });
          return c.json({ error: { message: 'Tile upstream returned an unexpected redirect.' } }, 503);
        }
        // Same-host redirect: follow once.
        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => { retryController.abort(); }, UPSTREAM_TIMEOUT_MS);
        try {
          upstream = await fetch(target, {
            signal: retryController.signal,
            headers: { 'User-Agent': configuration.MAPS_USER_AGENT },
            redirect: 'manual',
          });
        } finally {
          clearTimeout(retryTimeout);
        }
        if (upstream.status >= 300 && upstream.status < 400) {
          return c.json({ error: { message: 'Tile upstream returned an unexpected redirect.' } }, 503);
        }
      }
      if (!upstream.ok) {
        return c.json({ error: { message: 'Tile upstream unavailable.' } }, 503);
      }
      const contentType = upstream.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) {
        deps.logger.warn('maps tile proxy dropped non-image upstream body', { contentType });
        return c.json({ error: { message: 'Tile upstream returned a non-image response.' } }, 503);
      }
      const body = new Uint8Array(await upstream.arrayBuffer());
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
      const mimeType = contentType.split(';')[0] ?? 'image/png';
      cache.set(cacheKey, { body, content_type: mimeType, expires_at: now() + ttl });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=86400' },
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

import type { OutboundEventInput } from '@truefoundry/trueforge-core/core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createLogger } from 'winston';
import {
  createMapsRouter,
  isServableTileType,
  MAX_UPSTREAM_TILES_PER_USER_PER_MINUTE,
  parseTileIndex,
  TILE_MAX_BODY_BYTES,
  TileCache,
  UpstreamBudget,
  validTileCoords,
} from '../../../src/apis/maps';
import type { Authenticator } from '../../../src/auth/authenticator';
import { resolveRequestContext, type RequestContext } from '../../../src/auth/identity';
import { createUiSessionAuthMiddleware } from '../../../src/auth/middleware';
import configuration from '../../../src/config';
import { TENANT_ID } from '../../../src/tenancy';
import { InMemorySentinelSettingsStore } from '../../fixtures/InMemorySentinelSettingsStore';

describe('validTileCoords', () => {
  it('accepts valid coordinates', () => {
    expect(validTileCoords({ z: 0, x: 0, y: 0 })).toBe(true);
    expect(validTileCoords({ z: 13, x: 4096, y: 4096 })).toBe(true);
    expect(validTileCoords({ z: 18, x: 2 ** 18 - 1, y: 2 ** 18 - 1 })).toBe(true);
  });

  it('rejects out-of-range z', () => {
    expect(validTileCoords({ z: -1, x: 0, y: 0 })).toBe(false);
    expect(validTileCoords({ z: 19, x: 0, y: 0 })).toBe(false);
  });

  it('rejects out-of-range x/y', () => {
    expect(validTileCoords({ z: 1, x: 2, y: 0 })).toBe(false);
    expect(validTileCoords({ z: 1, x: 0, y: 2 })).toBe(false);
    expect(validTileCoords({ z: 0, x: 1, y: 0 })).toBe(false);
    expect(validTileCoords({ z: 2, x: -1, y: 0 })).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(validTileCoords({ z: 13.5, x: 0, y: 0 })).toBe(false);
    expect(validTileCoords({ z: 13, x: 1.2, y: 0 })).toBe(false);
    expect(validTileCoords({ z: Number.NaN, x: 0, y: 0 })).toBe(false);
  });
});

describe('parseTileIndex', () => {
  it('accepts plain digits only', () => {
    expect(parseTileIndex('0')).toBe(0);
    expect(parseTileIndex('4096')).toBe(4096);
    for (const raw of ['', '1e1', '0x5', ' 5', '5.0', '-1', '+1', 'Infinity', '123456789']) {
      expect(parseTileIndex(raw)).toBeNaN();
    }
  });
});

describe('isServableTileType', () => {
  it('passes raster images and drops active or non-image types', () => {
    expect(isServableTileType('image/png')).toBe(true);
    expect(isServableTileType('image/jpeg')).toBe(true);
    expect(isServableTileType('image/svg+xml')).toBe(false);
    expect(isServableTileType('text/html')).toBe(false);
    expect(isServableTileType('')).toBe(false);
  });
});

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const USER: RequestContext = {
  tenant_id: 't1',
  subject: { id: 'u1', type: 'user', display_name: 'u1' },
  roles: [],
  user_credential: null,
};

/** Accepts only the session cookie, like the OIDC authenticator without a bearer. */
const cookieAuthenticator: Authenticator = {
  authenticate: c => {
    if (c.req.header('Cookie')?.includes('accessToken=') !== true) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    return Promise.resolve(USER);
  },
};

function pngResponse(init: ResponseInit = {}): Response {
  return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' }, ...init });
}

describe('tile proxy route', () => {
  const store = new InMemorySentinelSettingsStore();
  const logger = createLogger({ silent: true });
  let app: Hono;
  let fetchSpy: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;

  beforeEach(async () => {
    await store.patch({
      tenant_id: TENANT_ID,
      created_by: USER.subject.id,
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: false,
    });
    app = new Hono();
    app.use('*', createUiSessionAuthMiddleware(cookieAuthenticator));
    app.route(
      '/api/maps',
      createMapsRouter({ sentinelSettingsStore: store, resolveRequestContext, logger, now: () => 1_000_000 }),
    );
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function get(path: string, headers: Record<string, string> = { Cookie: 'accessToken=session' }): Promise<Response> {
    return Promise.resolve(app.request(`/api/maps/tiles/${path}`, { headers }));
  }

  it('refuses callers without a browser session and any bearer credential', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(pngResponse()));
    expect((await get('3/1/1.png', {})).status).toBe(401);
    expect((await get('3/1/1.png', { Authorization: 'Bearer agent-token' })).status).toBe(401);
    expect(
      (await get('3/1/1.png', { Authorization: 'Bearer agent-token', Cookie: 'accessToken=session' })).status,
    ).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await get('3/1/1.png')).status).toBe(200);
  });

  it('forwards no cookies or Referer, identifies itself, and marks the tile private and nosniff', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(pngResponse()));
    const response = await get('3/1/1.png', {
      Cookie: 'accessToken=session',
      Referer: 'https://app.example/private?q=1',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe(configuration.MAPS_TILE_URL.replace('{z}', '3').replace('{x}', '1').replace('{y}', '1'));
    const sent = new Headers(init?.headers);
    expect(sent.get('User-Agent')).toBe(configuration.MAPS_USER_AGENT);
    expect(sent.has('Cookie')).toBe(false);
    expect(sent.has('Referer')).toBe(false);
    expect(init?.redirect).toBe('manual');
  });

  it('rejects bad coordinates with 400 before any upstream call', async () => {
    for (const path of ['19/0/0.png', '2/4/0.png', '1e1/0/0.png', '0x5/0/0.png', '3/1/1.jpg']) {
      expect((await get(path)).status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 503 while offline, even for a cached tile', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(pngResponse()));
    expect((await get('3/2/2.png')).status).toBe(200);
    await store.patch({
      tenant_id: TENANT_ID,
      created_by: USER.subject.id,
      offline_mode: true,
      tier2_auto_allow: [],
      search_without_asking: false,
    });
    expect((await get('3/2/2.png')).status).toBe(503);
    expect((await get('3/3/3.png')).status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('budgets upstream fetches per user: 429 above the limit, cache hits stay free, card ids do not matter', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(pngResponse()));
    const limit = MAX_UPSTREAM_TILES_PER_USER_PER_MINUTE;
    expect((await get('9/0/0.png?card=first')).status).toBe(200);
    for (let i = 1; i < limit; i += 1) {
      expect((await get(`9/${String(i)}/0.png?card=card-${String(i)}`)).status).toBe(200);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(limit);
    expect((await get('9/0/1.png?card=a-brand-new-card')).status).toBe(429);
    expect((await get('9/5/0.png?card=another')).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(limit);
  });

  it('drops a non-image or SVG upstream body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('<script>1</script>', { headers: { 'Content-Type': 'text/html' } }));
    expect((await get('4/1/1.png')).status).toBe(503);
    fetchSpy.mockResolvedValueOnce(
      new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    );
    expect((await get('4/2/2.png')).status).toBe(503);
  });

  it('drops an oversize upstream body, declared or streamed, and does not cache it', async () => {
    const declared = new Response(new Uint8Array(8), {
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(TILE_MAX_BODY_BYTES + 1) },
    });
    fetchSpy.mockResolvedValueOnce(declared);
    expect((await get('5/1/1.png')).status).toBe(503);

    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(stream, { headers: { 'Content-Type': 'image/png' } }));
    expect((await get('5/2/2.png')).status).toBe(503);
    expect(pulled * 64 * 1024).toBeLessThan(TILE_MAX_BODY_BYTES * 2);

    fetchSpy.mockImplementation(() => Promise.resolve(pngResponse()));
    expect((await get('5/2/2.png')).status).toBe(200);
  });

  it('does not follow a redirect to another host', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'https://evil.example/t.png' } }),
    );
    expect((await get('6/1/1.png')).status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      fetchSpy.mock.calls.every(call => String(call[0]).startsWith(new URL(configuration.MAPS_TILE_URL).origin)),
    ).toBe(true);
  });
});

describe('tile proxy outbound recording', () => {
  const store = new InMemorySentinelSettingsStore();
  const logger = createLogger({ silent: true });
  let rows: OutboundEventInput[];
  let app: Hono;

  beforeEach(() => {
    rows = [];
    app = new Hono();
    app.use('*', createUiSessionAuthMiddleware(cookieAuthenticator));
    app.route(
      '/api/maps',
      createMapsRouter({
        sentinelSettingsStore: store,
        resolveRequestContext,
        logger,
        now: () => 1_000_000,
        outboundEvents: {
          record: input => {
            rows.push(input);
            return Promise.resolve();
          },
        },
      }),
    );
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(pngResponse()));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const get = (path: string) =>
    Promise.resolve(app.request(`/api/maps/tiles/${path}`, { headers: { Cookie: 'accessToken=session' } }));

  it('records each tile fetched from the map service with its host only, and nothing for a cached tile', async () => {
    expect((await get('3/1/1.png')).status).toBe(200);
    expect((await get('3/1/1.png')).status).toBe(200);
    expect((await get('3/2/2.png')).status).toBe(200);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual({
        tenant_id: 't1',
        kind: 'map_lookup',
        host: new URL(configuration.MAPS_TILE_URL).host,
        model: null,
        tool_name: null,
        request_bytes: null,
        recipient_count: null,
        subject: null,
        conversation_id: null,
      });
    }
    expect(JSON.stringify(rows)).not.toMatch(/\/3\/1\/1/);
  });

  it('records nothing for a refused request', async () => {
    expect((await get('19/0/0.png')).status).toBe(400);
    expect(await app.request('/api/maps/tiles/3/1/1.png')).toHaveProperty('status', 401);
    expect(rows).toEqual([]);
  });
});

describe('UpstreamBudget', () => {
  it('caps its key table, evicting expired windows before live ones', () => {
    let now = 0;
    const budget = new UpstreamBudget(() => now, 2, 3);
    for (const key of ['a', 'b', 'c']) {
      expect(budget.take(key)).toBe(true);
    }
    now = 60_000;
    expect(budget.take('d')).toBe(true);
    expect(budget.size).toBeLessThanOrEqual(3);
    for (let i = 0; i < 50; i += 1) {
      budget.take(`k${String(i)}`);
    }
    expect(budget.size).toBeLessThanOrEqual(3);
  });

  it('enforces the per-key limit within a window and resets in the next', () => {
    let now = 0;
    const budget = new UpstreamBudget(() => now, 2, 10);
    expect([budget.take('u'), budget.take('u'), budget.take('u')]).toEqual([true, true, false]);
    now = 60_000;
    expect(budget.take('u')).toBe(true);
  });
});

describe('TileCache bounds', () => {
  const entry = (bytes: number) => ({
    body: new Uint8Array(bytes),
    content_type: 'image/png',
    expires_at: Number.MAX_SAFE_INTEGER,
  });

  it('evicts oldest entries to stay under the byte cap as well as the entry cap', () => {
    const cache = new TileCache({ maxEntries: 100, maxBytes: 100 });
    for (const key of ['a', 'b', 'c']) {
      cache.set(key, entry(40));
    }
    expect(cache.totalBytes).toBeLessThanOrEqual(100);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
    cache.set('huge', entry(101));
    expect(cache.get('huge')).toBeUndefined();
    const small = new TileCache({ maxEntries: 2, maxBytes: 1000 });
    for (const key of ['x', 'y', 'z']) {
      small.set(key, entry(1));
    }
    expect(small.size).toBe(2);
  });
});

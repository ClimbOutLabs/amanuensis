import { Hono } from 'hono';
import { z } from 'zod';
import { listedOriginMiddleware } from '../../../../src/auth/listedOriginContext';
import configuration from '../../../../src/config';
import { mcpOAuthCallbackUrl, mcpOAuthRedirectUris } from '../../../../src/mcp/auth/mcpOAuthHelpers';

const ORIGINS = ['http://127.0.0.1:8790', 'http://192.168.1.20:8790', 'http://spark.local:8790'];
const ProbeSchema = z.object({ callback: z.string(), registered: z.array(z.string()) });
const CALLBACK = '/api/v1/mcp-servers/oauth/callback';

describe('connector sign-in on an instance opened at several addresses', () => {
  const saved = { PUBLIC_BASE_URL: configuration.PUBLIC_BASE_URL, ALLOWED_ORIGINS: configuration.ALLOWED_ORIGINS };

  beforeEach(() => {
    Object.assign(configuration, { PUBLIC_BASE_URL: 'http://127.0.0.1:8790', ALLOWED_ORIGINS: ORIGINS });
  });

  afterEach(() => {
    Object.assign(configuration, saved);
  });

  function app(): Hono {
    const hono = new Hono();
    hono.use(
      '*',
      listedOriginMiddleware(() => configuration.ALLOWED_ORIGINS),
    );
    hono.get('/probe', async c => {
      await Promise.resolve();
      return c.json({ callback: mcpOAuthCallbackUrl(), registered: mcpOAuthRedirectUris() });
    });
    return hono;
  }

  it.each(ORIGINS)(
    'returns to the address the request came to (%s), not to the loopback public address',
    async origin => {
      const res = await app().request(`${origin}/probe`, { headers: { host: new URL(origin).host } });
      const body = ProbeSchema.parse(await res.json());
      expect(body.callback).toBe(`${origin}${CALLBACK}`);
      expect(body.registered[0]).toBe(`${origin}${CALLBACK}`);
      expect([...body.registered].sort()).toEqual(ORIGINS.map(o => `${o}${CALLBACK}`).sort());
    },
  );

  it('never takes the address from anything but the Host of a listed address', async () => {
    const res = await app().request('http://192.168.1.99:8790/probe', {
      headers: { host: '192.168.1.99:8790', 'x-forwarded-host': '192.168.1.20:8790' },
    });
    const body = ProbeSchema.parse(await res.json());
    expect(body.callback).toBe(`http://127.0.0.1:8790${CALLBACK}`);
  });

  it('uses the public address outside a request and with no list', () => {
    expect(mcpOAuthCallbackUrl()).toBe(`http://127.0.0.1:8790${CALLBACK}`);
    Object.assign(configuration, { ALLOWED_ORIGINS: [] });
    expect(mcpOAuthRedirectUris()).toEqual([`http://127.0.0.1:8790${CALLBACK}`]);
  });
});

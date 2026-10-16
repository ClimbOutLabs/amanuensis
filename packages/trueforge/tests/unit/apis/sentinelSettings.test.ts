import { HTTPException } from 'hono/http-exception';
import type { Authenticator } from '../../../src/auth/authenticator';
import type { RequestContext } from '../../../src/auth/identity';
import { GetSentinelUserSettingsResponseSchema } from '../../../src/schemas/sentinelSettings';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const SETTINGS_PATH = '/api/v1/user/settings/sentinel';

/** Identifies the caller by `x-test-user`; a request without it is unauthenticated. */
const headerAuthenticator: Authenticator = {
  authenticate: c => {
    const user = c.req.header('x-test-user');
    if (user === undefined) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    const context: RequestContext = {
      tenant_id: 'default',
      subject: { id: user, type: 'user', display_name: user },
      roles: [],
      user_credential: null,
    };
    return Promise.resolve(context);
  },
};

function asUser(user: string, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', user);
  if (init?.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return { ...init, headers };
}

function patch(user: string, body: unknown): RequestInit {
  return asUser(user, { method: 'PATCH', body: JSON.stringify(body) });
}

describe('Sentinel user settings routes', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer({ authenticator: headerAuthenticator });
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  async function read(user: string) {
    const response = await server.request(SETTINGS_PATH, asUser(user));
    expect(response.status).toBe(200);
    // Parsed through the wire schema so a drifting response fails here, not only on a wrong value.
    return GetSentinelUserSettingsResponseSchema.parse(await response.json()).data;
  }

  it('requires authentication on both verbs', async () => {
    expect((await server.request(SETTINGS_PATH)).status).toBe(401);
    const unauthenticatedPatch = await server.request(SETTINGS_PATH, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offline_mode: true }),
    });
    expect(unauthenticatedPatch.status).toBe(401);
  });

  it('reads the defaults for a user who saved nothing', async () => {
    expect(await read('fresh-user')).toEqual({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
    });
  });

  it('saves a patch, merges later patches and keeps users isolated', async () => {
    const saved = await server.request(SETTINGS_PATH, patch('alice', { tier2_auto_allow: ['file_write'] }));
    expect(saved.status).toBe(200);
    expect(GetSentinelUserSettingsResponseSchema.parse(await saved.json()).data).toEqual({
      offline_mode: false,
      tier2_auto_allow: ['file_write'],
      search_without_asking: true,
    });

    await server.request(SETTINGS_PATH, patch('alice', { offline_mode: true }));
    await server.request(SETTINGS_PATH, patch('alice', { search_without_asking: false }));
    expect(await read('alice')).toEqual({
      offline_mode: true,
      tier2_auto_allow: ['file_write'],
      search_without_asking: false,
    });
    expect(await read('bob')).toEqual({ offline_mode: false, tier2_auto_allow: [], search_without_asking: true });
  });

  it('rejects an unknown Tier 2 kind and a non-boolean offline or search setting', async () => {
    const unknownKind = await server.request(SETTINGS_PATH, patch('carol', { tier2_auto_allow: ['reformat_disk'] }));
    expect(unknownKind.status).toBe(400);
    const badOffline = await server.request(SETTINGS_PATH, patch('carol', { offline_mode: 'yes' }));
    expect(badOffline.status).toBe(400);
    const badSearch = await server.request(SETTINGS_PATH, patch('carol', { search_without_asking: 'no' }));
    expect(badSearch.status).toBe(400);
    expect(await read('carol')).toEqual({ offline_mode: false, tier2_auto_allow: [], search_without_asking: true });
  });
});

import { Hono } from 'hono';
import {
  TrueFoundryAuthenticator,
  type TrueFoundrySessionClient,
} from '../../../src/truefoundry/TrueFoundryAuthenticator';
import type { GetSessionResponse } from '../../../src/truefoundry/TrueFoundryServiceFoundryServerClient';

describe('TrueFoundryAuthenticator', () => {
  it('stores public_base_url from GET /v1/session on the request context', async () => {
    const session: GetSessionResponse = {
      user: {
        tenantName: 'internal',
        roles: ['tenant-admin'],
        subject: {
          subjectId: 'user-1',
          subjectType: 'user',
          subjectDisplayName: 'Alice',
          subjectSlug: 'alice@example.com',
        },
      },
      public_base_url: 'https://tenant.example.com',
    };
    const getSession = jest.fn(async (_accessToken: string): Promise<GetSessionResponse> => session);
    const client: TrueFoundrySessionClient = { getSession };
    const authenticator = new TrueFoundryAuthenticator(client);
    const app = new Hono();
    app.get('/', async c => c.json(await authenticator.authenticate(c)));

    const res = await app.request('/', { headers: { Authorization: 'Bearer tok' } });

    expect(getSession).toHaveBeenCalledWith('tok');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tenant_id: 'internal',
      subject: { id: 'user-1', type: 'user', display_name: 'Alice' },
      roles: ['tenant-admin'],
      user_credential: 'tok',
      public_base_url: 'https://tenant.example.com',
    });
  });
});

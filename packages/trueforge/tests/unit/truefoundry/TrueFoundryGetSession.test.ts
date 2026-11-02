import { createLogger, transports } from 'winston';
import { TrueFoundryServiceFoundryServerClient } from '../../../src/truefoundry/TrueFoundryServiceFoundryServerClient';

const fetchMock = jest.fn();

jest.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

function jsonResponse(body: unknown): { ok: true; status: 200; text: () => Promise<string> } {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

function createClient(): TrueFoundryServiceFoundryServerClient {
  return new TrueFoundryServiceFoundryServerClient({
    serviceFoundryServerUrl: 'https://sfy.example',
    logger: createLogger({ transports: [new transports.Console({ silent: true })] }),
    tls: { enabled: false, dir: '' },
    httpTimeoutMs: 5_000,
    httpAgentTimeoutMs: 5_000,
    apiKey: 'key',
  });
}

const SESSION_USER = {
  tenantName: 'internal',
  roles: ['tenant-admin'],
  subject: {
    subjectId: 'user-1',
    subjectType: 'user',
    subjectDisplayName: 'Alice',
    subjectSlug: 'alice@example.com',
  },
};

describe('TrueFoundryServiceFoundryServerClient getSession', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('authenticates a session that has no controlPlaneURL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: SESSION_USER }));

    await expect(createClient().getSession('token')).resolves.toEqual({ user: SESSION_USER });
  });

  it('authenticates a session whose controlPlaneURL is null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: SESSION_USER, controlPlaneURL: null }));

    await expect(createClient().getSession('token')).resolves.toEqual({ user: SESSION_USER });
  });

  it('authenticates a session whose controlPlaneURL is an empty string', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: SESSION_USER, controlPlaneURL: '' }));

    await expect(createClient().getSession('token')).resolves.toEqual({ user: SESSION_USER });
  });

  it('maps controlPlaneURL to public_base_url when the session has one', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ user: SESSION_USER, controlPlaneURL: 'https://tenant.example.com' }),
    );

    await expect(createClient().getSession('token')).resolves.toEqual({
      user: SESSION_USER,
      public_base_url: 'https://tenant.example.com',
    });
  });

  it('still returns 401 when the session user is null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: null }));

    await expect(createClient().getSession('token')).rejects.toMatchObject({ status: 401 });
  });
});

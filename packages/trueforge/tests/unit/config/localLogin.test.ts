export {};

const OIDC_ENV = {
  OIDC_ISSUER_URL: 'http://localhost:5556/dex',
  OIDC_CLIENT_ID: 'client-a',
  OIDC_CLIENT_SECRET: 'secret-a',
  OIDC_ALLOWED_EMAILS: 'owner@example.invalid',
};

const MANAGED_KEYS: readonly string[] = [
  'STANDALONE',
  'PORT',
  'PUBLIC_BASE_URL',
  'ALLOWED_ORIGINS',
  'AUTH_COOKIE_SUFFIX',
  'TRUEFORGE_AUTH_MODE',
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_ALLOWED_EMAILS',
  'REQUIRE_AUTH',
  'TRUEFORGE_API_KEY',
];

type ConfigModule = typeof import('../../../src/config');

/** Loads a fresh config module under the given env; config reads the environment once at import. */
async function loadConfig(env: Partial<Record<string, string>>): Promise<ConfigModule> {
  jest.resetModules();
  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, { STANDALONE: 'true', PORT: '8790' }, env);
  return import('../../../src/config');
}

describe('local sign-in configuration', () => {
  const saved = new Map(MANAGED_KEYS.map(key => [key, process.env[key]]));

  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('selects local mode from TRUEFORGE_AUTH_MODE alone, with no OIDC set', async () => {
    const config = await loadConfig({ TRUEFORGE_AUTH_MODE: 'local' });

    expect(config.default.TRUEFORGE_AUTH_MODE).toBe('local');
    expect(config.default.OIDC).toBeUndefined();
    expect(config.default.OIDC_SET_BUT_IGNORED).toBe(false);
    expect(config.getTrueForgeAuthMode()).toBe(config.TrueForgeAuthMode.Local);
  });

  it('lets the named local mode win over a full OIDC set, and flags the OIDC settings as ignored', async () => {
    const config = await loadConfig({ ...OIDC_ENV, TRUEFORGE_AUTH_MODE: 'local' });

    expect(config.getTrueForgeAuthMode()).toBe(config.TrueForgeAuthMode.Local);
    expect(config.default.OIDC).toBeUndefined();
    expect(config.default.OIDC_SET_BUT_IGNORED).toBe(true);
  });

  it('ignores even a partial OIDC set in local mode instead of failing on it', async () => {
    const config = await loadConfig({ TRUEFORGE_AUTH_MODE: 'local', OIDC_ISSUER_URL: 'http://localhost:5556/dex' });

    expect(config.getTrueForgeAuthMode()).toBe(config.TrueForgeAuthMode.Local);
    expect(config.default.OIDC_SET_BUT_IGNORED).toBe(true);
  });

  it('refuses any other TRUEFORGE_AUTH_MODE value and says what to do', async () => {
    await expect(loadConfig({ TRUEFORGE_AUTH_MODE: 'oidc' })).rejects.toThrow(
      /TRUEFORGE_AUTH_MODE can only be set to "local"/,
    );
  });

  it('does not trip the no-login startup refusal in local mode', async () => {
    const config = await loadConfig({ TRUEFORGE_AUTH_MODE: 'local' });

    expect(() =>
      config.assertNetworkAuthRequirement({
        authMode: config.getTrueForgeAuthMode(),
        standalone: config.default.STANDALONE,
        host: config.default.HOST,
        requireAuth: config.default.REQUIRE_AUTH,
      }),
    ).not.toThrow();
  });

  it('refuses a plain-http non-loopback PUBLIC_BASE_URL in local mode, with the one sentence', async () => {
    await expect(
      loadConfig({ TRUEFORGE_AUTH_MODE: 'local', PUBLIC_BASE_URL: 'http://192.168.1.20:8790' }),
    ).rejects.toThrow(
      'Local sign-in works on this computer or behind https. Set PUBLIC_BASE_URL to an https address, or use the Docker install.',
    );
  });

  it('refuses a plain-http private address in ALLOWED_ORIGINS in local mode', async () => {
    await expect(
      loadConfig({ TRUEFORGE_AUTH_MODE: 'local', ALLOWED_ORIGINS: 'http://192.168.1.20:8790' }),
    ).rejects.toThrow(/Local sign-in works on this computer or behind https/);
  });

  it('starts in local mode behind an https PUBLIC_BASE_URL', async () => {
    const config = await loadConfig({ TRUEFORGE_AUTH_MODE: 'local', PUBLIC_BASE_URL: 'https://aman.example' });

    expect(config.getTrueForgeAuthMode()).toBe(config.TrueForgeAuthMode.Local);
  });

  it('starts in local mode with an https address listed beside loopback', async () => {
    const config = await loadConfig({ TRUEFORGE_AUTH_MODE: 'local', ALLOWED_ORIGINS: 'https://aman.example' });

    expect(config.getTrueForgeAuthMode()).toBe(config.TrueForgeAuthMode.Local);
  });

  it('leaves the origin rule off when local mode is not named', async () => {
    const config = await loadConfig({ ...OIDC_ENV, PUBLIC_BASE_URL: 'http://192.168.1.20:8790' });

    expect(config.getTrueForgeAuthMode()).toBe(config.TrueForgeAuthMode.Oidc);
  });
});

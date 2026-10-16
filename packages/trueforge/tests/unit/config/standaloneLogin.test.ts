const OIDC_WITHOUT_ALLOWLIST = {
  OIDC_ISSUER_URL: 'http://localhost:5556/dex',
  OIDC_CLIENT_ID: 'client-a',
  OIDC_CLIENT_SECRET: 'secret-a',
};

const OIDC_ENV = { ...OIDC_WITHOUT_ALLOWLIST, OIDC_ALLOWED_EMAILS: 'owner@example.invalid' };

const MANAGED_KEYS = [
  'STANDALONE',
  'PORT',
  'PUBLIC_BASE_URL',
  'AUTH_COOKIE_SUFFIX',
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_ALLOWED_EMAILS',
  'REQUIRE_AUTH',
  'TRUEFORGE_API_KEY',
] as const;

type ConfigModule = typeof import('../../../src/config');

/** Loads a fresh config module under the given env; config reads the environment once at import. */
async function loadConfig(env: Partial<Record<(typeof MANAGED_KEYS)[number], string>>): Promise<ConfigModule> {
  jest.resetModules();
  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, { STANDALONE: 'true', PORT: '8790' }, env);
  return import('../../../src/config');
}

describe('standalone login configuration', () => {
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

  it('parses OIDC in standalone and selects OIDC auth mode', async () => {
    const config = await loadConfig(OIDC_ENV);

    expect(config.default.STANDALONE).toBe(true);
    expect(config.default.OIDC?.OIDC_CLIENT_ID).toBe('client-a');
    expect(config.isOidcConfigured(config.default)).toBe(true);
    expect(config.getTrueForgeAuthMode()).toBe(config.TrueForgeAuthMode.Oidc);
  });

  it('keeps standalone without OIDC in standalone auth mode, which the startup guard refuses', async () => {
    const config = await loadConfig({});

    expect(config.isOidcConfigured(config.default)).toBe(false);
    expect(config.getTrueForgeAuthMode()).toBe(config.TrueForgeAuthMode.Standalone);
    expect(() =>
      config.assertNetworkAuthRequirement({
        authMode: config.getTrueForgeAuthMode(),
        standalone: config.default.STANDALONE,
        host: config.default.HOST,
        requireAuth: config.default.REQUIRE_AUTH,
      }),
    ).toThrow(/Refusing to start without login/);
  });

  it('keeps the all-or-nothing rule and names the missing settings', async () => {
    await expect(loadConfig({ OIDC_ISSUER_URL: 'https://login.example/dex' })).rejects.toThrow(
      /Missing: OIDC_CLIENT_ID, OIDC_CLIENT_SECRET/,
    );
  });

  it('rejects a non-loopback http issuer at load', async () => {
    await expect(loadConfig({ ...OIDC_ENV, OIDC_ISSUER_URL: 'http://login.example/dex' })).rejects.toThrow(
      /https, except http on a loopback host/,
    );
  });

  it('honors PUBLIC_BASE_URL in standalone and keeps Secure cookies tied to https', async () => {
    const config = await loadConfig({ ...OIDC_ENV, PUBLIC_BASE_URL: 'https://amanuensis.example' });

    expect(config.getPublicBaseUrl()).toBe('https://amanuensis.example');
  });

  it('defaults the public URL to loopback when unset', async () => {
    const config = await loadConfig({ ...OIDC_ENV, PORT: '18790' });

    expect(config.getPublicBaseUrl()).toBe('http://localhost:18790');
  });

  it('refuses a PUBLIC_BASE_URL path in standalone', async () => {
    await expect(loadConfig({ ...OIDC_ENV, PUBLIC_BASE_URL: 'https://amanuensis.example/app' })).rejects.toThrow(
      /origin with no path/,
    );
  });

  it('still allows a PUBLIC_BASE_URL path when distributed', async () => {
    const config = await loadConfig({
      STANDALONE: 'false',
      TRUEFORGE_API_KEY: 'k',
      PUBLIC_BASE_URL: 'https://amanuensis.example/app',
    });

    expect(config.getPublicBaseUrl()).toBe('https://amanuensis.example/app');
  });

  it('keeps the owner as the only allowed email', async () => {
    const config = await loadConfig(OIDC_ENV);

    expect(config.default.OIDC?.OIDC_ALLOWED_EMAILS).toEqual(['owner@example.invalid']);
  });

  it.each([
    ['no allowed email', undefined, /OIDC_ALLOWED_EMAILS must hold the email address of the owner/],
    ['an empty list', ' ', /OIDC_ALLOWED_EMAILS must hold the email address of the owner/],
    ['two addresses', 'owner@example.invalid,guest@example.invalid', /lists 2 addresses.*exactly one account/],
    ['a pattern', '*@example.invalid', /one exact email address, not a pattern/],
    ['a pattern next to the owner', 'owner@example.invalid,*@example.invalid', /lists 2 addresses/],
    ['text that is not an address', 'owner', /one exact email address/],
  ])('refuses to start with %s', async (_label, allowed, message) => {
    await expect(
      loadConfig(
        allowed === undefined ? OIDC_WITHOUT_ALLOWLIST : { ...OIDC_WITHOUT_ALLOWLIST, OIDC_ALLOWED_EMAILS: allowed },
      ),
    ).rejects.toThrow(message);
  });

  it('names the fix in the message', async () => {
    await expect(
      loadConfig({ ...OIDC_ENV, OIDC_ALLOWED_EMAILS: 'owner@example.invalid,guest@example.invalid' }),
    ).rejects.toThrow(/Set OIDC_ALLOWED_EMAILS to the owner's email address only/);
  });

  it('leaves a distributed server with several allowed emails and no REQUIRE_AUTH alone', async () => {
    const config = await loadConfig({
      ...OIDC_ENV,
      STANDALONE: 'false',
      TRUEFORGE_API_KEY: 'k',
      REQUIRE_AUTH: 'false',
      OIDC_ALLOWED_EMAILS: 'a@example.invalid,*@partner.example',
    });

    expect(config.default.STANDALONE).toBe(false);
    expect(config.default.OIDC?.OIDC_ALLOWED_EMAILS).toEqual(['a@example.invalid', '*@partner.example']);
  });

  it('leaves a distributed server without OIDC or an allowlist alone, as the smoke stack runs', async () => {
    const config = await loadConfig({ STANDALONE: 'false', TRUEFORGE_API_KEY: 'k', REQUIRE_AUTH: 'false' });

    expect(config.default.STANDALONE).toBe(false);
    expect(config.default.OIDC).toBeUndefined();
  });

  it('reads AUTH_COOKIE_SUFFIX and rejects unsafe characters', async () => {
    const config = await loadConfig({ AUTH_COOKIE_SUFFIX: '_main' });
    expect(config.getAuthCookieSuffix()).toBe('_main');

    await expect(loadConfig({ AUTH_COOKIE_SUFFIX: 'a;b' })).rejects.toThrow(/AUTH_COOKIE_SUFFIX/);
  });
});

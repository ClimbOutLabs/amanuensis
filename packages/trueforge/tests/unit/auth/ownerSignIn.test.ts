/** Sign-in under the settings the installer writes: the owner is the only allowed email. */
import type { OIDCConfig } from '../../../src/config';

const OWNER = 'owner@demo.example';
const GUEST = 'guest@demo.example';

const SIGN_IN_ENV_KEYS = [
  'STANDALONE',
  'PORT',
  'PUBLIC_BASE_URL',
  'AUTH_COOKIE_SUFFIX',
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_USER_REFERENCE_CLAIM',
  'OIDC_USER_ROLE_CLAIM',
  'OIDC_ADMIN_ROLE_VALUE',
  'OIDC_ALLOWED_EMAILS',
] as const;

const INSTALLER_ENV = {
  STANDALONE: 'true',
  PORT: '8790',
  PUBLIC_BASE_URL: 'https://aman.demo.example',
  AUTH_COOKIE_SUFFIX: 'ab12cd34',
  OIDC_ISSUER_URL: 'https://login.demo.example/dex',
  OIDC_CLIENT_ID: 'amanuensis-1a2b3c4d',
  OIDC_CLIENT_SECRET: 'client-secret',
  OIDC_USER_REFERENCE_CLAIM: 'email',
  OIDC_USER_ROLE_CLAIM: 'email',
  OIDC_ADMIN_ROLE_VALUE: OWNER,
  OIDC_ALLOWED_EMAILS: OWNER,
};

/** Fresh config, claims and identity modules under the given env; config reads the environment once at import. */
async function loadAuth(env: Record<string, string>) {
  jest.resetModules();
  for (const key of SIGN_IN_ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  const config = await import('../../../src/config');
  const claims = await import('../../../src/auth/claims');
  const identity = await import('../../../src/auth/identity');
  const { EmailNotAllowedError } = await import('../../../src/auth/emailAllowlist');
  const oidc: OIDCConfig | undefined = config.default.OIDC;
  if (oidc === undefined) {
    throw new Error('OIDC was not configured from the installer env');
  }
  return { config, claims, identity, oidc, EmailNotAllowedError };
}

describe('owner sign-in with the installer settings', () => {
  const saved = new Map(SIGN_IN_ENV_KEYS.map(key => [key, process.env[key]]));

  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('reads the one allowed email the installer writes', async () => {
    const { oidc, config } = await loadAuth(INSTALLER_ENV);
    expect(oidc.OIDC_ALLOWED_EMAILS).toEqual([OWNER]);
    expect(config.getTrueForgeAuthMode()).toBe(config.TrueForgeAuthMode.Oidc);
  });

  it('lets the owner in as admin', async () => {
    const { claims, identity, oidc } = await loadAuth(INSTALLER_ENV);
    const owner = claims.toRequestContext({
      claims: { email: OWNER, email_verified: true },
      config: oidc,
      user_credential: 'jwt',
    });
    expect(owner.subject.id).toBe(OWNER);
    expect(identity.hasAdminRole(owner)).toBe(true);
  });

  it('turns away any other email, however the login service vouches for it', async () => {
    const { claims, oidc, EmailNotAllowedError } = await loadAuth(INSTALLER_ENV);
    for (const email of [GUEST, 'owner@demo.example.evil.test', 'x-owner@demo.example', 'owner@demo.example.']) {
      expect(() => claims.toRequestContext({ claims: { email }, config: oidc, user_credential: 'jwt' })).toThrow(
        EmailNotAllowedError,
      );
    }
  });

  it('keeps the owner one identity whatever subject the login service gives the token', async () => {
    const { claims, identity, oidc } = await loadAuth(INSTALLER_ENV);
    const context = claims.toRequestContext({
      claims: { sub: 'another-subject', email: OWNER, email_verified: true },
      config: oidc,
      user_credential: 'jwt',
    });
    expect(context.subject.id).toBe(OWNER);
    expect(identity.hasAdminRole(context)).toBe(true);
  });

  it('turns away a token whose email is not verified', async () => {
    const { claims, oidc, EmailNotAllowedError } = await loadAuth(INSTALLER_ENV);
    expect(oidc.OIDC_REQUIRE_VERIFIED_EMAIL).toBe(true);
    expect(() =>
      claims.toRequestContext({
        claims: { email: OWNER, email_verified: false },
        config: oidc,
        user_credential: 'jwt',
      }),
    ).toThrow(EmailNotAllowedError);
    expect(() => claims.toRequestContext({ claims: { email: OWNER }, config: oidc, user_credential: 'jwt' })).toThrow(
      EmailNotAllowedError,
    );
    expect(
      claims.toRequestContext({ claims: { email: OWNER, email_verified: true }, config: oidc, user_credential: 'jwt' })
        .subject.id,
    ).toBe(OWNER);
  });

  it('turns away a token that names a subject but carries no email', async () => {
    const { claims, oidc, EmailNotAllowedError } = await loadAuth(INSTALLER_ENV);
    for (const tokenClaims of [{ sub: 'owner' }, { sub: OWNER }, { email: '' }, { email: 42 }]) {
      expect(() => claims.toRequestContext({ claims: tokenClaims, config: oidc, user_credential: 'jwt' })).toThrow(
        EmailNotAllowedError,
      );
    }
  });

  it('refuses to start with a second email, so a left-over member cannot sign in', async () => {
    await expect(loadAuth({ ...INSTALLER_ENV, OIDC_ALLOWED_EMAILS: `${OWNER},${GUEST}` })).rejects.toThrow(
      /lists 2 addresses; it must hold one/,
    );
  });

  it('refuses to start with a pattern or without an allowed email', async () => {
    await expect(loadAuth({ ...INSTALLER_ENV, OIDC_ALLOWED_EMAILS: '*@demo.example' })).rejects.toThrow(
      /must be one email address/,
    );
    const withoutAllowed = Object.fromEntries(
      Object.entries(INSTALLER_ENV).filter(([key]) => key !== 'OIDC_ALLOWED_EMAILS'),
    );
    await expect(loadAuth(withoutAllowed)).rejects.toThrow(/is empty; it must hold one address/);
  });

  it('asks the login service for the email claim', async () => {
    const { claims, oidc } = await loadAuth(INSTALLER_ENV);
    const params = claims.buildAuthorizationRequestParams(oidc);
    expect(params.claims.id_token['email']).toEqual({ essential: true });
  });
});

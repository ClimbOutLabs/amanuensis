/**
 * The hosted-demo sign-in model, loaded from the settings `installer/install.sh instance add-user` leaves in the
 * instance .env: the role claim is the email, the owner's email is the admin value, and the allowed emails list the
 * owner plus each added member. Members sign in and chat; only the owner is admin.
 */
const OWNER = 'owner@demo.example';
const JUDGE = 'judge1@demo.example';
const OTHER_JUDGE = 'judge2@demo.example';

const MANAGED_KEYS = [
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
  OIDC_ALLOWED_EMAILS: `${OWNER},${JUDGE},${OTHER_JUDGE}`,
};

/** Fresh config, claims and identity modules under the given env; config reads the environment once at import. */
async function loadAuth(env: Record<string, string>) {
  jest.resetModules();
  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  const config = await import('../../../src/config');
  const claims = await import('../../../src/auth/claims');
  const identity = await import('../../../src/auth/identity');
  const { EmailNotAllowedError } = await import('../../../src/auth/emailAllowlist');
  const oidc = config.default.OIDC;
  if (oidc === undefined) {
    throw new Error('OIDC was not configured from the installer env');
  }
  return { config, claims, identity, oidc, EmailNotAllowedError };
}

describe('member sign-in with the installer settings', () => {
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

  it('reads the allowed emails the installer writes, owner first', async () => {
    const { oidc, config } = await loadAuth(INSTALLER_ENV);
    expect(oidc.OIDC_ALLOWED_EMAILS).toEqual([OWNER, JUDGE, OTHER_JUDGE]);
    expect(config.getTrueForgeAuthMode()).toBe(config.TrueForgeAuthMode.Oidc);
  });

  it('lets a listed member in as a non-admin and the owner in as admin', async () => {
    const { claims, identity, oidc } = await loadAuth(INSTALLER_ENV);

    const judge = claims.toRequestContext({ claims: { email: JUDGE }, config: oidc, user_credential: 'jwt' });
    expect(judge.subject.id).toBe(JUDGE);
    expect(identity.hasAdminRole(judge)).toBe(false);

    const owner = claims.toRequestContext({ claims: { email: OWNER }, config: oidc, user_credential: 'jwt' });
    expect(owner.subject.id).toBe(OWNER);
    expect(identity.hasAdminRole(owner)).toBe(true);
  });

  it('turns away an email that is not listed, however the login service vouches for it', async () => {
    const { claims, oidc, EmailNotAllowedError } = await loadAuth(INSTALLER_ENV);
    for (const email of ['stranger@demo.example', 'judge1@demo.example.evil.test', 'x-judge1@demo.example']) {
      expect(() => claims.toRequestContext({ claims: { email }, config: oidc, user_credential: 'jwt' })).toThrow(
        EmailNotAllowedError,
      );
    }
    expect(() => claims.toRequestContext({ claims: { sub: 'judge1' }, config: oidc, user_credential: 'jwt' })).toThrow(
      EmailNotAllowedError,
    );
  });

  it('removing a member from the list turns that member away at once', async () => {
    const { claims, oidc, EmailNotAllowedError } = await loadAuth({
      ...INSTALLER_ENV,
      OIDC_ALLOWED_EMAILS: `${OWNER},${OTHER_JUDGE}`,
    });
    expect(() => claims.toRequestContext({ claims: { email: JUDGE }, config: oidc, user_credential: 'jwt' })).toThrow(
      EmailNotAllowedError,
    );
    expect(
      claims.toRequestContext({ claims: { email: OTHER_JUDGE }, config: oidc, user_credential: 'jwt' }).subject.id,
    ).toBe(OTHER_JUDGE);
  });

  it('never makes a member admin by spelling the owner email in another case', async () => {
    const { claims, identity, oidc } = await loadAuth(INSTALLER_ENV);
    // The allowlist ignores case but the admin match is exact, so this is a plain member with its own identity.
    const lookalike = claims.toRequestContext({
      claims: { email: 'Owner@Demo.Example' },
      config: oidc,
      user_credential: 'jwt',
    });
    expect(identity.hasAdminRole(lookalike)).toBe(false);
    expect(lookalike.subject.id).not.toBe(OWNER);
  });

  it('keeps every member a separate identity, so sessions and settings are per person', async () => {
    const { claims, oidc } = await loadAuth(INSTALLER_ENV);
    const first = claims.toRequestContext({ claims: { email: JUDGE }, config: oidc, user_credential: 'a' });
    const second = claims.toRequestContext({ claims: { email: OTHER_JUDGE }, config: oidc, user_credential: 'b' });
    expect(first.subject.id).not.toBe(second.subject.id);
  });

  it('asks the login service for the email claim whenever emails are restricted', async () => {
    const { claims, oidc } = await loadAuth(INSTALLER_ENV);
    const params = claims.buildAuthorizationRequestParams(oidc);
    expect(params.claims.id_token['email']).toEqual({ essential: true });
  });
});

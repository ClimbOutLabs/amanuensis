import winston from 'winston';
import { createAuthRouter } from '../../../src/apis/auth';
import { LocalAuthenticator } from '../../../src/auth/localAuthenticator';
import { createLocalUser, LOCAL_WRONG_CREDENTIALS_MESSAGE } from '../../../src/auth/localSignIn';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import {
  LocalUserAlreadyExistsError,
  type ILocalUserStore,
  type LocalUserRecord,
} from '../../../src/db/localUserStore';

const logger = winston.createLogger({ silent: true });
const EMAIL = 'owner@example.com';
const PASSWORD = 'a long enough password';
const NEW_PASSWORD = 'a different long password';

/** The local user store, in memory, honoring the same contract as the database stores. */
class MemoryLocalUserStore implements ILocalUserStore {
  #user: LocalUserRecord | undefined;
  /** When set, the password write fails the way a lost database write would. */
  failPasswordChange = false;

  getUser(): Promise<LocalUserRecord | undefined> {
    return Promise.resolve(this.#user);
  }

  createUser(record: LocalUserRecord): Promise<void> {
    if (this.#user !== undefined) {
      return Promise.reject(new LocalUserAlreadyExistsError());
    }
    this.#user = record;
    return Promise.resolve();
  }

  replacePasswordHashAndRevokeTerminalKeys(input: {
    password_hash: string;
    tenant_id: string;
    subject_id: string;
    revoked_at: string;
  }): Promise<{ replaced: boolean; revoked_count: number }> {
    if (this.failPasswordChange) {
      return Promise.reject(new Error('the disk is gone'));
    }
    if (this.#user === undefined) {
      return Promise.resolve({ replaced: false, revoked_count: 0 });
    }
    this.#user = {
      ...this.#user,
      password_hash: input.password_hash,
      session_version: this.#user.session_version + 1,
      // Stamped by the store, as the database stores stamp it inside their write.
      updated_at: new Date().toISOString(),
    };
    // No terminal keys live beside this memory store, so the revocation lands on none.
    return Promise.resolve({ replaced: true, revoked_count: 0 });
  }
}

/** The global settings store, in memory; the session secret lives here in the real stores too. */
class MemoryGlobalSettingsStore implements IGlobalSettingsStore {
  readonly #rows = new Map<string, GlobalSettingRecord>();

  getSetting(input: { key: string }): Promise<GlobalSettingRecord | undefined> {
    return Promise.resolve(this.#rows.get(input.key));
  }

  setSetting(input: { key: string; value: string }): Promise<GlobalSettingRecord> {
    const record = { key: input.key, value: input.value, updated_at: new Date().toISOString() };
    this.#rows.set(input.key, record);
    return Promise.resolve(record);
  }

  deleteSetting(input: { key: string }): Promise<void> {
    this.#rows.delete(input.key);
    return Promise.resolve();
  }

  compareAndSetSetting(input: { key: string; expected: string | null; value: string | null }): Promise<boolean> {
    const current = this.#rows.get(input.key)?.value ?? null;
    if (current !== input.expected) {
      return Promise.resolve(false);
    }
    if (input.value === null) {
      this.#rows.delete(input.key);
    } else {
      this.#rows.set(input.key, { key: input.key, value: input.value, updated_at: new Date().toISOString() });
    }
    return Promise.resolve(true);
  }
}

function setup() {
  const localUserStore = new MemoryLocalUserStore();
  const globalSettingsStore = new MemoryGlobalSettingsStore();
  const authenticator = new LocalAuthenticator({ localUserStore, globalSettingsStore });
  const router = createAuthRouter({
    oidcDiscovery: undefined,
    logger,
    authMiddleware: createAuthMiddleware(authenticator),
    localSignIn: { localUserStore, globalSettingsStore },
  });
  return { router, localUserStore, globalSettingsStore };
}

function formPost(
  router: ReturnType<typeof setup>['router'],
  path: string,
  fields: Record<string, string>,
  cookie?: string,
) {
  return router.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The id_token cookie pair from a response, for the next request's Cookie header. */
function sessionCookie(response: Response): string {
  const pair = response.headers
    .getSetCookie()
    .map(header => header.split(';')[0] ?? '')
    .find(part => part.startsWith('id_token='));
  if (pair === undefined) {
    throw new Error('The response set no id_token cookie');
  }
  return pair;
}

/** Makes the one sign-in the way the terminal command does, then signs in on the page. */
async function createSignIn(
  router: ReturnType<typeof setup>['router'],
  localUserStore: ILocalUserStore,
): Promise<string> {
  const created = await createLocalUser({ store: localUserStore, email: EMAIL, password: PASSWORD });
  expect(created.ok).toBe(true);
  const signedIn = await formPost(router, '/login', { email: EMAIL, password: PASSWORD });
  expect(signedIn.status).toBe(302);
  return sessionCookie(signedIn);
}

describe('local sign-in routes', () => {
  it('while no user exists, says which terminal command makes the sign-in and offers no form', async () => {
    const { router, localUserStore } = setup();

    const first = await router.request('/login');
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain('npx amanuensis --create-account');
    expect(firstHtml).not.toContain('<form');
    expect(firstHtml).not.toContain('type="password"');

    await createSignIn(router, localUserStore);

    const after = await router.request('/login');
    expect(after.status).toBe(200);
    const html = await after.text();
    expect(html).not.toContain('npx amanuensis --create-account');
    expect(html).toContain('Forgot your password? Stop Aman, run');
    expect(html).toContain('npx amanuensis --reset-password');
  });

  it('serves no way to create the sign-in from a browser', async () => {
    const { router, localUserStore } = setup();

    const posted = await formPost(router, '/create-account', {
      email: EMAIL,
      password: PASSWORD,
      password_confirm: PASSWORD,
    });
    expect(posted.status).toBeGreaterThanOrEqual(400);
    expect(posted.headers.getSetCookie()).toEqual([]);
    await expect(localUserStore.getUser()).resolves.toBeUndefined();

    const signIn = await formPost(router, '/login', { email: EMAIL, password: PASSWORD });
    expect(signIn.headers.getSetCookie().some(header => header.startsWith('id_token='))).toBe(false);
    await expect(localUserStore.getUser()).resolves.toBeUndefined();
  });

  it('signs in, reports a local-connected session on /me, and signs out', async () => {
    const { router, localUserStore } = setup();
    const createCookie = await createSignIn(router, localUserStore);

    const me = await router.request('/me', { headers: { Cookie: createCookie } });
    expect(me.status).toBe(200);
    const body: unknown = await me.json();
    expect(body).toMatchObject({ data: { type: 'local-connected', subject: { display_name: EMAIL } } });

    const logout = await router.request('/logout', { method: 'POST', headers: { Cookie: createCookie } });
    expect(logout.status).toBe(204);

    const signedIn = await formPost(router, '/login', { email: EMAIL, password: PASSWORD });
    expect(signedIn.status).toBe(302);
    const cookie = sessionCookie(signedIn);
    const meAgain = await router.request('/me', { headers: { Cookie: cookie } });
    expect(meAgain.status).toBe(200);
  });

  it('answers a wrong password and an unknown email with the same one sentence', async () => {
    const { router, localUserStore } = setup();
    await createSignIn(router, localUserStore);

    const wrongPassword = await formPost(router, '/login', { email: EMAIL, password: 'not the password' });
    expect(wrongPassword.status).toBe(401);
    const wrongText = await wrongPassword.text();
    expect(wrongText).toContain(LOCAL_WRONG_CREDENTIALS_MESSAGE);
    expect(wrongText).not.toContain('npx amanuensis --create-account');

    const unknownEmail = await formPost(router, '/login', { email: 'nobody@example.com', password: PASSWORD });
    expect(unknownEmail.status).toBe(401);
    expect(await unknownEmail.text()).toContain(LOCAL_WRONG_CREDENTIALS_MESSAGE);
  });

  it('locks out after the limiter threshold, even for the right password', async () => {
    const { router, localUserStore } = setup();
    await createSignIn(router, localUserStore);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refused = await formPost(router, '/login', { email: EMAIL, password: 'not the password' });
      expect(refused.status).toBe(401);
      await refused.text();
    }
    const locked = await formPost(router, '/login', { email: EMAIL, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain('Too many sign-in attempts.');
  });

  it('sets the session cookie with the OIDC flags: HttpOnly, SameSite Lax, and no Secure over http on this computer', async () => {
    const { router, localUserStore } = setup();
    await createLocalUser({ store: localUserStore, email: EMAIL, password: PASSWORD });
    const signedIn = await formPost(router, '/login', { email: EMAIL, password: PASSWORD });
    const setCookie = signedIn.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('id_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
  });

  it('changes the password from a live session and ends the other sessions', async () => {
    const { router, localUserStore } = setup();
    const firstCookie = await createSignIn(router, localUserStore);
    const secondSignIn = await formPost(router, '/login', { email: EMAIL, password: PASSWORD });
    const secondCookie = sessionCookie(secondSignIn);

    const wrongCurrent = await router.request('/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: firstCookie },
      body: JSON.stringify({ current_password: 'not the password', new_password: NEW_PASSWORD }),
    });
    expect(wrongCurrent.status).toBe(400);
    await wrongCurrent.text();

    const changed = await router.request('/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: firstCookie },
      body: JSON.stringify({ current_password: PASSWORD, new_password: NEW_PASSWORD }),
    });
    expect(changed.status).toBe(204);
    const freshCookie = sessionCookie(changed);

    // The session that made the change was re-issued and still works.
    expect((await router.request('/me', { headers: { Cookie: freshCookie } })).status).toBe(200);
    // The other session, issued under the old password, is over.
    expect((await router.request('/me', { headers: { Cookie: secondCookie } })).status).toBe(401);
    // The old password no longer signs in; the new one does.
    expect((await formPost(router, '/login', { email: EMAIL, password: PASSWORD })).status).toBe(401);
    expect((await formPost(router, '/login', { email: EMAIL, password: NEW_PASSWORD })).status).toBe(302);
  });

  it('keeps the old password when the password write fails partway', async () => {
    const { router, localUserStore } = setup();
    const cookie = await createSignIn(router, localUserStore);
    localUserStore.failPasswordChange = true;

    const changed = await router.request('/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_password: PASSWORD, new_password: NEW_PASSWORD }),
    });
    // The change reports failure, and neither half of it landed: the old password
    // still signs in and the new one does not.
    expect(changed.status).toBe(500);
    await changed.text();
    expect((await formPost(router, '/login', { email: EMAIL, password: PASSWORD })).status).toBe(302);
    expect((await formPost(router, '/login', { email: EMAIL, password: NEW_PASSWORD })).status).toBe(401);
  });
});

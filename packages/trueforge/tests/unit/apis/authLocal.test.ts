import winston from 'winston';
import { createAuthRouter } from '../../../src/apis/auth';
import { LocalAuthenticator } from '../../../src/auth/localAuthenticator';
import { LOCAL_SIGN_IN_EXISTS_MESSAGE, LOCAL_WRONG_CREDENTIALS_MESSAGE } from '../../../src/auth/localSignIn';
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

  replacePasswordHash(input: { password_hash: string; updated_at: string }): Promise<boolean> {
    if (this.#user === undefined) {
      return Promise.resolve(false);
    }
    this.#user = {
      ...this.#user,
      password_hash: input.password_hash,
      session_version: this.#user.session_version + 1,
      updated_at: input.updated_at,
    };
    return Promise.resolve(true);
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

async function createSignIn(router: ReturnType<typeof setup>['router']): Promise<string> {
  const created = await formPost(router, '/create-account', {
    email: EMAIL,
    password: PASSWORD,
    password_confirm: PASSWORD,
  });
  expect(created.status).toBe(302);
  return sessionCookie(created);
}

describe('local sign-in routes', () => {
  it('offers the create form only while no user exists, then the sign-in form', async () => {
    const { router } = setup();

    const first = await router.request('/login');
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('Create your sign-in');

    await createSignIn(router);

    const after = await router.request('/login');
    expect(after.status).toBe(200);
    const html = await after.text();
    expect(html).not.toContain('Create your sign-in');
    expect(html).toContain('Forgot your password? Stop Aman, run');
    expect(html).toContain('npx amanuensis --reset-password');
  });

  it('refuses a second create and keeps the first sign-in working', async () => {
    const { router, localUserStore } = setup();
    await createSignIn(router);
    const stored = await localUserStore.getUser();

    const second = await formPost(router, '/create-account', {
      email: 'other@example.com',
      password: 'another long password',
      password_confirm: 'another long password',
    });
    expect(second.status).toBe(400);
    expect(await second.text()).toContain(LOCAL_SIGN_IN_EXISTS_MESSAGE);
    await expect(localUserStore.getUser()).resolves.toEqual(stored);
  });

  it('refuses a create whose two passwords differ, and a password that is too short', async () => {
    const { router, localUserStore } = setup();

    const mismatch = await formPost(router, '/create-account', {
      email: EMAIL,
      password: PASSWORD,
      password_confirm: 'not the same password',
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain('The two passwords do not match');

    const short = await formPost(router, '/create-account', {
      email: EMAIL,
      password: 'short',
      password_confirm: 'short',
    });
    expect(short.status).toBe(400);
    expect(await short.text()).toContain('Use at least 8 characters for the password.');
    await expect(localUserStore.getUser()).resolves.toBeUndefined();
  });

  it('signs in, reports a local-connected session on /me, and signs out', async () => {
    const { router } = setup();
    const createCookie = await createSignIn(router);

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
    const { router } = setup();
    await createSignIn(router);

    const wrongPassword = await formPost(router, '/login', { email: EMAIL, password: 'not the password' });
    expect(wrongPassword.status).toBe(401);
    const wrongText = await wrongPassword.text();
    expect(wrongText).toContain(LOCAL_WRONG_CREDENTIALS_MESSAGE);
    expect(wrongText).not.toContain('Create your sign-in');

    const unknownEmail = await formPost(router, '/login', { email: 'nobody@example.com', password: PASSWORD });
    expect(unknownEmail.status).toBe(401);
    expect(await unknownEmail.text()).toContain(LOCAL_WRONG_CREDENTIALS_MESSAGE);
  });

  it('locks out after the limiter threshold, even for the right password', async () => {
    const { router } = setup();
    await createSignIn(router);

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
    const { router } = setup();
    const created = await formPost(router, '/create-account', {
      email: EMAIL,
      password: PASSWORD,
      password_confirm: PASSWORD,
    });
    const setCookie = created.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('id_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
  });

  it('changes the password from a live session and ends the other sessions', async () => {
    const { router } = setup();
    const firstCookie = await createSignIn(router);
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
});

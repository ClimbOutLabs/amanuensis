import winston from 'winston';
import { createAuthRouter } from '../../../src/apis/auth';
import { LocalAuthenticator } from '../../../src/auth/localAuthenticator';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import {
  LocalUserAlreadyExistsError,
  type ILocalUserStore,
  type LocalUserRecord,
} from '../../../src/db/localUserStore';

jest.mock('../../../src/config', () => {
  const actual = jest.requireActual<typeof import('../../../src/config')>('../../../src/config');
  const publicBase = { ...actual.default, PUBLIC_BASE_URL: 'https://aman.example' };
  return {
    ...actual,
    __esModule: true,
    default: publicBase,
    getPublicBaseUrl: jest.fn(() => actual.getPublicBaseUrl(publicBase)),
    getPublicUiBasePath: jest.fn(() => actual.getPublicUiBasePath(publicBase)),
    isTrueFoundryModeEnabled: jest.fn(() => false),
  };
});

const logger = winston.createLogger({ silent: true });

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

describe('local sign-in session cookie behind an https public address', () => {
  it('carries Secure beside HttpOnly and SameSite Lax', async () => {
    const localUserStore = new MemoryLocalUserStore();
    const globalSettingsStore = new MemoryGlobalSettingsStore();
    const router = createAuthRouter({
      oidcDiscovery: undefined,
      logger,
      authMiddleware: createAuthMiddleware(new LocalAuthenticator({ localUserStore, globalSettingsStore })),
      localSignIn: { localUserStore, globalSettingsStore },
    });

    const created = await router.request('/create-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'owner@example.com',
        password: 'a long enough password',
        password_confirm: 'a long enough password',
      }).toString(),
    });

    expect(created.status).toBe(302);
    const setCookie = created.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('id_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
  });
});

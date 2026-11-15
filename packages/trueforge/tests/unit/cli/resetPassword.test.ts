import { createLocalUser, verifyLocalSignIn } from '../../../src/auth/localSignIn';
import { runResetPassword, type ResetPasswordDeps } from '../../../src/cli/resetPassword';
import {
  LocalUserAlreadyExistsError,
  type ILocalUserStore,
  type LocalUserRecord,
} from '../../../src/db/localUserStore';
import { fakeIo } from './fakeIo';

const EMAIL = 'owner@example.com';
const OLD_PASSWORD = 'the old long password';
const NEW_PASSWORD = 'the new long password';

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

async function setup(params: { serverRunning?: boolean; withUser?: boolean } = {}) {
  const store = new MemoryLocalUserStore();
  if (params.withUser !== false) {
    const created = await createLocalUser({ store, email: EMAIL, password: OLD_PASSWORD });
    if (!created.ok) {
      throw new Error('Test setup failed to create the user');
    }
  }
  const deps: ResetPasswordDeps = {
    serverRunning: () => Promise.resolve(params.serverRunning ?? false),
    openStore: () => Promise.resolve({ store, close: () => Promise.resolve() }),
    readPasswordPair: () => Promise.resolve({ password: NEW_PASSWORD, confirm: NEW_PASSWORD }),
  };
  return { store, deps };
}

describe('reset-password', () => {
  it('replaces the hash: the new password signs in and the old one does not', async () => {
    const { store, deps } = await setup();
    const io = fakeIo();

    const code = await runResetPassword({ args: [], io, deps });

    expect(code).toBe(0);
    expect(io.err.join('')).toContain('Your password is reset. Start Aman and sign in with the new password.');
    await expect(verifyLocalSignIn({ store, email: EMAIL, password: NEW_PASSWORD })).resolves.toBeDefined();
    await expect(verifyLocalSignIn({ store, email: EMAIL, password: OLD_PASSWORD })).resolves.toBeUndefined();
  });

  it('raises the session version, so sessions issued before the reset stop working', async () => {
    const { store, deps } = await setup();
    const before = await store.getUser();

    const code = await runResetPassword({ args: [], io: fakeIo(), deps });

    expect(code).toBe(0);
    const after = await store.getUser();
    expect(before).toBeDefined();
    expect(after?.session_version).toBe((before?.session_version ?? 0) + 1);
  });

  it('refuses while the server is running and changes nothing', async () => {
    const { store, deps } = await setup({ serverRunning: true });
    const io = fakeIo();
    const before = await store.getUser();

    const code = await runResetPassword({ args: [], io, deps });

    expect(code).toBe(1);
    expect(io.err.join('')).toContain('Aman is running. Stop it first, then run this again.');
    await expect(store.getUser()).resolves.toEqual(before);
  });

  it('refuses when the two passwords differ', async () => {
    const { store, deps } = await setup();
    deps.readPasswordPair = () => Promise.resolve({ password: NEW_PASSWORD, confirm: 'something else entirely' });
    const io = fakeIo();

    const code = await runResetPassword({ args: [], io, deps });

    expect(code).toBe(1);
    expect(io.err.join('')).toContain('The two passwords do not match');
    await expect(verifyLocalSignIn({ store, email: EMAIL, password: OLD_PASSWORD })).resolves.toBeDefined();
  });

  it('refuses a new password that is too short', async () => {
    const { deps } = await setup();
    deps.readPasswordPair = () => Promise.resolve({ password: 'short', confirm: 'short' });
    const io = fakeIo();

    const code = await runResetPassword({ args: [], io, deps });

    expect(code).toBe(1);
    expect(io.err.join('')).toContain('Use at least 8 characters for the password.');
  });

  it('help says to pass the same port the server uses', async () => {
    const { deps } = await setup();
    const io = fakeIo();

    const code = await runResetPassword({ args: ['--help'], io, deps });

    expect(code).toBe(0);
    const help = io.err.join('');
    expect(help).toContain('--port');
    expect(help).toContain('pass the same one');
  });

  it('says there is nothing to reset when no sign-in exists yet', async () => {
    const { deps } = await setup({ withUser: false });
    const io = fakeIo();

    const code = await runResetPassword({ args: [], io, deps });

    expect(code).toBe(1);
    expect(io.err.join('')).toContain('No sign-in is set up yet');
  });
});

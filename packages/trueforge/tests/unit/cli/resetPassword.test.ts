import { createLocalUser, verifyLocalSignIn } from '../../../src/auth/localSignIn';
import { hashTerminalKey, mintTerminalKey } from '../../../src/auth/terminalKey';
import { runResetPassword, type ResetPasswordDeps } from '../../../src/cli/resetPassword';
import type { ILocalUserStore } from '../../../src/db/localUserStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteLocalUserStore } from '../../../src/db/sqlite/local-user-store/SqliteLocalUserStore';
import { TerminalKeyStore } from '../../../src/db/terminalKeyStore';
import { fakeIo } from './fakeIo';
import { MemoryLocalUserStore } from './memoryLocalUserStore';

const EMAIL = 'owner@example.com';
const OLD_PASSWORD = 'the old long password';
const NEW_PASSWORD = 'the new long password';

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

describe('reset-password against the real stores', () => {
  async function realSetup() {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteLocalUserStore(db);
    const created = await createLocalUser({ store, email: EMAIL, password: OLD_PASSWORD });
    if (!created.ok) {
      throw new Error('Test setup failed to create the user');
    }
    return { db, store, userId: created.user.id };
  }

  function realDeps(store: ILocalUserStore): ResetPasswordDeps {
    return {
      serverRunning: () => Promise.resolve(false),
      openStore: () => Promise.resolve({ store, close: () => Promise.resolve() }),
      readPasswordPair: () => Promise.resolve({ password: NEW_PASSWORD, confirm: NEW_PASSWORD }),
    };
  }

  it('revokes every paired terminal key with the reset', async () => {
    const { db, store, userId } = await realSetup();
    const terminalKeyStore = new TerminalKeyStore(db);
    const key = mintTerminalKey();
    await terminalKeyStore.create({
      id: 'key-1',
      tenant_id: 'default',
      subject_id: userId,
      subject_type: 'user',
      subject_display_name: 'Owner',
      device_name: 'Pippa',
      key_hash: hashTerminalKey(key),
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      revoked_at: null,
    });

    const code = await runResetPassword({ args: [], io: fakeIo(), deps: realDeps(store) });

    expect(code).toBe(0);
    const record = await terminalKeyStore.findByKeyHash(hashTerminalKey(key));
    expect(record?.revoked_at).not.toBeNull();
    await db.destroy();
  });

  it('changes nothing when the revocation write fails', async () => {
    const { db, store } = await realSetup();
    // The revocation half of the write cannot land: the key table is gone, as a
    // failed disk or a lost connection would make its update fail.
    await db.schema.dropTable('terminal_key').execute();

    await expect(runResetPassword({ args: [], io: fakeIo(), deps: realDeps(store) })).rejects.toThrow();

    await expect(verifyLocalSignIn({ store, email: EMAIL, password: OLD_PASSWORD })).resolves.toBeDefined();
    await expect(verifyLocalSignIn({ store, email: EMAIL, password: NEW_PASSWORD })).resolves.toBeUndefined();
    const after = await store.getUser();
    expect(after?.session_version).toBe(1);
    await db.destroy();
  });
});

/**
 * A password change and the paired terminal keys, against the real stores.
 * Changing the password and revoking every key are one write: when the revocation
 * half fails, the password stays as it was and the change reports failure. And a
 * pairing that was under way when the password changed does not leave a working
 * key behind, even though its key row lands after the revocation has run. Nora is
 * the owner and Pippa her terminal; everyone here is made up.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createLogger } from 'winston';
import { LocalAuthenticator } from '../../../src/auth/localAuthenticator';
import { changeLocalUserPassword, createLocalUser } from '../../../src/auth/localSignIn';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import { verifyPasswordValue } from '../../../src/auth/passwordHash';
import { hashTerminalKey, mintTerminalKey } from '../../../src/auth/terminalKey';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteLocalUserStore } from '../../../src/db/sqlite/local-user-store/SqliteLocalUserStore';
import { TerminalKeyStore, type ITerminalKeyStore } from '../../../src/db/terminalKeyStore';
import { TerminalPairingService } from '../../../src/runtime/terminalPairing';

const EMAIL = 'nora@example.test';
const OLD_PASSWORD = 'nora-password-1';
const NEW_PASSWORD = 'nora-password-2';

/** The global settings store in memory; the session secret lives here in the real stores too. */
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

type SqliteDb = ReturnType<typeof createSqliteDb>;

async function buildStores(db: SqliteDb) {
  const userStore = new SqliteLocalUserStore(db);
  const created = await createLocalUser({ store: userStore, email: EMAIL, password: OLD_PASSWORD });
  if (!created.ok) {
    throw new Error('the local user was not created');
  }
  return { userStore, user: created.user };
}

describe('password change and terminal keys', () => {
  it('leaves the old password in place when the revocation write fails', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const { userStore, user } = await buildStores(db);
    const keyStore = new TerminalKeyStore(db);
    const key = mintTerminalKey();
    await keyStore.create({
      id: 'key-1',
      tenant_id: 'default',
      subject_id: user.id,
      subject_type: 'user',
      subject_display_name: 'Nora',
      device_name: 'Pippa',
      key_hash: hashTerminalKey(key),
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      revoked_at: null,
    });

    // The revocation half of the write cannot land: the key table is gone, as a
    // failed disk or a lost connection would make its update fail.
    await db.schema.dropTable('terminal_key').execute();

    await expect(
      changeLocalUserPassword({
        store: userStore,
        user_id: user.id,
        current_password: OLD_PASSWORD,
        new_password: NEW_PASSWORD,
      }),
    ).rejects.toThrow();

    // Both halves are undone: the old password still verifies, the new one does
    // not, and the session version never moved.
    const after = await userStore.getUser();
    if (after === undefined) {
      throw new Error('the local user vanished');
    }
    expect(await verifyPasswordValue(OLD_PASSWORD, after.password_hash)).toBe(true);
    expect(await verifyPasswordValue(NEW_PASSWORD, after.password_hash)).toBe(false);
    expect(after.session_version).toBe(1);
    await db.destroy();
  });

  it('revokes the keys and changes the password together when both writes land', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const { userStore, user } = await buildStores(db);
    const keyStore = new TerminalKeyStore(db);
    const key = mintTerminalKey();
    await keyStore.create({
      id: 'key-1',
      tenant_id: 'default',
      subject_id: user.id,
      subject_type: 'user',
      subject_display_name: 'Nora',
      device_name: 'Pippa',
      key_hash: hashTerminalKey(key),
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      revoked_at: null,
    });

    const changed = await changeLocalUserPassword({
      store: userStore,
      user_id: user.id,
      current_password: OLD_PASSWORD,
      new_password: NEW_PASSWORD,
    });

    expect(changed.ok).toBe(true);
    if (changed.ok) {
      expect(changed.revoked_terminal_keys).toBe(1);
    }
    const record = await keyStore.findByKeyHash(hashTerminalKey(key));
    expect(record?.revoked_at).not.toBeNull();
    await db.destroy();
  });

  it('leaves no working key when a pairing was in flight across the change', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const { userStore, user } = await buildStores(db);
    const realStore = new TerminalKeyStore(db);

    // A key store whose insert can be held open, to stage the confirm mid-flight.
    let releaseCreate: () => void = () => undefined;
    let enteredCreate: () => void = () => undefined;
    const createGate = new Promise<void>(resolve => {
      releaseCreate = resolve;
    });
    const createEntered = new Promise<void>(resolve => {
      enteredCreate = resolve;
    });
    const gatedStore: ITerminalKeyStore = {
      create: async record => {
        enteredCreate();
        await createGate;
        await realStore.create(record);
      },
      findByKeyHash: hash => realStore.findByKeyHash(hash),
      listForOwner: input => realStore.listForOwner(input),
      markUsed: input => realStore.markUsed(input),
      revoke: input => realStore.revoke(input),
      revokeAllForOwner: input => realStore.revokeAllForOwner(input),
    };
    const service = new TerminalPairingService({ terminalKeyStore: gatedStore });
    const started = await service.start({ device_name: 'Pippa' });
    const owner = {
      tenant_id: 'default',
      subject_id: user.id,
      subject_type: 'user',
      subject_display_name: 'Nora',
    };

    // The confirm is claimed, then its key insert is held open.
    const confirmPromise = service.confirm({ code: started.code, owner });
    await createEntered;

    // The password changes while the insert is in flight. Its revocation runs
    // inside the same write and finds no key row yet.
    const changed = await changeLocalUserPassword({
      store: userStore,
      user_id: user.id,
      current_password: OLD_PASSWORD,
      new_password: NEW_PASSWORD,
    });
    expect(changed.ok).toBe(true);
    if (changed.ok) {
      expect(changed.revoked_terminal_keys).toBe(0);
    }

    releaseCreate();
    await confirmPromise;
    const completion = await service.complete({ pairing_id: started.pairing_id, code: started.code });
    if (completion?.status !== 'paired') {
      throw new Error('the pairing did not complete');
    }
    const racedKey = completion.terminal_key;

    // The row really did land after the revocation, unrevoked: only the password
    // change watermark can refuse this key, and it does.
    const record = await realStore.findByKeyHash(hashTerminalKey(racedKey));
    expect(record?.revoked_at).toBeNull();

    const authenticator = new LocalAuthenticator({
      localUserStore: userStore,
      globalSettingsStore: new MemoryGlobalSettingsStore(),
      terminalKeyStore: realStore,
      logger: createLogger({ silent: true }),
    });
    const app = new OpenAPIHono();
    app.onError((error, c) => {
      if (error instanceof HTTPException) {
        return c.json({ error: { message: error.message } }, error.status);
      }
      throw error;
    });
    const sessions = new OpenAPIHono();
    sessions.use('*', createAuthMiddleware(authenticator));
    sessions.get('/', c => c.json({ data: { ok: true } }));
    app.route('/api/v1/sessions', sessions);

    const refused = await app.request('/api/v1/sessions', {
      headers: { Authorization: `Bearer ${racedKey}` },
    });
    expect(refused.status).toBe(401);

    // A terminal paired entirely after the change works as it should.
    const freshService = new TerminalPairingService({ terminalKeyStore: realStore });
    const freshStart = await freshService.start({ device_name: 'Pippa Two' });
    await freshService.confirm({ code: freshStart.code, owner });
    const freshCompletion = await freshService.complete({
      pairing_id: freshStart.pairing_id,
      code: freshStart.code,
    });
    if (freshCompletion?.status !== 'paired') {
      throw new Error('the fresh pairing did not complete');
    }
    const accepted = await app.request('/api/v1/sessions', {
      headers: { Authorization: `Bearer ${freshCompletion.terminal_key}` },
    });
    expect(accepted.status).toBe(200);
    await db.destroy();
  });
});

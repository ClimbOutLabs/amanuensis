import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { UsageError } from '../../../../src/cli/io';
import { runSecrets } from '../../../../src/cli/secrets';
import { SqliteGlobalSettingsStore } from '../../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { FileKeyProvider, encodeKeyFile } from '../../../../src/secrets/fileKeyProvider';
import { KEY_CHECK_SETTING, createMasterKey } from '../../../../src/secrets/keyCheck';
import { RECOVERY_COPY_SETTING, recoverMasterKey } from '../../../../src/secrets/recoveryKey';
import { RETIRED_KEYS_SETTING } from '../../../../src/secrets/retiredKeys';
import { secretKeyId } from '../../../../src/secrets/secretCipher';
import { SecretVault } from '../../../../src/secrets/secretVault';
import { fakeIo } from '../../../unit/cli/fakeIo';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

const InitResultSchema = z.object({ recovery_key: z.string().regex(/^\d{6}(-\d{6}){7}$/) });

describe('aman secrets', () => {
  const databases: SqliteTestDatabase[] = [];
  let dir: string;
  let keyFile: string;

  async function database(): Promise<SqliteTestDatabase> {
    const created = await createSqliteTestDatabase();
    databases.push(created);
    return created;
  }

  async function init(env: SqliteTestDatabase): Promise<string> {
    const io = fakeIo();
    const code = await runSecrets({
      args: ['init', '--sqlite', env.databaseFile, '--key-file', keyFile],
      io,
      env: {},
    });
    expect(code).toBe(0);
    return InitResultSchema.parse(JSON.parse(io.out.join(''))).recovery_key;
  }

  function checkRecovery({ env, recoveryKey }: { env: SqliteTestDatabase; recoveryKey: string }): Promise<number> {
    return runSecrets({
      args: ['check-recovery'],
      io: fakeIo({ stdin: recoveryKey }),
      env: { SQLITE_PATH: env.databaseFile },
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aman-secrets-cli-'));
    keyFile = path.join(dir, 'secrets', 'master.key');
  });

  afterEach(async () => {
    await Promise.all(databases.splice(0).map(env => env.teardown()));
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('makes a private key file, records the check value and prints a recovery key that works', async () => {
    const env = await database();
    const recoveryKey = await init(env);

    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    const settings = new SqliteGlobalSettingsStore(env.db);
    const vault = new SecretVault({ provider: new FileKeyProvider(keyFile), settings });
    expect(await vault.refresh()).toEqual({ status: 'unlocked' });
    expect(await checkRecovery({ env, recoveryKey })).toBe(0);
  }, 120_000);

  it('uses the key file that is already there and never replaces it', async () => {
    const env = await database();
    const key = createMasterKey();
    await writeFile(path.join(dir, 'existing.key'), encodeKeyFile(key), { mode: 0o600 });
    keyFile = path.join(dir, 'existing.key');

    await init(env);
    expect(await readFile(keyFile, 'utf8')).toBe(encodeKeyFile(key));
  }, 120_000);

  it('refuses to set up the same database twice', async () => {
    const env = await database();
    await init(env);
    const before = await new SqliteGlobalSettingsStore(env.db).getSetting({ key: RECOVERY_COPY_SETTING });

    await expect(
      runSecrets({ args: ['init', '--sqlite', env.databaseFile, '--key-file', keyFile], io: fakeIo(), env: {} }),
    ).rejects.toThrow('already set up');
    const after = await new SqliteGlobalSettingsStore(env.db).getSetting({ key: RECOVERY_COPY_SETTING });
    expect(after?.value).toBe(before?.value);
  }, 120_000);

  it('refuses a key file that does not match the database', async () => {
    const env = await database();
    await init(env);
    await writeFile(keyFile, encodeKeyFile(createMasterKey()), { mode: 0o600 });

    await expect(
      runSecrets({ args: ['init', '--sqlite', env.databaseFile, '--key-file', keyFile], io: fakeIo(), env: {} }),
    ).rejects.toThrow('different key');
  }, 120_000);

  it('leaves no new key file behind when the database belongs to a key that is gone', async () => {
    const env = await database();
    await init(env);
    await rm(keyFile);

    await expect(
      runSecrets({ args: ['init', '--sqlite', env.databaseFile, '--key-file', keyFile], io: fakeIo(), env: {} }),
    ).rejects.toThrow('different key');
    await expect(stat(keyFile)).rejects.toThrow('ENOENT');
  }, 120_000);

  it('finishes a setup that stopped before the recovery key was saved', async () => {
    const env = await database();
    const firstKey = await init(env);
    await new SqliteGlobalSettingsStore(env.db).deleteSetting({ key: RECOVERY_COPY_SETTING });

    const secondKey = await init(env);
    expect(secondKey).not.toBe(firstKey);
    expect(await checkRecovery({ env, recoveryKey: secondKey })).toBe(0);
  }, 120_000);

  it('gives each instance on one machine its own check value and recovery key from the same key file', async () => {
    const first = await database();
    const second = await database();
    const firstRecovery = await init(first);
    const secondRecovery = await init(second);

    expect(firstRecovery).not.toBe(secondRecovery);
    const firstCheck = await new SqliteGlobalSettingsStore(first.db).getSetting({ key: KEY_CHECK_SETTING });
    const secondCheck = await new SqliteGlobalSettingsStore(second.db).getSetting({ key: KEY_CHECK_SETTING });
    expect(firstCheck?.value).not.toBe(secondCheck?.value);
    for (const env of [first, second]) {
      const vault = new SecretVault({
        provider: new FileKeyProvider(keyFile),
        settings: new SqliteGlobalSettingsStore(env.db),
      });
      expect(await vault.refresh()).toEqual({ status: 'unlocked' });
    }
    await expect(checkRecovery({ env: second, recoveryKey: firstRecovery })).rejects.toThrow(UsageError);
  }, 120_000);

  it('never prints the master key', async () => {
    const env = await database();
    const io = fakeIo();
    await runSecrets({ args: ['init', '--sqlite', env.databaseFile, '--key-file', keyFile], io, env: {} });
    const keyText = (await readFile(keyFile, 'utf8')).trim();
    expect([...io.out, ...io.err].join('')).not.toContain(keyText);
  }, 120_000);

  it('makes the database when setup runs before the first start', async () => {
    const sqlite = path.join(dir, 'data', 'fresh.sqlite');
    const io = fakeIo();
    expect(await runSecrets({ args: ['init', '--sqlite', sqlite, '--key-file', keyFile], io, env: {} })).toBe(0);
    const recoveryKey = InitResultSchema.parse(JSON.parse(io.out.join(''))).recovery_key;
    const check = fakeIo({ stdin: recoveryKey });
    expect(await runSecrets({ args: ['check-recovery', '--sqlite', sqlite], io: check, env: {} })).toBe(0);
  }, 120_000);

  it('with --if-needed, sets up once and then changes nothing', async () => {
    const env = await database();
    const args = ['init', '--if-needed', '--sqlite', env.databaseFile, '--key-file', keyFile];
    const first = fakeIo();
    expect(await runSecrets({ args, io: first, env: {} })).toBe(0);
    InitResultSchema.parse(JSON.parse(first.out.join('')));
    const before = await new SqliteGlobalSettingsStore(env.db).getSetting({ key: RECOVERY_COPY_SETTING });

    const second = fakeIo();
    expect(await runSecrets({ args, io: second, env: {} })).toBe(0);
    expect(JSON.parse(second.out.join(''))).toEqual({ already_set_up: true });
    const after = await new SqliteGlobalSettingsStore(env.db).getSetting({ key: RECOVERY_COPY_SETTING });
    expect(after?.value).toBe(before?.value);
  }, 120_000);

  it('with --if-needed, still refuses a database that belongs to another key', async () => {
    const env = await database();
    await init(env);
    await writeFile(keyFile, encodeKeyFile(createMasterKey()), { mode: 0o600 });

    await expect(
      runSecrets({
        args: ['init', '--if-needed', '--sqlite', env.databaseFile, '--key-file', keyFile],
        io: fakeIo(),
        env: {},
      }),
    ).rejects.toThrow('different key');
  }, 120_000);

  it('first-run shows the recovery key in plain words once, then says nothing', async () => {
    const env = await database();
    const args = ['first-run', '--sqlite', env.databaseFile, '--key-file', keyFile];
    const first = fakeIo();
    expect(await runSecrets({ args, io: first, env: {} })).toBe(0);
    const shown = /\d{6}(-\d{6}){7}/.exec(first.out.join(''));
    expect(first.out.join('')).toContain('Write it down');
    expect(await checkRecovery({ env, recoveryKey: shown?.[0] ?? '' })).toBe(0);

    const second = fakeIo();
    expect(await runSecrets({ args, io: second, env: {} })).toBe(0);
    expect([...second.out, ...second.err]).toEqual([]);
  }, 120_000);

  it('key makes the key file once, touches no database, and never prints the key', async () => {
    const first = fakeIo();
    expect(await runSecrets({ args: ['key', '--key-file', keyFile], io: first, env: {} })).toBe(0);
    expect(JSON.parse(first.out.join(''))).toEqual({ created: true });
    const made = await readFile(keyFile, 'utf8');
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect([...first.out, ...first.err].join('')).not.toContain(made.trim());

    const second = fakeIo();
    expect(await runSecrets({ args: ['key', '--key-file', keyFile], io: second, env: {} })).toBe(0);
    expect(JSON.parse(second.out.join(''))).toEqual({ created: false });
    expect(await readFile(keyFile, 'utf8')).toBe(made);
  });

  describe('adopt', () => {
    const context = { table: 'logins', primary_key: 'nora', field: 'password' };

    async function adopt({ env, recoveryKey }: { env: SqliteTestDatabase; recoveryKey: string }): Promise<unknown> {
      const io = fakeIo({ stdin: recoveryKey });
      const code = await runSecrets({
        args: ['adopt', '--sqlite', env.databaseFile, '--key-file', keyFile],
        io,
        env: {},
      });
      expect(code).toBe(0);
      return JSON.parse(io.out.join(''));
    }

    async function unlocked(env: SqliteTestDatabase): Promise<SecretVault> {
      const vault = new SecretVault({
        provider: new FileKeyProvider(keyFile),
        settings: new SqliteGlobalSettingsStore(env.db),
      });
      expect(await vault.refresh()).toEqual({ status: 'unlocked' });
      return vault;
    }

    it('opens logins saved on the earlier computer, saves new ones with this computer key, and keeps the recovery key', async () => {
      const env = await database();
      const recoveryKey = await init(env);
      const earlier = (await unlocked(env)).encrypt({ plaintext: 'made-up-password', context });
      const earlierKeyText = await readFile(keyFile, 'utf8');

      // Another computer: its own key file, the same database.
      keyFile = path.join(dir, 'other-computer', 'master.key');
      expect(await adopt({ env, recoveryKey })).toEqual({ adopted: true });
      expect(await readFile(keyFile, 'utf8')).not.toBe(earlierKeyText);

      const vault = await unlocked(env);
      expect(vault.decrypt({ value: earlier, context })).toBe('made-up-password');
      const later = vault.encrypt({ plaintext: 'second-password', context });
      expect(secretKeyId(later)).not.toBe(secretKeyId(earlier));
      expect(vault.decrypt({ value: later, context })).toBe('second-password');
      expect(await checkRecovery({ env, recoveryKey })).toBe(0);
      expect(await adopt({ env, recoveryKey })).toEqual({ already_adopted: true });
    }, 120_000);

    it('keeps every earlier key when the database moves a second time', async () => {
      const env = await database();
      const recoveryKey = await init(env);
      const first = (await unlocked(env)).encrypt({ plaintext: 'one', context });
      keyFile = path.join(dir, 'second', 'master.key');
      await adopt({ env, recoveryKey });
      const second = (await unlocked(env)).encrypt({ plaintext: 'two', context });
      keyFile = path.join(dir, 'third', 'master.key');
      await adopt({ env, recoveryKey });

      const vault = await unlocked(env);
      expect(vault.decrypt({ value: first, context })).toBe('one');
      expect(vault.decrypt({ value: second, context })).toBe('two');
    }, 120_000);

    it('refuses a wrong recovery key, changes nothing and leaves no key file behind', async () => {
      const env = await database();
      const recoveryKey = await init(env);
      const earlierKeyFile = keyFile;
      const settings = new SqliteGlobalSettingsStore(env.db);
      const before = await settings.getSetting({ key: KEY_CHECK_SETTING });

      keyFile = path.join(dir, 'other-computer', 'master.key');
      await expect(
        runSecrets({
          args: ['adopt', '--sqlite', env.databaseFile, '--key-file', keyFile],
          io: fakeIo({ stdin: '000000-000000-000000-000000-000000-000000-000000-000000' }),
          env: {},
        }),
      ).rejects.toThrow(UsageError);
      await expect(stat(keyFile)).rejects.toThrow('ENOENT');
      expect((await settings.getSetting({ key: KEY_CHECK_SETTING }))?.value).toBe(before?.value);
      expect(await settings.getSetting({ key: RETIRED_KEYS_SETTING })).toBeUndefined();
      keyFile = earlierKeyFile;
      await unlocked(env);
      expect(await checkRecovery({ env, recoveryKey })).toBe(0);
    }, 120_000);

    it('finishes a move that stopped before the recovery key was tied to this computer', async () => {
      const env = await database();
      const recoveryKey = await init(env);
      const settings = new SqliteGlobalSettingsStore(env.db);
      const earlierCopy = await settings.getSetting({ key: RECOVERY_COPY_SETTING });
      keyFile = path.join(dir, 'other-computer', 'master.key');
      await adopt({ env, recoveryKey });
      await settings.setSetting({ key: RECOVERY_COPY_SETTING, value: earlierCopy?.value ?? '' });

      expect(await adopt({ env, recoveryKey })).toEqual({ already_adopted: true });
      const loaded = await new FileKeyProvider(keyFile).load();
      const recovered = await recoverMasterKey({ settings, recoveryKey });
      expect(loaded.status === 'loaded' && loaded.key.equals(recovered)).toBe(true);
    }, 120_000);

    it('says to set up instead when the database never had a key', async () => {
      const env = await database();
      await expect(
        runSecrets({
          args: ['adopt', '--sqlite', env.databaseFile, '--key-file', keyFile],
          io: fakeIo({ stdin: '000000-000000-000000-000000-000000-000000-000000-000000' }),
          env: {},
        }),
      ).rejects.toThrow('secrets init');
    }, 120_000);
  });

  it('explains a missing database and a missing action', async () => {
    await expect(
      runSecrets({
        args: ['check-recovery', '--sqlite', path.join(dir, 'none.sqlite')],
        io: fakeIo({ stdin: '0' }),
        env: {},
      }),
    ).rejects.toThrow('No database');
    await expect(runSecrets({ args: [], io: fakeIo(), env: {} })).rejects.toThrow(UsageError);
  });
});

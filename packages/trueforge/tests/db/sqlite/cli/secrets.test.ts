import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { UsageError } from '../../../../src/cli/io';
import { runSecrets } from '../../../../src/cli/secrets';
import { SqliteGlobalSettingsStore } from '../../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { FileKeyProvider, encodeKeyFile } from '../../../../src/secrets/fileKeyProvider';
import { KEY_CHECK_SETTING, createMasterKey } from '../../../../src/secrets/keyCheck';
import { RECOVERY_COPY_SETTING } from '../../../../src/secrets/recoveryKey';
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

  it('explains a missing database and a missing action', async () => {
    await expect(
      runSecrets({
        args: ['init', '--sqlite', path.join(dir, 'none.sqlite'), '--key-file', keyFile],
        io: fakeIo(),
        env: {},
      }),
    ).rejects.toThrow('No database');
    await expect(runSecrets({ args: [], io: fakeIo(), env: {} })).rejects.toThrow(UsageError);
  });
});

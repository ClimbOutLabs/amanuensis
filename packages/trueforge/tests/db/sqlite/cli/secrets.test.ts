import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { UsageError } from '../../../../src/cli/io';
import { runSecrets } from '../../../../src/cli/secrets';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { DatabaseKeyError, createSqliteDb, sqliteFileState } from '../../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { deriveDatabaseKey } from '../../../../src/secrets/databaseKey';
import { FileKeyProvider, encodeKeyFile } from '../../../../src/secrets/fileKeyProvider';
import { KEY_CHECK_SETTING, createMasterKey } from '../../../../src/secrets/keyCheck';
import { KeyRecordFile, keyRecordPath } from '../../../../src/secrets/keyRecordFile';
import { RECOVERY_COPY_SETTING, recoverMasterKey } from '../../../../src/secrets/recoveryKey';
import { RETIRED_KEYS_SETTING } from '../../../../src/secrets/retiredKeys';
import { savedEnvFor } from '../../../../src/secrets/savedEnvStart';
import { secretKeyId } from '../../../../src/secrets/secretCipher';
import { SecretVault } from '../../../../src/secrets/secretVault';
import { fakeIo } from '../../../unit/cli/fakeIo';

const InitResultSchema = z.object({ recovery_key: z.string().regex(/^\d{6}(-\d{6}){7}$/) });
const WRONG_RECOVERY_KEY = '000000-000000-000000-000000-000000-000000-000000-000000';
const MARKER = 'a line only this test would write';

describe('aman secrets', () => {
  let dir: string;
  let keyFile: string;
  let sqlite: string;

  function records(file: string = sqlite): KeyRecordFile {
    return new KeyRecordFile(keyRecordPath(file));
  }

  async function machineKey(): Promise<Buffer> {
    const loaded = await new FileKeyProvider(keyFile).load();
    if (loaded.status !== 'loaded') {
      throw new Error(`no key file: ${loaded.reason}`);
    }
    return loaded.key;
  }

  async function init(file: string = sqlite): Promise<string> {
    const io = fakeIo();
    const code = await runSecrets({ args: ['init', '--sqlite', file, '--key-file', keyFile], io, env: {} });
    expect(code).toBe(0);
    return InitResultSchema.parse(JSON.parse(io.out.join(''))).recovery_key;
  }

  function checkRecovery({ file = sqlite, recoveryKey }: { file?: string; recoveryKey: string }): Promise<number> {
    return runSecrets({ args: ['check-recovery'], io: fakeIo({ stdin: recoveryKey }), env: { SQLITE_PATH: file } });
  }

  async function unlocked(file: string = sqlite): Promise<SecretVault> {
    const vault = new SecretVault({ provider: new FileKeyProvider(keyFile), settings: records(file) });
    expect(await vault.refresh()).toEqual({ status: 'unlocked' });
    return vault;
  }

  /** A database as Aman kept it before encryption: readable by anyone who has the file. */
  async function readableDatabase(file: string = sqlite): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const db = createSqliteDb(file);
    try {
      await migrateSqliteToLatest(db);
      await new SqliteGlobalSettingsStore(db).setSetting({ key: 'test_marker', value: MARKER });
    } finally {
      await db.destroy();
    }
  }

  async function markerIn({ file = sqlite, key }: { file?: string; key: Buffer }): Promise<string | undefined> {
    const db = createSqliteDb(file, { key: deriveDatabaseKey(key) });
    try {
      return (await new SqliteGlobalSettingsStore(db).getSetting({ key: 'test_marker' }))?.value;
    } finally {
      await db.destroy();
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aman-secrets-cli-'));
    keyFile = path.join(dir, 'secrets', 'master.key');
    sqlite = path.join(dir, 'data', 'db.sqlite');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('makes a private key file, an encrypted database and a recovery key that works', async () => {
    const recoveryKey = await init();

    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(keyRecordPath(sqlite))).mode & 0o777).toBe(0o600);
    await unlocked();
    expect(sqliteFileState({ filename: sqlite, key: deriveDatabaseKey(await machineKey()) })).toBe('encrypted');
    expect((await readFile(sqlite)).subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3');
    expect(() => createSqliteDb(sqlite)).toThrow(DatabaseKeyError);
    expect(await checkRecovery({ recoveryKey })).toBe(0);
  }, 120_000);

  it('encrypts a database from before encryption where it is, and keeps what was in it', async () => {
    await readableDatabase();
    expect((await readFile(sqlite)).includes(MARKER)).toBe(true);

    await init();
    expect((await readFile(sqlite)).includes(MARKER)).toBe(false);
    expect(await markerIn({ key: await machineKey() })).toBe(MARKER);
    // The key records are beside the database, never in it.
    const db = createSqliteDb(sqlite, { key: deriveDatabaseKey(await machineKey()) });
    try {
      expect(await new SqliteGlobalSettingsStore(db).getSetting({ key: KEY_CHECK_SETTING })).toBeUndefined();
    } finally {
      await db.destroy();
    }
  }, 120_000);

  it('refuses to encrypt a database that Aman still has open, and leaves it and the key as they were', async () => {
    await readableDatabase();
    const open = createSqliteDb(sqlite);
    try {
      await new SqliteGlobalSettingsStore(open).getSetting({ key: 'test_marker' });
      await expect(
        runSecrets({ args: ['init', '--sqlite', sqlite, '--key-file', keyFile], io: fakeIo(), env: {} }),
      ).rejects.toThrow('in use');
    } finally {
      await open.destroy();
    }
    await expect(stat(keyFile)).rejects.toThrow('ENOENT');
    await expect(stat(keyRecordPath(sqlite))).rejects.toThrow('ENOENT');
    expect((await readFile(sqlite)).includes(MARKER)).toBe(true);
  }, 120_000);

  it('uses the key file that is already there and never replaces it', async () => {
    const key = createMasterKey();
    keyFile = path.join(dir, 'existing.key');
    await writeFile(keyFile, encodeKeyFile(key), { mode: 0o600 });

    await init();
    expect(await readFile(keyFile, 'utf8')).toBe(encodeKeyFile(key));
  }, 120_000);

  it('refuses to set up the same database twice', async () => {
    await init();
    const before = await records().getSetting({ key: RECOVERY_COPY_SETTING });

    await expect(
      runSecrets({ args: ['init', '--sqlite', sqlite, '--key-file', keyFile], io: fakeIo(), env: {} }),
    ).rejects.toThrow('already set up');
    expect((await records().getSetting({ key: RECOVERY_COPY_SETTING }))?.value).toBe(before?.value);
  }, 120_000);

  it('refuses a key file that does not match the database', async () => {
    await init();
    await writeFile(keyFile, encodeKeyFile(createMasterKey()), { mode: 0o600 });

    await expect(
      runSecrets({ args: ['init', '--sqlite', sqlite, '--key-file', keyFile], io: fakeIo(), env: {} }),
    ).rejects.toThrow('different key');
  }, 120_000);

  it('leaves no new key file behind when the database belongs to a key that is gone', async () => {
    await init();
    await rm(keyFile);

    await expect(
      runSecrets({ args: ['init', '--sqlite', sqlite, '--key-file', keyFile], io: fakeIo(), env: {} }),
    ).rejects.toThrow('different key');
    await expect(stat(keyFile)).rejects.toThrow('ENOENT');
  }, 120_000);

  it('refuses an encrypted database whose key records are gone', async () => {
    await init();
    await rm(keyRecordPath(sqlite));
    await rm(keyFile);

    await expect(
      runSecrets({ args: ['init', '--sqlite', sqlite, '--key-file', keyFile], io: fakeIo(), env: {} }),
    ).rejects.toThrow('different key');
    await expect(stat(keyFile)).rejects.toThrow('ENOENT');
  }, 120_000);

  it('finishes a setup that stopped before the recovery key was saved', async () => {
    const firstKey = await init();
    await records().deleteSetting({ key: RECOVERY_COPY_SETTING });

    const secondKey = await init();
    expect(secondKey).not.toBe(firstKey);
    expect(await checkRecovery({ recoveryKey: secondKey })).toBe(0);
  }, 120_000);

  it('finishes a setup that stopped after the database was encrypted but before its records were saved', async () => {
    await readableDatabase();
    await init();
    await rm(keyRecordPath(sqlite));

    const recoveryKey = await init();
    expect(await markerIn({ key: await machineKey() })).toBe(MARKER);
    expect(await checkRecovery({ recoveryKey })).toBe(0);
  }, 120_000);

  it('gives each instance on one machine its own check value and recovery key from the same key file', async () => {
    const second = path.join(dir, 'second', 'db.sqlite');
    const firstRecovery = await init();
    const secondRecovery = await init(second);

    expect(firstRecovery).not.toBe(secondRecovery);
    const firstCheck = await records().getSetting({ key: KEY_CHECK_SETTING });
    const secondCheck = await records(second).getSetting({ key: KEY_CHECK_SETTING });
    expect(firstCheck?.value).not.toBe(secondCheck?.value);
    await unlocked();
    await unlocked(second);
    await expect(checkRecovery({ file: second, recoveryKey: firstRecovery })).rejects.toThrow(UsageError);
  }, 120_000);

  it('never prints the master key', async () => {
    const io = fakeIo();
    await runSecrets({ args: ['init', '--sqlite', sqlite, '--key-file', keyFile], io, env: {} });
    const keyText = (await readFile(keyFile, 'utf8')).trim();
    expect([...io.out, ...io.err].join('')).not.toContain(keyText);
  }, 120_000);

  it('with --if-needed, sets up once and then changes nothing', async () => {
    const args = ['init', '--if-needed', '--sqlite', sqlite, '--key-file', keyFile];
    const first = fakeIo();
    expect(await runSecrets({ args, io: first, env: {} })).toBe(0);
    InitResultSchema.parse(JSON.parse(first.out.join('')));
    const before = await records().getSetting({ key: RECOVERY_COPY_SETTING });

    const second = fakeIo();
    expect(await runSecrets({ args, io: second, env: {} })).toBe(0);
    expect(JSON.parse(second.out.join(''))).toEqual({ already_set_up: true });
    expect((await records().getSetting({ key: RECOVERY_COPY_SETTING }))?.value).toBe(before?.value);
  }, 120_000);

  it('with --if-needed, encrypts a readable database put back under records that are already set up', async () => {
    const recoveryKey = await init();
    await rm(sqlite);
    await readableDatabase();

    const io = fakeIo();
    const args = ['init', '--if-needed', '--sqlite', sqlite, '--key-file', keyFile];
    expect(await runSecrets({ args, io, env: {} })).toBe(0);
    expect(JSON.parse(io.out.join(''))).toEqual({ already_set_up: true });
    expect((await readFile(sqlite)).includes(MARKER)).toBe(false);
    expect(await markerIn({ key: await machineKey() })).toBe(MARKER);
    expect(await checkRecovery({ recoveryKey })).toBe(0);
  }, 120_000);

  it('with --if-needed, still refuses a database that belongs to another key', async () => {
    await init();
    await writeFile(keyFile, encodeKeyFile(createMasterKey()), { mode: 0o600 });

    await expect(
      runSecrets({ args: ['init', '--if-needed', '--sqlite', sqlite, '--key-file', keyFile], io: fakeIo(), env: {} }),
    ).rejects.toThrow('different key');
  }, 120_000);

  it('first-run shows the recovery key in plain words once, then says nothing', async () => {
    const args = ['first-run', '--sqlite', sqlite, '--key-file', keyFile];
    const first = fakeIo();
    expect(await runSecrets({ args, io: first, env: {} })).toBe(0);
    const shown = /\d{6}(-\d{6}){7}/.exec(first.out.join(''));
    expect(first.out.join('')).toContain('Write it down');
    expect(await checkRecovery({ recoveryKey: shown?.[0] ?? '' })).toBe(0);

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

  describe('env', () => {
    const TOKEN = 'made-up-token-factory-key-0123456789';

    async function envCommand(args: string[], stdin?: string): Promise<unknown> {
      const io = fakeIo(stdin === undefined ? {} : { stdin });
      const code = await runSecrets({ args: ['env', ...args, '--sqlite', sqlite, '--key-file', keyFile], io, env: {} });
      expect(code).toBe(0);
      return JSON.parse(io.out.join(''));
    }

    function atStart(): Record<string, string> {
      return savedEnvFor({ SQLITE_PATH: sqlite, SECRETS_KEY_FILE: keyFile });
    }

    it('keeps a paid-account key encrypted beside the database and hands it over at start', async () => {
      await init();
      expect(await envCommand(['put', '--name', 'NEBIUS_API_KEY'], `${TOKEN}\n`)).toEqual({ saved: 'NEBIUS_API_KEY' });
      expect(await envCommand(['list'])).toEqual({ names: ['NEBIUS_API_KEY'] });
      expect(await readFile(keyRecordPath(sqlite), 'utf8')).not.toContain(TOKEN);
      expect(atStart()).toEqual({ NEBIUS_API_KEY: TOKEN });

      expect(await envCommand(['put', '--name', 'TWILIO_AUTH_TOKEN'], 'made-up-twilio-token')).toEqual({
        saved: 'TWILIO_AUTH_TOKEN',
      });
      expect(await envCommand(['drop', '--name', 'NEBIUS_API_KEY'])).toEqual({ dropped: 'NEBIUS_API_KEY' });
      expect(atStart()).toEqual({ TWILIO_AUTH_TOKEN: 'made-up-twilio-token' });
    }, 120_000);

    it('hands nothing over without this computer key, with another key, or for a Postgres instance', async () => {
      await init();
      await envCommand(['put', '--name', 'NEBIUS_API_KEY'], TOKEN);
      expect(savedEnvFor({ SQLITE_PATH: sqlite, SECRETS_KEY_FILE: path.join(dir, 'none.key') })).toEqual({});
      const other = path.join(dir, 'other.key');
      await writeFile(other, encodeKeyFile(createMasterKey()), { mode: 0o600 });
      expect(savedEnvFor({ SQLITE_PATH: sqlite, SECRETS_KEY_FILE: other })).toEqual({});
      expect(savedEnvFor({ SQLITE_PATH: sqlite, SECRETS_KEY_FILE: keyFile, STANDALONE: 'false' })).toEqual({});
    }, 120_000);

    it('takes only the settings that are paid-account keys, and never an empty value', async () => {
      await init();
      const put = (name: string, stdin: string): Promise<number> =>
        runSecrets({
          args: ['env', 'put', '--name', name, '--sqlite', sqlite, '--key-file', keyFile],
          io: fakeIo({ stdin }),
          env: {},
        });
      await expect(put('OIDC_CLIENT_SECRET', 'x')).rejects.toBeInstanceOf(UsageError);
      await expect(put('NEBIUS_API_KEY', '\n')).rejects.toBeInstanceOf(UsageError);
      expect(await envCommand(['list'])).toEqual({ names: [] });
    }, 120_000);

    it('refuses to save before setup, and with a key that is not this database key', async () => {
      await readableDatabase();
      const put = (): Promise<number> =>
        runSecrets({
          args: ['env', 'put', '--name', 'NEBIUS_API_KEY', '--sqlite', sqlite, '--key-file', keyFile],
          io: fakeIo({ stdin: TOKEN }),
          env: {},
        });
      await expect(put()).rejects.toThrow('aman secrets init');
      await init();
      keyFile = path.join(dir, 'other.key');
      await writeFile(keyFile, encodeKeyFile(createMasterKey()), { mode: 0o600 });
      await expect(put()).rejects.toThrow('aman secrets init');
    }, 120_000);

    it('moves the saved keys along when the database moves to another computer', async () => {
      const recoveryKey = await init();
      await envCommand(['put', '--name', 'NEBIUS_API_KEY'], TOKEN);
      keyFile = path.join(dir, 'other-computer', 'master.key');
      const io = fakeIo({ stdin: recoveryKey });
      expect(await runSecrets({ args: ['adopt', '--sqlite', sqlite, '--key-file', keyFile], io, env: {} })).toBe(0);
      expect(atStart()).toEqual({ NEBIUS_API_KEY: TOKEN });
    }, 120_000);
  });

  describe('adopt', () => {
    const context = { table: 'logins', primary_key: 'nora', field: 'password' };

    async function adopt(recoveryKey: string): Promise<unknown> {
      const io = fakeIo({ stdin: recoveryKey });
      const code = await runSecrets({ args: ['adopt', '--sqlite', sqlite, '--key-file', keyFile], io, env: {} });
      expect(code).toBe(0);
      return JSON.parse(io.out.join(''));
    }

    it('moves the database and its saved logins to this computer key, and keeps the recovery key', async () => {
      await readableDatabase();
      const recoveryKey = await init();
      const earlierKey = await machineKey();
      const earlier = (await unlocked()).encrypt({ plaintext: 'made-up-password', context });

      // Another computer: its own key file, the same database and key records.
      keyFile = path.join(dir, 'other-computer', 'master.key');
      expect(await adopt(recoveryKey)).toEqual({ adopted: true });
      const key = await machineKey();
      expect(key.equals(earlierKey)).toBe(false);

      expect(await markerIn({ key })).toBe(MARKER);
      expect(sqliteFileState({ filename: sqlite, key: deriveDatabaseKey(earlierKey) })).toBe('other_key');
      const vault = await unlocked();
      expect(vault.decrypt({ value: earlier, context })).toBe('made-up-password');
      const later = vault.encrypt({ plaintext: 'second-password', context });
      expect(secretKeyId(later)).not.toBe(secretKeyId(earlier));
      expect(vault.decrypt({ value: later, context })).toBe('second-password');
      expect(await checkRecovery({ recoveryKey })).toBe(0);
      expect(await adopt(recoveryKey)).toEqual({ already_adopted: true });
    }, 120_000);

    it('keeps every earlier key when the database moves a second time', async () => {
      const recoveryKey = await init();
      const first = (await unlocked()).encrypt({ plaintext: 'one', context });
      keyFile = path.join(dir, 'second', 'master.key');
      await adopt(recoveryKey);
      const second = (await unlocked()).encrypt({ plaintext: 'two', context });
      keyFile = path.join(dir, 'third', 'master.key');
      await adopt(recoveryKey);

      const vault = await unlocked();
      expect(vault.decrypt({ value: first, context })).toBe('one');
      expect(vault.decrypt({ value: second, context })).toBe('two');
    }, 120_000);

    it('refuses a wrong recovery key, changes nothing and leaves no key file behind', async () => {
      const recoveryKey = await init();
      const earlierKeyFile = keyFile;
      const before = await records().getSetting({ key: KEY_CHECK_SETTING });

      keyFile = path.join(dir, 'other-computer', 'master.key');
      await expect(
        runSecrets({
          args: ['adopt', '--sqlite', sqlite, '--key-file', keyFile],
          io: fakeIo({ stdin: WRONG_RECOVERY_KEY }),
          env: {},
        }),
      ).rejects.toThrow(UsageError);
      await expect(stat(keyFile)).rejects.toThrow('ENOENT');
      expect((await records().getSetting({ key: KEY_CHECK_SETTING }))?.value).toBe(before?.value);
      expect(await records().getSetting({ key: RETIRED_KEYS_SETTING })).toBeUndefined();
      keyFile = earlierKeyFile;
      await unlocked();
      expect(sqliteFileState({ filename: sqlite, key: deriveDatabaseKey(await machineKey()) })).toBe('encrypted');
      expect(await checkRecovery({ recoveryKey })).toBe(0);
    }, 120_000);

    it('finishes a move that stopped after the database moved but before its records did', async () => {
      await readableDatabase();
      const recoveryKey = await init();
      const earlierRecords = await readFile(keyRecordPath(sqlite), 'utf8');
      keyFile = path.join(dir, 'other-computer', 'master.key');
      await adopt(recoveryKey);
      await writeFile(keyRecordPath(sqlite), earlierRecords);

      expect(await adopt(recoveryKey)).toEqual({ adopted: true });
      const key = await machineKey();
      expect(await markerIn({ key })).toBe(MARKER);
      expect((await recoverMasterKey({ settings: records(), recoveryKey })).equals(key)).toBe(true);
    }, 120_000);

    it('finishes a move that stopped before the recovery key was tied to this computer', async () => {
      const recoveryKey = await init();
      const earlierCopy = await records().getSetting({ key: RECOVERY_COPY_SETTING });
      keyFile = path.join(dir, 'other-computer', 'master.key');
      await adopt(recoveryKey);
      await records().setSetting({ key: RECOVERY_COPY_SETTING, value: earlierCopy?.value ?? '' });

      expect(await adopt(recoveryKey)).toEqual({ already_adopted: true });
      expect((await recoverMasterKey({ settings: records(), recoveryKey })).equals(await machineKey())).toBe(true);
    }, 120_000);

    it('says to set up instead when the database never had a key', async () => {
      await readableDatabase();
      await expect(
        runSecrets({
          args: ['adopt', '--sqlite', sqlite, '--key-file', keyFile],
          io: fakeIo({ stdin: WRONG_RECOVERY_KEY }),
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

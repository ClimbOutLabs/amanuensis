import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { backupSqliteFile, createBackup } from '../../../src/cli/backup';
import { createBackupCheck } from '../../../src/cli/backupCheck';
import { runSecrets } from '../../../src/cli/secrets';
import { knownSqliteMigrationNames, migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb, sqliteFileState } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { deriveDatabaseKey } from '../../../src/secrets/databaseKey';
import { FileKeyProvider } from '../../../src/secrets/fileKeyProvider';
import { keyRecordPath } from '../../../src/secrets/keyRecordFile';
import { DatabaseLockedError } from '../../../src/secrets/sqliteAccess';
import { fakeIo } from './fakeIo';

const CANARY = 'a chat line only this test would write';
const InitResultSchema = z.object({ recovery_key: z.string() });
const ManifestSchema = z.object({ files: z.array(z.object({ path: z.string() })) });
const CheckSchema = z.object({ newer: z.boolean(), unknown_migrations: z.array(z.string()) });

describe('backup of an encrypted instance', () => {
  let scratch: string;
  let sqlite: string;
  let keyFile: string;
  let recoveryKey: string;
  let target: string;

  async function databaseKey(): Promise<Buffer> {
    const loaded = await new FileKeyProvider(keyFile).load();
    if (loaded.status !== 'loaded') {
      throw new Error(loaded.reason);
    }
    return deriveDatabaseKey(loaded.key);
  }

  function backupCheck(env: Record<string, string>) {
    return createBackupCheck({ env, knownMigrations: knownSqliteMigrationNames });
  }

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'aman-backup-encrypted-'));
    sqlite = path.join(scratch, 'live', 'db.sqlite');
    keyFile = path.join(scratch, 'key', 'master.key');
    target = path.join(scratch, 'out');
    await mkdir(path.join(scratch, 'live', 'memory'), { recursive: true });
    await mkdir(path.join(scratch, 'live', 'persona'), { recursive: true });
    const plain = createSqliteDb(sqlite);
    try {
      await migrateSqliteToLatest(plain);
      await new SqliteGlobalSettingsStore(plain).setSetting({ key: 'test_marker', value: CANARY });
    } finally {
      await plain.destroy();
    }
    const io = fakeIo();
    await runSecrets({ args: ['init', '--sqlite', sqlite, '--key-file', keyFile], io, env: {} });
    recoveryKey = InitResultSchema.parse(JSON.parse(io.out.join(''))).recovery_key;

    const command = createBackup({
      env: { SECRETS_KEY_FILE: keyFile },
      now: () => new Date('2026-10-10T12:00:00.000Z'),
      backupSqlite: backupSqliteFile,
    });
    const args = [
      '--target',
      target,
      '--sqlite',
      sqlite,
      '--memory-dir',
      path.join(scratch, 'live', 'memory'),
      '--persona-dir',
      path.join(scratch, 'live', 'persona'),
    ];
    expect(await command({ args, io: fakeIo() })).toBe(0);
  }, 120_000);

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('keeps the copy encrypted with the same key, with nothing readable in it', async () => {
    const copy = path.join(target, 'db.sqlite');
    expect((await readFile(copy)).includes(CANARY)).toBe(false);
    expect(sqliteFileState({ filename: copy, key: await databaseKey() })).toBe('encrypted');
    const db = createSqliteDb(copy, { key: await databaseKey() });
    try {
      expect((await new SqliteGlobalSettingsStore(db).getSetting({ key: 'test_marker' }))?.value).toBe(CANARY);
    } finally {
      await db.destroy();
    }
  }, 120_000);

  it('takes the key records along and lists them in the manifest', async () => {
    expect(await readFile(path.join(target, 'db.sqlite.keys'), 'utf8')).toBe(
      await readFile(keyRecordPath(sqlite), 'utf8'),
    );
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8')));
    expect(manifest.files.map(file => file.path)).toEqual(['db.sqlite', 'db.sqlite.keys']);
  }, 120_000);

  it("is checked with this computer's key, or on another computer with the recovery key", async () => {
    const copy = path.join(target, 'db.sqlite');
    const here = fakeIo();
    expect(await backupCheck({ SECRETS_KEY_FILE: keyFile })({ args: ['--sqlite', copy], io: here })).toBe(0);
    expect(CheckSchema.parse(JSON.parse(here.out.join('')))).toEqual({ newer: false, unknown_migrations: [] });

    const recoveryFile = path.join(scratch, 'recovery.txt');
    await writeFile(recoveryFile, `${recoveryKey}\n`);
    const elsewhere = fakeIo();
    const args = ['--sqlite', copy, '--recovery-key-file', recoveryFile];
    expect(await backupCheck({})({ args, io: elsewhere })).toBe(0);
    expect(CheckSchema.parse(JSON.parse(elsewhere.out.join('')))).toEqual({ newer: false, unknown_migrations: [] });
  }, 120_000);

  it("is refused without this computer's key", async () => {
    const copy = path.join(target, 'db.sqlite');
    await expect(backupCheck({})({ args: ['--sqlite', copy], io: fakeIo() })).rejects.toThrow(DatabaseLockedError);
  }, 120_000);
});

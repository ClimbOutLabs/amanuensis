import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import { backupSqliteFile, createBackup, type BackupDeps } from '../../../src/cli/backup';
import { UsageError } from '../../../src/cli/io';
import { fakeIo } from './fakeIo';

const ManifestSchema = z.object({
  version: z.literal(1),
  created_at: z.string(),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number() })),
});
const ResultSchema = z.object({ target: z.string(), manifest: z.string(), files: z.number(), bytes: z.number() });

const FIXED_NOW = new Date('2026-10-10T12:00:00.000Z');
let scratch: string;
let sqlitePath: string;
let memoryDir: string;
let personaDir: string;

function deps(overrides: Partial<BackupDeps> = {}): BackupDeps {
  return { env: {}, now: () => FIXED_NOW, backupSqlite: backupSqliteFile, ...overrides };
}

function flags(target: string): string[] {
  return ['--target', target, '--sqlite', sqlitePath, '--memory-dir', memoryDir, '--persona-dir', personaDir];
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'aman-backup-'));
  sqlitePath = path.join(scratch, 'live', 'db.sqlite');
  memoryDir = path.join(scratch, 'live', 'memory');
  personaDir = path.join(scratch, 'live', 'persona');
  await mkdir(path.join(memoryDir, 'daily'), { recursive: true });
  await mkdir(personaDir, { recursive: true });
  await writeFile(path.join(memoryDir, 'MEMORY.md'), 'likes tea\n');
  await writeFile(path.join(memoryDir, 'daily', '2026-10-09.md'), 'went hiking\n');
  await writeFile(path.join(personaDir, 'notes.md'), 'persona notes\n');
  const db = new Database(sqlitePath);
  db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('alpha'), ('beta');");
  db.close();
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('backup', () => {
  it('writes a restorable database, both directories and a checksum manifest', async () => {
    const target = path.join(scratch, 'out');
    const io = fakeIo();
    expect(await createBackup(deps())({ args: flags(target), io })).toBe(0);

    const result = ResultSchema.parse(JSON.parse(io.out.join('')));
    expect(result).toMatchObject({ target, manifest: 'manifest.json', files: 4 });

    const copy = new Database(path.join(target, 'db.sqlite'), { readonly: true });
    expect(copy.prepare('SELECT v FROM t ORDER BY id').all()).toEqual([{ v: 'alpha' }, { v: 'beta' }]);
    copy.close();
    expect(await readFile(path.join(target, 'memory', 'daily', '2026-10-09.md'), 'utf8')).toBe('went hiking\n');
    expect(await readFile(path.join(target, 'persona-knowledge', 'notes.md'), 'utf8')).toBe('persona notes\n');

    const manifest = ManifestSchema.parse(JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8')));
    expect(manifest.created_at).toBe(FIXED_NOW.toISOString());
    expect(manifest.files.map(file => file.path)).toEqual([
      'db.sqlite',
      'memory/MEMORY.md',
      'memory/daily/2026-10-09.md',
      'persona-knowledge/notes.md',
    ]);
    for (const file of manifest.files) {
      const content = await readFile(path.join(target, file.path));
      expect(file.sha256).toBe(createHash('sha256').update(content).digest('hex'));
      expect(file.bytes).toBe(content.length);
    }
  });

  it('keeps the backup private to its owner', async () => {
    const target = path.join(scratch, 'out');
    await createBackup(deps())({ args: flags(target), io: fakeIo() });
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(target, 'db.sqlite'))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(target, 'manifest.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(target, 'memory', 'MEMORY.md'))).mode & 0o777).toBe(0o600);
  });

  it('reads default paths from the environment', async () => {
    const target = path.join(scratch, 'out');
    const env = { SQLITE_PATH: sqlitePath, MEMORY_MARKDOWN_DIR: memoryDir, PERSONA_KNOWLEDGE_DIR: personaDir };
    expect(await createBackup(deps({ env }))({ args: ['--target', target], io: fakeIo() })).toBe(0);
    expect(await readdir(target)).toContain('db.sqlite');
  });

  it('captures rows still in the write-ahead log of a live database', async () => {
    const live = new Database(sqlitePath);
    live.pragma('journal_mode = WAL');
    live.pragma('wal_autocheckpoint = 0');
    live.exec("INSERT INTO t (v) VALUES ('gamma')");
    const target = path.join(scratch, 'out');
    await createBackup(deps())({ args: flags(target), io: fakeIo() });
    live.close();
    const copy = new Database(path.join(target, 'db.sqlite'), { readonly: true });
    expect(copy.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 3 });
    copy.close();
  });

  it('skips symlinks instead of following them out of the directory', async () => {
    const outside = path.join(scratch, 'outside.txt');
    await writeFile(outside, 'private');
    await symlink(outside, path.join(memoryDir, 'link.md'));
    const target = path.join(scratch, 'out');
    const io = fakeIo();
    expect(await createBackup(deps())({ args: flags(target), io })).toBe(0);
    expect(await readdir(path.join(target, 'memory'))).not.toContain('link.md');
    expect(io.err.join('')).toContain('link.md');
  });

  it('backs a missing data directory up as empty and says so', async () => {
    await rm(personaDir, { recursive: true });
    const target = path.join(scratch, 'out');
    const io = fakeIo();
    expect(await createBackup(deps())({ args: flags(target), io })).toBe(0);
    expect(await readdir(path.join(target, 'persona-knowledge'))).toEqual([]);
    expect(io.err.join('')).toContain('persona-knowledge directory does not exist');
  });

  it('refuses to overwrite a non-empty target and leaves it untouched', async () => {
    const target = path.join(scratch, 'out');
    await mkdir(target);
    await writeFile(path.join(target, 'keep.txt'), 'old backup');
    await expect(createBackup(deps())({ args: flags(target), io: fakeIo() })).rejects.toBeInstanceOf(UsageError);
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('old backup');
  });

  it('accepts an existing empty target directory', async () => {
    const target = path.join(scratch, 'out');
    await mkdir(target);
    expect(await createBackup(deps())({ args: flags(target), io: fakeIo() })).toBe(0);
  });

  it('rejects a target inside a directory being backed up', async () => {
    await expect(
      createBackup(deps())({ args: flags(path.join(memoryDir, 'nested-backup')), io: fakeIo() }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('requires a target and every source path', async () => {
    const run = createBackup(deps());
    await expect(run({ args: ['--sqlite', sqlitePath], io: fakeIo() })).rejects.toThrow('--target');
    await expect(run({ args: ['--target', path.join(scratch, 'out')], io: fakeIo() })).rejects.toThrow('--sqlite');
    await expect(run({ args: ['--bogus'], io: fakeIo() })).rejects.toBeInstanceOf(UsageError);
  });

  it('removes everything it wrote when a step fails', async () => {
    const target = path.join(scratch, 'fresh', 'out');
    const failing = deps({
      backupSqlite: async ({ dest }) => {
        await writeFile(dest, 'partial');
        throw new Error('disk full');
      },
    });
    await expect(createBackup(failing)({ args: flags(target), io: fakeIo() })).rejects.toThrow('disk full');
    await expect(stat(path.join(scratch, 'fresh'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('empties, but keeps, a pre-existing target when a step fails', async () => {
    const target = path.join(scratch, 'out');
    await mkdir(target);
    const failing = deps({
      backupSqlite: async ({ dest }) => {
        await writeFile(dest, 'partial');
        throw new Error('disk full');
      },
    });
    await expect(createBackup(failing)({ args: flags(target), io: fakeIo() })).rejects.toThrow('disk full');
    expect(await readdir(target)).toEqual([]);
  });
});

describe('backupSqliteFile', () => {
  it('fails for a missing source database', async () => {
    await expect(
      backupSqliteFile({ source: path.join(scratch, 'none.sqlite'), dest: path.join(scratch, 'copy.sqlite') }),
    ).rejects.toThrow();
  });

  it('rejects a copy that fails its integrity check', async () => {
    const source = path.join(scratch, 'damaged.sqlite');
    const db = new Database(source);
    db.exec("CREATE TABLE t (v TEXT); CREATE INDEX i ON t (v); INSERT INTO t VALUES ('a'), ('b')");
    // Dropping the index entry from the schema leaves its pages orphaned, which integrity_check reports.
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.exec("DELETE FROM sqlite_master WHERE type = 'index' AND name = 'i'");
    db.close();
    await expect(backupSqliteFile({ source, dest: path.join(scratch, 'copy.sqlite') })).rejects.toThrow(
      'integrity check',
    );
  });

  it('produces a copy that passes the integrity check', async () => {
    const source = path.join(scratch, 'live', 'db.sqlite');
    const dest = path.join(scratch, 'copy.sqlite');
    await backupSqliteFile({ source, dest });
    const copy = new Database(dest, { readonly: true });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.close();
  });
});

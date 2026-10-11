import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDb } from '../../../../src/db/sqlite/client';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sqlite-perm-test-'));
}

describe('createSqliteDb file permissions', () => {
  it('creates the data directory with mode 0700', () => {
    const dir = makeTempDir();
    try {
      const nested = join(dir, 'nested', 'deep');
      const db = createSqliteDb(join(nested, 'db.sqlite'));
      void db.destroy();
      expect(statSync(nested).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives a new database file mode 0600', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'db.sqlite');
      const db = createSqliteDb(dbPath);
      await db.destroy();
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tightens an existing database file from 0640 to 0600', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'db.sqlite');
      const first = createSqliteDb(dbPath);
      await first.destroy();
      chmodSync(dbPath, 0o640);
      const second = createSqliteDb(dbPath);
      await second.destroy();
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tightens -wal and -shm files to 0600', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'db.sqlite');
      const db = createSqliteDb(dbPath);
      await db.destroy();
      // Simulate WAL files from a previous run with loose permissions
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      writeFileSync(walPath, 'x');
      writeFileSync(shmPath, 'x');
      chmodSync(walPath, 0o644);
      chmodSync(shmPath, 0o644);
      const reopened = createSqliteDb(dbPath);
      await reopened.destroy();
      expect(statSync(walPath).mode & 0o777).toBe(0o600);
      expect(statSync(shmPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tightens an existing data directory from 0755 to 0700', async () => {
    const dir = makeTempDir();
    try {
      const nested = join(dir, 'nested');
      mkdirSync(nested, { recursive: true });
      chmodSync(nested, 0o755);
      const db = createSqliteDb(join(nested, 'db.sqlite'));
      await db.destroy();
      expect(statSync(nested).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not follow symlinks when tightening', async () => {
    const dir = makeTempDir();
    try {
      const realDir = join(dir, 'real');
      mkdirSync(realDir, { recursive: true });
      chmodSync(realDir, 0o755);
      const linkDir = join(dir, 'link');
      symlinkSync(realDir, linkDir);
      const db = createSqliteDb(join(linkDir, 'db.sqlite'));
      await db.destroy();
      // The symlink itself is untouched; the real dir keeps its mode
      // (lstat on the link does not follow it)
      expect(statSync(realDir).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens :memory: without touching the filesystem', () => {
    const db = createSqliteDb(':memory:');
    expect(() => db.destroy()).not.toThrow();
  });
});

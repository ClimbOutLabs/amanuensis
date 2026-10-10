import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDb } from '../../../src/db/sqlite/client';

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

  it('does not change the mode of an existing database file', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'db.sqlite');
      const first = createSqliteDb(dbPath);
      await first.destroy();
      chmodSync(dbPath, 0o640);
      const second = createSqliteDb(dbPath);
      await second.destroy();
      expect(statSync(dbPath).mode & 0o777).toBe(0o640);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

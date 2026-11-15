import { checkDatabase } from '../../../../../src/cli/doctor/checks/database';
import { DatabaseLockedError } from '../../../../../src/secrets/sqliteAccess';
import { fakeDeps } from '../fakeDeps';

const env = { SQLITE_PATH: '/data/db/db.sqlite' };

function sqliteError(code: string): Error {
  return Object.assign(new Error(`${code} at /data/db/db.sqlite`), { code });
}

describe('database check', () => {
  it('is ok when a write transaction opens, probing the configured file', async () => {
    const probe = jest.fn().mockResolvedValue(undefined);
    const check = await checkDatabase({ deps: fakeDeps({ env, probeDatabaseWritable: probe }), timeoutMs: 4000 });
    expect(check).toMatchObject({ id: 'database', state: 'ok' });
    expect(probe).toHaveBeenCalledWith({ path: '/data/db/db.sqlite', key: undefined, timeoutMs: 4000 });
  });

  it('fails with a fix and a plain reason for each known error', async () => {
    const cases: Array<[string, string]> = [
      ['SQLITE_BUSY', 'locked'],
      ['SQLITE_READONLY', 'read-only'],
      ['SQLITE_CANTOPEN', 'does not exist'],
    ];
    for (const [code, words] of cases) {
      const check = await checkDatabase({
        deps: fakeDeps({
          env,
          probeDatabaseWritable: () => {
            throw sqliteError(code);
          },
        }),
        timeoutMs: 1,
      });
      expect(check.state).toBe('fail');
      expect(check.detail).toContain(words);
      expect(check.detail).not.toContain('/data');
      expect(check.fix).not.toBe('');
    }
  });

  it('opens an encrypted database with its key', async () => {
    const key = Buffer.alloc(32, 7);
    const probe = jest.fn();
    const check = await checkDatabase({
      deps: fakeDeps({ env, databaseKey: () => Promise.resolve(key), probeDatabaseWritable: probe }),
      timeoutMs: 1,
    });
    expect(check.state).toBe('ok');
    expect(probe).toHaveBeenCalledWith({ path: '/data/db/db.sqlite', key, timeoutMs: 1 });
  });

  it('says why an encrypted database cannot be opened here, without probing', async () => {
    const probe = jest.fn();
    const check = await checkDatabase({
      deps: fakeDeps({
        env,
        databaseKey: () => Promise.reject(new DatabaseLockedError("This computer's key is not available (missing)")),
        probeDatabaseWritable: probe,
      }),
      timeoutMs: 1,
    });
    expect(check.state).toBe('fail');
    expect(check.detail).toBe(
      "The database is encrypted and cannot be opened here: This computer's key is not available (missing).",
    );
    expect(check.fix).toContain('install.sh');
    expect(probe).not.toHaveBeenCalled();
  });

  it('fails when SQLITE_PATH is missing, without probing', async () => {
    const probe = jest.fn();
    const check = await checkDatabase({ deps: fakeDeps({ probeDatabaseWritable: probe }), timeoutMs: 1 });
    expect(check.state).toBe('fail');
    expect(check.fix).not.toBe('');
    expect(probe).not.toHaveBeenCalled();
  });

  it('is off when the instance runs on Postgres', async () => {
    const probe = jest.fn();
    const check = await checkDatabase({
      deps: fakeDeps({ env: { ...env, STANDALONE: 'false' }, probeDatabaseWritable: probe }),
      timeoutMs: 1,
    });
    expect(check.state).toBe('off');
    expect(probe).not.toHaveBeenCalled();
  });
});

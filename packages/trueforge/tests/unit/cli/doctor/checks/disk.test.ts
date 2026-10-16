import { checkDisk } from '../../../../../src/cli/doctor/checks/disk';
import { fakeDeps } from '../fakeDeps';

const GIB = 1024 ** 3;
const env = { SQLITE_PATH: '/data/db/db.sqlite' };

describe('disk check', () => {
  it('measures the directory that holds the database', async () => {
    const freeBytes = jest.fn().mockResolvedValue(50 * GIB);
    const check = await checkDisk({ deps: fakeDeps({ env, freeBytes }) });
    expect(check).toMatchObject({ id: 'disk', state: 'ok' });
    expect(check.detail).toContain('50.0 GB');
    expect(freeBytes).toHaveBeenCalledWith('/data/db');
  });

  it('is ok at exactly 10 GB, warns just under, fails under 2 GB', async () => {
    const at = (bytes: number) => checkDisk({ deps: fakeDeps({ env, freeBytes: () => Promise.resolve(bytes) }) });
    expect((await at(10 * GIB)).state).toBe('ok');
    const warn = await at(10 * GIB - 1);
    expect(warn.state).toBe('warn');
    expect(warn.fix).not.toBe('');
    expect((await at(2 * GIB)).state).toBe('warn');
    const fail = await at(2 * GIB - 1);
    expect(fail.state).toBe('fail');
    expect(fail.fix).not.toBe('');
  });

  it('warns with a fix when free space cannot be read', async () => {
    const check = await checkDisk({
      deps: fakeDeps({ env, freeBytes: () => Promise.reject(new Error('boom')) }),
    });
    expect(check.state).toBe('warn');
    expect(check.fix).not.toBe('');
  });

  it('is off when no data directory is configured or Postgres is used', async () => {
    expect((await checkDisk({ deps: fakeDeps() })).state).toBe('off');
    expect((await checkDisk({ deps: fakeDeps({ env: { ...env, STANDALONE: 'false' } }) })).state).toBe('off');
  });
});

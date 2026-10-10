import { z } from 'zod';
import { createDoctor } from '../../../../src/cli/doctor';
import { CheckSchema } from '../../../../src/cli/doctor/schemas';
import { UsageError } from '../../../../src/cli/io';
import { fakeIo } from '../fakeIo';
import { fakeDeps, networkError, response } from './fakeDeps';

const ISSUER = 'http://127.0.0.1:5556/dex';
const healthyEnv = { OIDC_ISSUER_URL: ISSUER, SQLITE_PATH: '/data/db/db.sqlite' };
const healthyGet = ({ url }: { url: string }) =>
  Promise.resolve(response(url.endsWith('/healthz') ? {} : { json: { issuer: ISSUER } }));

async function run(args: string[], deps = fakeDeps({ env: healthyEnv, get: healthyGet })) {
  const io = fakeIo();
  const code = await createDoctor(deps)({ args, io });
  return { code, io };
}

describe('amanuensis doctor', () => {
  it('prints a JSON array of checks and exits 0 when nothing fails', async () => {
    const { code, io } = await run([]);
    expect(code).toBe(0);
    const checks = z.array(CheckSchema).parse(JSON.parse(io.out.join('')));
    expect(checks.map(c => [c.id, c.state])).toEqual([
      ['service', 'ok'],
      ['login', 'ok'],
      ['database', 'ok'],
      ['disk', 'ok'],
      ['clock', 'ok'],
      ['run_code', 'off'],
      ['attachments', 'off'],
    ]);
  });

  it('exits 1 when any check fails and keeps the others', async () => {
    const deps = fakeDeps({ env: healthyEnv, get: () => Promise.reject(networkError('ECONNREFUSED')) });
    const { code, io } = await run(['--json'], deps);
    expect(code).toBe(1);
    const checks = z.array(CheckSchema).parse(JSON.parse(io.out.join('')));
    expect(checks.filter(c => c.state === 'fail').map(c => c.id)).toEqual(['service', 'login']);
    expect(checks.find(c => c.id === 'database')?.state).toBe('ok');
  });

  it('exits 0 for warnings only', async () => {
    const deps = fakeDeps({ env: healthyEnv, get: healthyGet, freeBytes: () => Promise.resolve(5 * 1024 ** 3) });
    const { code, io } = await run([], deps);
    expect(code).toBe(0);
    expect(
      z
        .array(CheckSchema)
        .parse(JSON.parse(io.out.join('')))
        .some(c => c.state === 'warn'),
    ).toBe(true);
  });

  it('filters to one check with --only', async () => {
    const { io } = await run(['--only', 'database']);
    expect(z.array(CheckSchema).parse(JSON.parse(io.out.join('')))).toHaveLength(1);
  });

  it('uses a longer probe timeout with --deep', async () => {
    const get = jest.fn(healthyGet);
    await run(['--deep'], fakeDeps({ env: healthyEnv, get }));
    expect(get.mock.calls.every(([options]) => (options as { timeoutMs: number }).timeoutMs === 30_000)).toBe(true);
    get.mockClear();
    await run([], fakeDeps({ env: healthyEnv, get }));
    expect(get.mock.calls.every(([options]) => (options as { timeoutMs: number }).timeoutMs === 5_000)).toBe(true);
  });

  it('prints one tab-separated line per check with --text', async () => {
    const deps = fakeDeps({ env: healthyEnv, get: () => Promise.reject(networkError('ECONNREFUSED')) });
    const { io } = await run(['--text'], deps);
    const lines = io.out.join('').trimEnd().split('\n');
    expect(lines).toHaveLength(7);
    const [id, state, detail, fix] = lines[0]?.split('\t') ?? [];
    expect([id, state]).toEqual(['service', 'fail']);
    expect(detail).not.toBe('');
    expect(fix).not.toBe('');
  });

  it('raises usage errors for unknown flags, unknown checks and conflicting formats', async () => {
    await expect(run(['--bogus'])).rejects.toBeInstanceOf(UsageError);
    await expect(run(['--only', 'nope'])).rejects.toBeInstanceOf(UsageError);
    await expect(run(['--json', '--text'])).rejects.toBeInstanceOf(UsageError);
    await expect(run(['extra'])).rejects.toBeInstanceOf(UsageError);
  });

  it('never leaks credentials from the environment', async () => {
    const env = {
      ...healthyEnv,
      OIDC_ISSUER_URL: 'https://u:SENTINEL@login.example.com/dex?x=SENTINEL',
      OIDC_CLIENT_SECRET: 'SENTINEL',
    };
    const { io } = await run([], fakeDeps({ env, get: () => Promise.reject(networkError('ENOTFOUND')) }));
    expect(io.out.join('')).not.toContain('SENTINEL');
  });
});

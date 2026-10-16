import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileRunner } from '../../../../../src/core/sandbox/slots/git/hostCommand';

describe('execFileRunner limits', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'host-limits-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (command: string, limits: { fileBytes: number } | undefined) =>
    execFileRunner.run({
      argv: ['/bin/sh', '-c', command],
      env: { PATH: '/usr/bin:/bin' },
      cwd: dir,
      timeoutMs: 20_000,
      signal: undefined,
      maxStdoutBytes: 1024 * 1024,
      limits: limits === undefined ? undefined : { addressSpaceBytes: 2 * 1024 ** 3, cpuSeconds: 20, ...limits },
    });

  test('a program cannot write a file larger than the limit', async () => {
    const result = await run('head -c 3000000 /dev/zero > big', { fileBytes: 100_000 });
    expect(result.exitCode).not.toBe(0);
    expect((await stat(join(dir, 'big'))).size).toBeLessThanOrEqual(100_000);
  });

  test('without limits the same program is unrestricted, and a small write passes either way', async () => {
    expect((await run('head -c 3000000 /dev/zero > big', undefined)).exitCode).toBe(0);
    expect((await run('echo ok > small', { fileBytes: 100_000 })).exitCode).toBe(0);
  });
});

/**
 * Live-daemon integration tests for the gVisor driver. Unit tests own the
 * logic; these validate that real code executes through the runsc runtime
 * with stdout capture and timeout enforcement.
 *
 * Every test gates on `docker info` AND runsc availability first, returning
 * early when either is unreachable, so the suite is green on machines
 * without Docker or gVisor.
 *
 * To run locally:
 *   1. Install Docker and the gVisor runsc runtime
 *   2. Configure Docker to use runsc: add {"runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}} to daemon.json
 *   3. Set SANDBOX_TEST_IMAGE to an image containing python3, node, and bash
 *   4. Run: pnpm test -- GVisorDriver.integration
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GVisorDriver } from '../../../../src/core/sandbox/driver/GVisorDriver';
import type { DriverRunParams } from '../../../../src/core/sandbox/driver/IsolationDriver';

const execFileAsync = promisify(execFile);

/**
 * Image for the full-run tests. Must contain python3, node, and bash.
 * Override for local iterations.
 */
const TEST_IMAGE = process.env['SANDBOX_TEST_IMAGE'] ?? 'python:3.12-slim';

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function runscAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', ['info', '--format', '{{json .Runtimes}}'], { timeout: 10000 });
    return stdout.includes('runsc');
  } catch {
    return false;
  }
}

async function imagePresent(image: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', image], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function baseParams(overrides: Partial<DriverRunParams> & { runRoot: string }): DriverRunParams {
  const { runRoot, ...rest } = overrides;
  return {
    language: 'python',
    code: 'print("hello")',
    filesIn: [],
    ingressDir: join(runRoot, 'ingress'),
    scratchDir: join(runRoot, 'scratch'),
    egressDir: join(runRoot, 'egress'),
    timeoutMs: 30000,
    memoryMb: 512,
    diskMb: 100,
    runId: `gvisor-itest-${Date.now()}`,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/scratch' },
    signal: undefined,
    harvestGraceMs: 0,
    ...rest,
  };
}

describe('GVisorDriver integration (live daemon + runsc)', () => {
  test('python code executes through runsc with stdout capture', async () => {
    if (!(await dockerAvailable())) return;
    if (!(await runscAvailable())) return;
    if (!(await imagePresent(TEST_IMAGE))) return;

    const runRoot = await mkdtemp(join(tmpdir(), 'gvisor-itest-'));
    try {
      const ingressDir = join(runRoot, 'ingress');
      const scratchDir = join(runRoot, 'scratch');
      const egressDir = join(runRoot, 'egress');
      await mkdir(ingressDir, { recursive: true });
      await mkdir(scratchDir, { recursive: true });
      await mkdir(egressDir, { recursive: true });
      await writeFile(join(ingressDir, '__runcode_main.py'), 'print("gvisor-hello")');

      const driver = new GVisorDriver(
        {
          image: TEST_IMAGE,
          cosignPublicKeyPath: '/nonexistent/cosign.pub',
          dockerBinary: undefined,
          cosignBinary: undefined,
          commandTimeoutMs: undefined,
          createTimeoutMs: undefined,
          runscVersion: undefined,
        },
        undefined,
      );

      const result = await driver.run(baseParams({ runRoot, code: 'print("gvisor-hello")' }));
      expect(result.terminatedBy).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('gvisor-hello');
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  test('bash code executes through runsc', async () => {
    if (!(await dockerAvailable())) return;
    if (!(await runscAvailable())) return;
    if (!(await imagePresent(TEST_IMAGE))) return;

    const runRoot = await mkdtemp(join(tmpdir(), 'gvisor-itest-'));
    try {
      const ingressDir = join(runRoot, 'ingress');
      const scratchDir = join(runRoot, 'scratch');
      const egressDir = join(runRoot, 'egress');
      await mkdir(ingressDir, { recursive: true });
      await mkdir(scratchDir, { recursive: true });
      await mkdir(egressDir, { recursive: true });
      await writeFile(join(ingressDir, '__runcode_main.sh'), 'echo "bash-works"');

      const driver = new GVisorDriver(
        {
          image: TEST_IMAGE,
          cosignPublicKeyPath: '/nonexistent/cosign.pub',
          dockerBinary: undefined,
          cosignBinary: undefined,
          commandTimeoutMs: undefined,
          createTimeoutMs: undefined,
          runscVersion: undefined,
        },
        undefined,
      );

      const result = await driver.run(
        baseParams({ runRoot, language: 'bash', code: 'echo "bash-works"' }),
      );
      expect(result.terminatedBy).toBe('completed');
      expect(result.stdout).toContain('bash-works');
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  test('timeout is enforced for hanging code', async () => {
    if (!(await dockerAvailable())) return;
    if (!(await runscAvailable())) return;
    if (!(await imagePresent(TEST_IMAGE))) return;

    const runRoot = await mkdtemp(join(tmpdir(), 'gvisor-itest-'));
    try {
      const ingressDir = join(runRoot, 'ingress');
      const scratchDir = join(runRoot, 'scratch');
      const egressDir = join(runRoot, 'egress');
      await mkdir(ingressDir, { recursive: true });
      await mkdir(scratchDir, { recursive: true });
      await mkdir(egressDir, { recursive: true });
      await writeFile(join(ingressDir, '__runcode_main.py'), 'import time; time.sleep(60)');

      const driver = new GVisorDriver(
        {
          image: TEST_IMAGE,
          cosignPublicKeyPath: '/nonexistent/cosign.pub',
          dockerBinary: undefined,
          cosignBinary: undefined,
          commandTimeoutMs: undefined,
          createTimeoutMs: undefined,
          runscVersion: undefined,
        },
        undefined,
      );

      const result = await driver.run(
        baseParams({ runRoot, code: 'import time; time.sleep(60)', timeoutMs: 5000 }),
      );
      expect(result.terminatedBy).toBe('timeout');
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  });
});

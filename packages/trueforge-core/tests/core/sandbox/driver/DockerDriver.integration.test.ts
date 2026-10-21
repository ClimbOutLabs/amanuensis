/**
 * Live-daemon integration tests for the Docker driver. Unit tests own the
 * logic; these validate the hardened create flags against a real daemon.
 * Every test gates on `docker info` first and returns early when the daemon
 * is unreachable, so the suite is green on machines without Docker.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DOCKER_SOCKET_PATH, DockerDriver } from '../../../../src/core/sandbox/driver/DockerDriver';
import type { DriverRunParams } from '../../../../src/core/sandbox/driver/IsolationDriver';
import { resolveSandboxIdentity, SANDBOX_RUN_ENV, stageRunDirs } from '../../../../src/core/sandbox/driver/RunStaging';
import { makeSilentLogger } from '../../harnessMocks';

const execFileAsync = promisify(execFile);

/**
 * Image for the full-run test. Must contain python3. The pinned sandbox
 * image once `scripts/build-sandbox-image.sh` has produced it; override for
 * local iterations.
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

async function imagePresent(image: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', image], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

async function containersWithLabel(labelValue: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'docker',
    ['ps', '-a', '--filter', `label=tf.sandbox.run=${labelValue}`, '--format', '{{.ID}}'],
    { timeout: 10000 },
  );
  return stdout.trim();
}

describe('DockerDriver integration (live daemon)', () => {
  test('ensureReady reports image_missing (not daemon_unavailable) when the daemon is up but the image is absent', async () => {
    if (!(await dockerAvailable())) {
      return;
    }
    const stateDir = await mkdtemp(join(tmpdir(), 'sandbox-itest-state-'));
    try {
      const driver = new DockerDriver(
        {
          image: 'ghcr.io/climboutlabs/amanuensis-sandbox:0.0.0-integration-missing@sha256:' + '0'.repeat(64),
          cosignPublicKeyPath: '/nonexistent/cosign.pub',
          stateDir,
          dataDir: tmpdir(),
          dockerBinary: undefined,
          cosignBinary: undefined,
          dockerSocketPath: DOCKER_SOCKET_PATH,
          commandTimeoutMs: undefined,
          createTimeoutMs: undefined,
          logger: makeSilentLogger(),
        },
        undefined,
      );
      const readiness = await driver.ensureReady();
      expect(readiness.ready).toBe(false);
      if (!readiness.ready) {
        // An image absent locally is healable; RunCodeService provisions it before surfacing image_unavailable.
        expect(readiness.error_code).toBe('image_missing');
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('a full run executes with the hardened flags and the container is removed afterwards', async () => {
    if (!(await dockerAvailable())) {
      return;
    }
    if (!(await imagePresent(TEST_IMAGE))) {
      return;
    }
    const runRoot = await mkdtemp(join(tmpdir(), 'sandbox-itest-'));
    try {
      const code = 'print("hello from sandbox")';
      const sandboxIdentity = resolveSandboxIdentity();
      const { ingressDir, scratchDir, egressDir } = await stageRunDirs({
        runRoot,
        language: 'python',
        code,
        files: [],
        identity: sandboxIdentity,
      });

      const runId = `itest-${String(Date.now())}`;
      const driver = new DockerDriver(
        {
          image: TEST_IMAGE,
          cosignPublicKeyPath: '/nonexistent/cosign.pub',
          stateDir: join(runRoot, 'state'),
          dockerBinary: undefined,
          cosignBinary: undefined,
          dockerSocketPath: DOCKER_SOCKET_PATH,
          dataDir: tmpdir(),
          commandTimeoutMs: undefined,
          createTimeoutMs: undefined,
          logger: makeSilentLogger(),
        },
        undefined,
      );
      const params: DriverRunParams = {
        language: 'python',
        code,
        filesIn: [],
        ingressDir,
        scratchDir,
        egressDir,
        timeoutMs: 60000,
        memoryMb: 512,
        diskMb: 256,
        runId,
        env: SANDBOX_RUN_ENV,
        sandboxIdentity,
        signal: undefined,
        harvestGraceMs: 2000,
        packageMirrorToken: undefined,
      };
      const result = await driver.run(params);
      expect(result.terminatedBy).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello from sandbox');
      // No --rm: the driver removes the container explicitly after the
      // post-mortem OOM inspect. Nothing labeled may linger.
      expect(await containersWithLabel(runId)).toBe('');
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  });
});

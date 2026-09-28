/**
 * Unit tests for the gVisor isolation driver. No daemon: every docker/cosign
 * interaction is scripted through a fake DockerCommandRunner.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GVisorDriver,
  type GVisorDriverOptions,
} from '../../../../src/core/sandbox/driver/GVisorDriver';
import type {
  DockerCommandResult,
  DockerCommandRunner,
} from '../../../../src/core/sandbox/driver/DockerDriver';
import type { DriverRunParams } from '../../../../src/core/sandbox/driver/IsolationDriver';

const DIGEST = 'sha256:' + 'a'.repeat(64);
const IMAGE = `ghcr.io/climboutlabs/amanuensis-sandbox:0.1.0@${DIGEST}`;
const KEY_PATH = '/etc/amanuensis/cosign.pub';

interface RecordedCall {
  binary: string;
  args: string[];
}

const okResult: DockerCommandResult = { stdout: '', stderr: '', exitCode: 0, timedOut: false };

/** Scripted fake: records docker calls, scripts create/start outcomes. */
class FakeRunner implements DockerCommandRunner {
  calls: RecordedCall[] = [];
  /** `runsc --version` stdout; undefined simulates a missing runsc binary. */
  runscVersionStdout: string | undefined = 'runsc version release-20260727.0\nspec: 1.2.1\n';

  async run(binary: string, args: string[]): Promise<DockerCommandResult> {
    this.calls.push({ binary, args });
    if (binary === 'runsc') {
      if (this.runscVersionStdout === undefined) {
        return { stdout: '', stderr: 'spawn runsc ENOENT', exitCode: -1, timedOut: false };
      }
      return { ...okResult, stdout: this.runscVersionStdout };
    }
    if (args[0] === 'create') {
      return { stdout: 'abc123container\n', stderr: '', exitCode: 0, timedOut: false };
    }
    if (args[0] === 'inspect') {
      return { stdout: '[{"State":{"OOMKilled":false}}]', stderr: '', exitCode: 0, timedOut: false };
    }
    return okResult;
  }

  async pull(): Promise<void> {
    return undefined;
  }

  async startAttach(input: {
    containerId: string;
    signal: AbortSignal | undefined;
    onStdout: (chunk: Buffer) => void;
    onStderr: (chunk: Buffer) => void;
  }): Promise<number | undefined> {
    input.onStdout(Buffer.from('hello'));
    return 0;
  }
}

function driverOptions(): GVisorDriverOptions {
  return {
    image: IMAGE,
    cosignPublicKeyPath: KEY_PATH,
    dockerBinary: undefined,
    cosignBinary: undefined,
    commandTimeoutMs: undefined,
    createTimeoutMs: undefined,
    runscVersion: undefined,
  };
}

async function makeRunParams(): Promise<DriverRunParams> {
  const root = await mkdtemp(join(tmpdir(), 'gvisor-test-'));
  return {
    language: 'python',
    code: 'print("hi")',
    filesIn: [],
    ingressDir: join(root, 'ingress'),
    scratchDir: join(root, 'scratch'),
    egressDir: join(root, 'egress'),
    timeoutMs: 10000,
    memoryMb: 256,
    diskMb: 100,
    runId: 'test-run-1',
    env: { PATH: '/usr/bin', HOME: '/scratch' },
    signal: undefined,
    harvestGraceMs: 1000,
  };
}

describe('GVisorDriver', () => {
  test('kind is gvisor', () => {
    const driver = new GVisorDriver(driverOptions(), new FakeRunner());
    expect(driver.kind).toBe('gvisor');
  });

  test('auditIdentity reports the image and the runsc runtime', () => {
    const driver = new GVisorDriver(driverOptions(), new FakeRunner());
    expect(driver.auditIdentity).toEqual({ image: IMAGE, runtime: 'runsc' });
  });

  test('ensureReady refuses when runsc is missing (fail-closed, no runc fallback)', async () => {
    const runner = new FakeRunner();
    runner.runscVersionStdout = undefined;
    const driver = new GVisorDriver({ ...driverOptions(), runscVersion: 'release-20260727.0' }, runner);
    const readiness = await driver.ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('daemon_unavailable');
      expect(readiness.error).toMatch(/runsc/);
    }
    // The probe refuses before any docker work: no container was created.
    expect(runner.calls.filter(call => call.binary === 'docker')).toHaveLength(0);
  });

  test('docker create includes --runtime runsc', async () => {
    const runner = new FakeRunner();
    const driver = new GVisorDriver(driverOptions(), runner);
    const params = await makeRunParams();

    try {
      await driver.run(params);
    } finally {
      await rm(params.ingressDir, { recursive: true, force: true }).catch(() => undefined);
    }

    const createCalls = runner.calls.filter((c) => c.args[0] === 'create');
    expect(createCalls.length).toBe(1);
    const args = createCalls[0]?.args ?? [];
    const runtimeIdx = args.indexOf('--runtime');
    expect(runtimeIdx).toBeGreaterThanOrEqual(0);
    expect(args[runtimeIdx + 1]).toBe('runsc');
  });

  test('docker create keeps hardened flags alongside --runtime', async () => {
    const runner = new FakeRunner();
    const driver = new GVisorDriver(driverOptions(), runner);
    const params = await makeRunParams();

    try {
      await driver.run(params);
    } finally {
      await rm(params.ingressDir, { recursive: true, force: true }).catch(() => undefined);
    }

    const createCalls = runner.calls.filter((c) => c.args[0] === 'create');
    const args = createCalls[0]?.args ?? [];
    // Hardened flags from the DockerDriver base must still be present
    expect(args).toContain('--read-only');
    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('--cap-drop=ALL');
  });
});

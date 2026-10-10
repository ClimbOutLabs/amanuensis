/**
 * Unit tests for the Docker isolation driver. No daemon: every docker/cosign
 * interaction is scripted through a fake DockerCommandRunner.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOCKER_UNAVAILABLE_MESSAGE,
  DockerDriver,
  ISOLATION_REFUSED_MESSAGE,
  checkContainerIsolation,
  detectDocker,
  resetDockerDetectionForTests,
  type DockerCommandResult,
  type DockerCommandRunner,
  type DockerDriverOptions,
} from '../../../../src/core/sandbox/driver/DockerDriver';
import {
  imageVerificationRecordPath,
  readImageVerificationRecord,
} from '../../../../src/core/sandbox/driver/ImageVerificationRecord';
import { ISOLATION_REFUSED_MARKER, type DriverRunParams } from '../../../../src/core/sandbox/driver/IsolationDriver';

const DIGEST = 'sha256:' + 'a'.repeat(64);
const IMAGE = `ghcr.io/climboutlabs/amanuensis-sandbox:0.1.0@${DIGEST}`;
const IMAGE_ID = 'sha256:' + '1'.repeat(64);
const KEY_PATH = '/etc/amanuensis/cosign.pub';

interface RecordedCall {
  binary: string;
  args: string[];
}

const okResult: DockerCommandResult = { stdout: '', stderr: '', exitCode: 0, timedOut: false };

/** Scripted fake: handlers decide each docker/cosign call's outcome. */
class FakeRunner implements DockerCommandRunner {
  calls: RecordedCall[] = [];
  killed: string[] = [];
  progressLines: string[] = [];
  runHandler: (binary: string, args: string[]) => DockerCommandResult | Promise<DockerCommandResult> = () => okResult;
  attachHandler: (input: {
    containerId: string;
    signal: AbortSignal | undefined;
    onStdout: (chunk: Buffer) => void;
    onStderr: (chunk: Buffer) => void;
  }) => Promise<number | undefined> = () => Promise.resolve(0);
  pullHandler: (input: {
    image: string;
    signal: AbortSignal | undefined;
    onProgress: (line: string) => void;
  }) => Promise<void> = () => Promise.resolve(undefined);

  async run(binary: string, args: string[]): Promise<DockerCommandResult> {
    this.calls.push({ binary, args });
    if (args[0] === 'kill' && typeof args[1] === 'string') {
      this.killed.push(args[1]);
    }
    return this.runHandler(binary, args);
  }

  async pull(input: {
    image: string;
    signal: AbortSignal | undefined;
    onProgress: (line: string) => void;
  }): Promise<void> {
    return this.pullHandler(input);
  }

  async startAttach(input: {
    containerId: string;
    signal: AbortSignal | undefined;
    onStdout: (chunk: Buffer) => void;
    onStderr: (chunk: Buffer) => void;
  }): Promise<number | undefined> {
    return this.attachHandler(input);
  }

  callsFor(firstArg: string): RecordedCall[] {
    return this.calls.filter(call => call.args[0] === firstArg);
  }
}

function driverOptions(): DockerDriverOptions {
  return {
    image: IMAGE,
    cosignPublicKeyPath: KEY_PATH,
    stateDir,
    dockerBinary: undefined,
    cosignBinary: undefined,
    dockerSocketPath: fakeSocketPath,
    commandTimeoutMs: undefined,
    createTimeoutMs: undefined,
  };
}

/**
 * Unit tests must not depend on the host's real Docker socket: detectDocker()
 * is memoized per path, so every test gets a fake socket file. Reset between
 * tests so each test's detection is independent.
 */
let fakeSocketPath: string | undefined;
/** Per-test driver state dir, so a verification record never leaks between tests. */
let stateDir = '';
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tf-docker-socket-'));
  fakeSocketPath = join(dir, 'docker.sock');
  await writeFile(fakeSocketPath, '');
});
beforeEach(async () => {
  resetDockerDetectionForTests();
  stateDir = await mkdtemp(join(tmpdir(), 'tf-docker-state-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function runParams(overrides: { signal?: AbortSignal | undefined } = {}): DriverRunParams {
  return {
    language: 'python',
    code: 'print("hi")',
    filesIn: [],
    ingressDir: '/data/runs/r1/ingress',
    scratchDir: '/data/runs/r1/scratch',
    egressDir: '/data/runs/r1/egress',
    timeoutMs: 60000,
    memoryMb: 2048,
    diskMb: 1024,
    runId: 'run-123',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/scratch' },
    signal: overrides.signal,
    harvestGraceMs: 2000,
  };
}

/** `docker image inspect` output for the pinned image as the daemon reports it. */
function inspectOutput({ digest, imageId }: { digest: string; imageId: string }): string {
  return JSON.stringify([{ Id: imageId, RepoDigests: [`ghcr.io/climboutlabs/amanuensis-sandbox@${digest}`] }]);
}

/** ensureReady happy path: info, inspect (pinned digest), cosign, create probe, ownership probe. */
function scriptReadyPath(runner: FakeRunner, digest = DIGEST): void {
  runner.runHandler = async (binary, args) => {
    if (binary === 'docker' && args[0] === 'info') {
      return okResult;
    }
    if (binary === 'docker' && args[0] === 'image') {
      return { ...okResult, stdout: inspectOutput({ digest, imageId: IMAGE_ID }) };
    }
    if (binary === 'cosign') {
      return okResult;
    }
    if (binary === 'docker' && args[0] === 'create') {
      return { ...okResult, stdout: 'probe-container-id\n' };
    }
    if (binary === 'docker' && args[0] === 'run') {
      // Simulate the daemon's bind-mount write as the sandbox uid: the probe
      // container touches /probe/write-test, which must appear on the host.
      const volume = args.find(arg => arg.endsWith(':/probe:rw'));
      const hostDir = volume?.split(':')[0];
      if (hostDir !== undefined) {
        await writeFile(join(hostDir, 'write-test'), 'probe');
      }
      return { ...okResult, stdout: 'PROBE_OK\n' };
    }
    if (binary === 'docker' && args[0] === 'rm') {
      return okResult;
    }
    throw new Error(`unexpected call: ${binary} ${args.join(' ')}`);
  };
}

/** A `docker inspect` entry carrying every mandatory isolation flag. */
function goodInspectEntry(): Record<string, unknown> {
  return {
    Config: { User: '65532:65532' },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true', 'seccomp=default'],
    },
  };
}

/**
 * Isolation-verification inspect: the driver's post-create `docker inspect
 * <id>` (2 args) gets a hardened container. The OOM `--format` inspect
 * (4 args) is left to the test's own handler.
 */
function scriptIsolationInspect(runner: FakeRunner): void {
  const prev = runner.runHandler;
  runner.runHandler = (binary, args) => {
    if (binary === 'docker' && args[0] === 'inspect' && args.length === 2) {
      return { ...okResult, stdout: JSON.stringify([goodInspectEntry()]) };
    }
    return prev(binary, args);
  };
}

describe('DockerDriver.create', () => {
  test('emits the exact hardened flag set from the plan', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, stdout: 'cid-1\n' };
      }
      return okResult;
    };
    scriptIsolationInspect(runner);
    const driver = new DockerDriver(driverOptions(), runner);
    const result = await driver.run(runParams());
    expect(result.terminatedBy).toBe('completed');

    const creates = runner.callsFor('create');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.args).toEqual([
      'create',
      '--network',
      'none',
      '--init',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--user',
      '65532:65532',
      '--cap-drop=ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--security-opt',
      'seccomp=default',
      '--pids-limit',
      '256',
      '--memory',
      '2048m',
      '--memory-swap',
      '2048m',
      '--oom-kill-disable',
      'false',
      '--cpus',
      '2',
      '--shm-size',
      '64m',
      '--log-driver',
      'local',
      '--log-opt',
      'max-size=1m',
      '--log-opt',
      'max-file=2',
      '--label',
      'tf.sandbox.run=run-123',
      '-v',
      '/data/runs/r1/ingress:/ingress:ro',
      '-v',
      '/data/runs/r1/scratch:/scratch:rw',
      '-v',
      '/data/runs/r1/egress:/egress:rw',
      '--workdir',
      '/scratch',
      '-e',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      '-e',
      'LANG=C.UTF-8',
      '-e',
      'HOME=/scratch',
      IMAGE,
      'python3',
      '/ingress/__runcode_main.py',
    ]);
  });

  test('node runs the staged .mjs program', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, stdout: 'cid-1\n' };
      }
      return okResult;
    };
    scriptIsolationInspect(runner);
    const driver = new DockerDriver(driverOptions(), runner);
    const params = runParams();
    await driver.run({ ...params, language: 'node' });
    const creates = runner.callsFor('create');
    expect(creates[0]?.args.slice(-2)).toEqual(['node', '/ingress/__runcode_main.mjs']);
  });

  test('create failure maps to internal with host paths scrubbed', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, exitCode: 1, stderr: 'mount /data/runs/r1/scratch failed: permission denied' };
      }
      return okResult;
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const result = await driver.run(runParams());
    expect(result.terminatedBy).toBe('internal');
    expect(result.internalError).toContain('<scratch>');
    expect(result.internalError).not.toContain('/data/runs/r1/scratch');
  });

  test('abort during the run kills the container and reports killed', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, stdout: 'cid-9\n' };
      }
      return okResult;
    };
    // The fake attach only resolves once the driver kills the container.
    let resolveAttach: ((code: number) => void) | undefined;
    runner.attachHandler = () =>
      new Promise<number>(resolve => {
        resolveAttach = resolve;
      });
    const originalRun: DockerCommandRunner['run'] = runner.run.bind(runner);
    runner.run = async (binary: string, args: string[]) => {
      const result = await originalRun(binary, args, { timeoutMs: 5000, signal: undefined });
      if (args[0] === 'kill') {
        resolveAttach?.(137);
      }
      return result;
    };
    scriptIsolationInspect(runner);
    const driver = new DockerDriver(driverOptions(), runner);
    const controller = new AbortController();
    const runPromise = driver.run(runParams({ signal: controller.signal }));
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    const result = await runPromise;
    expect(result.terminatedBy).toBe('killed');
    expect(runner.killed).toContain('cid-9');
  });

  test('output past the 4 MiB transport bound kills the run with the marker', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, stdout: 'cid-7\n' };
      }
      return okResult;
    };
    runner.attachHandler = input => {
      input.onStdout(Buffer.alloc(5 * 1024 * 1024, 'x'));
      return Promise.resolve(0);
    };
    scriptIsolationInspect(runner);
    const driver = new DockerDriver(driverOptions(), runner);
    const result = await driver.run(runParams());
    expect(result.terminatedBy).toBe('killed');
    expect(result.internalError?.startsWith('output_exceeded:')).toBe(true);
    expect(runner.killed).toContain('cid-7');
    expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  test('a non-zero program exit is completed with the verbatim code', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, stdout: 'cid-2\n' };
      }
      return okResult;
    };
    runner.attachHandler = input => {
      input.onStderr(Buffer.from('traceback\n'));
      return Promise.resolve(3);
    };
    scriptIsolationInspect(runner);
    const driver = new DockerDriver(driverOptions(), runner);
    const result = await driver.run(runParams());
    expect(result.terminatedBy).toBe('completed');
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('traceback\n');
  });

  test('exit 137 with OOMKilled set maps to oom', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, stdout: 'cid-oom\n' };
      }
      if (args[0] === 'inspect' && args.length === 2) {
        return { ...okResult, stdout: JSON.stringify([goodInspectEntry()]) };
      }
      if (args[0] === 'inspect') {
        return { ...okResult, stdout: 'true\n' };
      }
      return okResult;
    };
    runner.attachHandler = () => Promise.resolve(137);
    const driver = new DockerDriver(driverOptions(), runner);
    const result = await driver.run(runParams());
    expect(result.terminatedBy).toBe('oom');
    expect(result.exitCode).toBe(137);
    // Two inspects: the post-create isolation verification, then the
    // post-mortem OOMKilled check, both before the explicit remove (no --rm).
    const inspects = runner.callsFor('inspect');
    expect(inspects).toHaveLength(2);
    expect(inspects[0]?.args).toEqual(['inspect', 'cid-oom']);
    expect(inspects[1]?.args).toEqual(['inspect', '--format', '{{.State.OOMKilled}}', 'cid-oom']);
    const rms = runner.callsFor('rm');
    expect(rms.map(call => call.args[2])).toContain('cid-oom');
  });

  test('exit 137 without OOMKilled stays a completed program exit', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, stdout: 'cid-137\n' };
      }
      if (args[0] === 'inspect' && args.length === 2) {
        return { ...okResult, stdout: JSON.stringify([goodInspectEntry()]) };
      }
      if (args[0] === 'inspect') {
        return { ...okResult, stdout: 'false\n' };
      }
      return okResult;
    };
    runner.attachHandler = () => Promise.resolve(137);
    const driver = new DockerDriver(driverOptions(), runner);
    const result = await driver.run(runParams());
    expect(result.terminatedBy).toBe('completed');
    expect(result.exitCode).toBe(137);
  });

  test('a failed OOM inspect never breaks the run', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, stdout: 'cid-oom2\n' };
      }
      if (args[0] === 'inspect' && args.length === 2) {
        return { ...okResult, stdout: JSON.stringify([goodInspectEntry()]) };
      }
      if (args[0] === 'inspect') {
        return { ...okResult, exitCode: 1, stderr: 'no such container' };
      }
      return okResult;
    };
    runner.attachHandler = () => Promise.resolve(137);
    const driver = new DockerDriver(driverOptions(), runner);
    const result = await driver.run(runParams());
    expect(result.terminatedBy).toBe('completed');
    expect(result.exitCode).toBe(137);
  });
});

describe('DockerDriver.ensureReady', () => {
  test('happy path returns ready and removes the probe container', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner);
    const driver = new DockerDriver(driverOptions(), runner);
    await expect(driver.ensureReady()).resolves.toEqual({ ready: true });
    const rms = runner.callsFor('rm');
    expect(rms).toHaveLength(1);
    expect(rms[0]?.args).toContain('probe-container-id');
  });

  test('bind-mount ownership probe failure is daemon_unavailable', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner);
    const readyPath = runner.runHandler;
    runner.runHandler = async (binary, args) => {
      if (binary === 'docker' && args[0] === 'run') {
        return { ...okResult, exitCode: 1, stderr: 'touch: /probe/write-test: Permission denied' };
      }
      return readyPath(binary, args);
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const readiness = await driver.ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('daemon_unavailable');
      expect(readiness.error).toMatch(/ownership probe failed/);
      expect(readiness.error).toMatch(/virtiofs/);
    }
  });

  test('docker info failure is daemon_unavailable', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'info') {
        return { ...okResult, exitCode: 1, stderr: 'Cannot connect to the Docker daemon' };
      }
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const readiness = await driver.ensureReady();
    expect(readiness).toEqual({
      ready: false,
      error_code: 'daemon_unavailable',
      error:
        'Docker daemon not reachable (`docker info` failed). Is dockerd running, and is the service user in the docker group?',
    });
  });

  test('missing image is image_missing (E2: the explicit provisioning path, never an implicit pull)', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'info') {
        return okResult;
      }
      if (args[0] === 'image') {
        return { ...okResult, exitCode: 1, stderr: 'No such image' };
      }
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const readiness = await driver.ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('image_missing');
    }
    expect(runner.callsFor('pull')).toHaveLength(0);
  });

  test('image without RepoDigest is refused', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'info') {
        return okResult;
      }
      if (args[0] === 'image') {
        return { ...okResult, stdout: JSON.stringify([{ RepoDigests: [] }]) };
      }
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const readiness = await driver.ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('image_unavailable');
      expect(readiness.error).toContain('no RepoDigest');
    }
  });

  test('digest mismatch is refused', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner, 'sha256:' + 'b'.repeat(64));
    const driver = new DockerDriver(driverOptions(), runner);
    const readiness = await driver.ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('image_unavailable');
      expect(readiness.error).toContain('mismatch');
    }
  });

  test('unpinned image reference is refused before touching the daemon', async () => {
    const runner = new FakeRunner();
    const driver = new DockerDriver(
      { ...driverOptions(), image: 'ghcr.io/climboutlabs/amanuensis-sandbox:0.1.0' },
      runner,
    );
    const readiness = await driver.ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('image_unavailable');
      expect(readiness.error).toContain('not pinned');
    }
    expect(runner.calls).toHaveLength(0);
  });

  test('cosign failure is image_unavailable', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (binary, args) => {
      if (binary === 'docker' && args[0] === 'info') {
        return okResult;
      }
      if (binary === 'docker' && args[0] === 'image') {
        return { ...okResult, stdout: inspectOutput({ digest: DIGEST, imageId: IMAGE_ID }) };
      }
      if (binary === 'cosign') {
        return { ...okResult, exitCode: 1, stderr: 'no matching signatures' };
      }
      throw new Error(`unexpected call: ${binary} ${args.join(' ')}`);
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const readiness = await driver.ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('image_unavailable');
      expect(readiness.error).toContain('cosign');
    }
    // The create probe never runs when verification fails.
    expect(runner.callsFor('create')).toHaveLength(0);
  });

  test('S4: the cosign key path is redacted from the model-visible error', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (binary, args) => {
      if (binary === 'docker' && args[0] === 'info') {
        return okResult;
      }
      if (binary === 'docker' && args[0] === 'image') {
        return { ...okResult, stdout: inspectOutput({ digest: DIGEST, imageId: IMAGE_ID }) };
      }
      if (binary === 'cosign') {
        // cosign echoes the missing/unreadable key path in stderr.
        return { ...okResult, exitCode: 1, stderr: `error: could not read ${KEY_PATH}: no such file` };
      }
      throw new Error(`unexpected call: ${binary} ${args.join(' ')}`);
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const readiness = await driver.ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error).not.toContain(KEY_PATH);
      expect(readiness.error).toContain('<cosign public key>');
    }
  });

  test('wedged daemon (create probe timeout) is daemon_unavailable', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (binary, args) => {
      if (binary === 'docker' && args[0] === 'info') {
        return okResult;
      }
      if (binary === 'docker' && args[0] === 'image') {
        return { ...okResult, stdout: inspectOutput({ digest: DIGEST, imageId: IMAGE_ID }) };
      }
      if (binary === 'cosign') {
        return okResult;
      }
      if (binary === 'docker' && args[0] === 'create') {
        return { ...okResult, timedOut: true };
      }
      throw new Error(`unexpected call: ${binary} ${args.join(' ')}`);
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const readiness = await driver.ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('daemon_unavailable');
      expect(readiness.error).toContain('wedged');
    }
  });
});

describe('DockerDriver.provision', () => {
  test('forwards honest progress and verifies the pulled image', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner);
    const seen: string[] = [];
    runner.pullHandler = input => {
      input.onProgress('pulling layer 1/3');
      input.onProgress('pull complete');
      return Promise.resolve();
    };
    const driver = new DockerDriver(driverOptions(), runner);
    await driver.provision({
      signal: undefined,
      onProgress: (message: string) => seen.push(message),
      timeoutSeconds: 600,
    });
    expect(seen).toEqual(['pulling layer 1/3', 'pull complete']);
  });

  test('concurrent provisions coalesce on one pull', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner);
    let pulls = 0;
    runner.pullHandler = async () => {
      pulls += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const noop = (): void => undefined;
    await Promise.all([
      driver.provision({ signal: undefined, onProgress: noop, timeoutSeconds: 600 }),
      driver.provision({ signal: undefined, onProgress: noop, timeoutSeconds: 600 }),
    ]);
    expect(pulls).toBe(1);
  });

  test('a pull that never finishes hits the timeout bound', async () => {
    const runner = new FakeRunner();
    runner.pullHandler = input =>
      new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    const driver = new DockerDriver(driverOptions(), runner);
    const noop = (): void => undefined;
    await expect(driver.provision({ signal: undefined, onProgress: noop, timeoutSeconds: 0 })).rejects.toThrow(
      'did not complete within 0s',
    );
  });
});

describe('DockerDriver image verification record', () => {
  const OTHER_DIGEST = 'sha256:' + 'b'.repeat(64);
  const OTHER_IMAGE_ID = 'sha256:' + '2'.repeat(64);
  const OFFLINE: DockerCommandResult = {
    stdout: '',
    stderr: 'Error: getting signature: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host',
    exitCode: 1,
    timedOut: false,
  };
  const BAD_SIGNATURE: DockerCommandResult = { ...okResult, exitCode: 1, stderr: 'no matching signatures' };

  /** What the daemon and the registry say right now; tests mutate it between probes. */
  interface World {
    digest: string;
    imageId: string;
    cosign: DockerCommandResult;
  }

  let keyDir = '';
  let keyPath = '';

  function publicKeyPem(): string {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  function expectedFingerprint(pem: string): string {
    const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    return `sha256:${createHash('sha256').update(Buffer.from(body, 'base64')).digest('hex')}`;
  }

  beforeEach(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'tf-docker-key-'));
    keyPath = join(keyDir, 'cosign.pub');
    await writeFile(keyPath, publicKeyPem());
  });
  afterEach(async () => {
    await rm(keyDir, { recursive: true, force: true });
  });

  function scriptWorld(runner: FakeRunner, world: World): void {
    scriptReadyPath(runner);
    const ready = runner.runHandler;
    runner.runHandler = (binary, args) => {
      if (binary === 'docker' && args[0] === 'image') {
        return { ...okResult, stdout: inspectOutput({ digest: world.digest, imageId: world.imageId }) };
      }
      if (binary === 'cosign') {
        return world.cosign;
      }
      return ready(binary, args);
    };
  }

  function newDriver(runner: FakeRunner, overrides: Partial<DockerDriverOptions> = {}): DockerDriver {
    return new DockerDriver({ ...driverOptions(), cosignPublicKeyPath: keyPath, ...overrides }, runner);
  }

  function cosignCalls(runner: FakeRunner): number {
    return runner.calls.filter(call => call.binary === 'cosign').length;
  }

  /** A runner whose first probe verified online and recorded; the network is down afterwards. */
  async function recordedThenOffline(): Promise<{ runner: FakeRunner; world: World }> {
    const runner = new FakeRunner();
    const world: World = { digest: DIGEST, imageId: IMAGE_ID, cosign: okResult };
    scriptWorld(runner, world);
    await expect(newDriver(runner).ensureReady()).resolves.toEqual({ ready: true });
    expect(cosignCalls(runner)).toBe(1);
    world.cosign = OFFLINE;
    return { runner, world };
  }

  test('the first probe verifies online and records the result bound to digest, image ID, and key', async () => {
    const runner = new FakeRunner();
    scriptWorld(runner, { digest: DIGEST, imageId: IMAGE_ID, cosign: okResult });
    await expect(newDriver(runner).ensureReady()).resolves.toEqual({ ready: true });
    const record = await readImageVerificationRecord({ stateDir });
    expect(record).toMatchObject({
      image_ref: IMAGE,
      image_digest: DIGEST,
      image_id: IMAGE_ID,
      key_fingerprint: expectedFingerprint(await readFile(keyPath, 'utf8')),
    });
    expect(Number.isNaN(Date.parse(record?.verified_at ?? ''))).toBe(false);
  });

  test('readiness passes offline after a recorded verification, even from a fresh driver', async () => {
    const { runner } = await recordedThenOffline();
    await expect(newDriver(runner).ensureReady()).resolves.toEqual({ ready: true });
    await expect(newDriver(runner).ensureReady()).resolves.toEqual({ ready: true });
    expect(cosignCalls(runner)).toBe(1);
  });

  test('offline readiness still enforces the RepoDigest pin', async () => {
    const { runner, world } = await recordedThenOffline();
    world.digest = OTHER_DIGEST;
    const readiness = await newDriver(runner).ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('image_unavailable');
      expect(readiness.error).toContain('mismatch');
    }
    expect(cosignCalls(runner)).toBe(1);
  });

  test('a changed local image ID forces re-verification and the new result is recorded', async () => {
    const { runner, world } = await recordedThenOffline();
    world.imageId = OTHER_IMAGE_ID;
    const offline = await newDriver(runner).ensureReady();
    expect(offline.ready).toBe(false);
    expect(cosignCalls(runner)).toBe(2);

    world.cosign = okResult;
    await expect(newDriver(runner).ensureReady()).resolves.toEqual({ ready: true });
    expect(cosignCalls(runner)).toBe(3);
    expect((await readImageVerificationRecord({ stateDir }))?.image_id).toBe(OTHER_IMAGE_ID);

    world.cosign = OFFLINE;
    await expect(newDriver(runner).ensureReady()).resolves.toEqual({ ready: true });
    expect(cosignCalls(runner)).toBe(3);
  });

  test('a changed pinned digest forces re-verification', async () => {
    const { runner, world } = await recordedThenOffline();
    world.digest = OTHER_DIGEST;
    const driver = newDriver(runner, { image: `ghcr.io/climboutlabs/amanuensis-sandbox:0.1.0@${OTHER_DIGEST}` });
    const offline = await driver.ensureReady();
    expect(offline.ready).toBe(false);
    expect(cosignCalls(runner)).toBe(2);

    world.cosign = okResult;
    await expect(driver.ensureReady()).resolves.toEqual({ ready: true });
    expect((await readImageVerificationRecord({ stateDir }))?.image_digest).toBe(OTHER_DIGEST);
  });

  test('a record made under a different key fingerprint is ignored', async () => {
    const { runner } = await recordedThenOffline();
    await writeFile(keyPath, publicKeyPem());
    const readiness = await newDriver(runner).ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('image_unavailable');
    }
    expect(cosignCalls(runner)).toBe(2);
  });

  test('an unreadable key never lets a record stand in for verification', async () => {
    const { runner } = await recordedThenOffline();
    const readiness = await newDriver(runner, { cosignPublicKeyPath: join(keyDir, 'missing.pub') }).ensureReady();
    expect(readiness.ready).toBe(false);
    expect(cosignCalls(runner)).toBe(2);
  });

  test('an unrecordable key re-verifies on every probe', async () => {
    const runner = new FakeRunner();
    scriptWorld(runner, { digest: DIGEST, imageId: IMAGE_ID, cosign: okResult });
    const driver = newDriver(runner, { cosignPublicKeyPath: join(keyDir, 'missing.pub') });
    await driver.ensureReady();
    await driver.ensureReady();
    expect(cosignCalls(runner)).toBe(2);
    expect(await readImageVerificationRecord({ stateDir })).toBeUndefined();
  });

  const tamperings: [string, () => Promise<void>][] = [
    ['a missing record', () => rm(imageVerificationRecordPath({ stateDir }))],
    ['a record that is not JSON', () => writeFile(imageVerificationRecordPath({ stateDir }), 'not json')],
    ['a record of the wrong shape', () => writeFile(imageVerificationRecordPath({ stateDir }), '{"image_id":"x"}')],
    [
      'a record whose image ID was edited',
      async () => {
        const record = await readImageVerificationRecord({ stateDir });
        await writeFile(
          imageVerificationRecordPath({ stateDir }),
          JSON.stringify({ ...record, image_id: OTHER_IMAGE_ID }),
        );
      },
    ],
    [
      'a record whose image reference was edited',
      async () => {
        const record = await readImageVerificationRecord({ stateDir });
        await writeFile(
          imageVerificationRecordPath({ stateDir }),
          JSON.stringify({ ...record, image_ref: `registry.example/other@${DIGEST}` }),
        );
      },
    ],
  ];

  test.each(tamperings)('%s re-verifies', async (_name, tamper) => {
    const { runner, world } = await recordedThenOffline();
    await tamper();
    const offline = await newDriver(runner).ensureReady();
    expect(offline.ready).toBe(false);
    expect(cosignCalls(runner)).toBe(2);

    world.cosign = okResult;
    await expect(newDriver(runner).ensureReady()).resolves.toEqual({ ready: true });
    expect(cosignCalls(runner)).toBe(3);

    world.cosign = OFFLINE;
    await expect(newDriver(runner).ensureReady()).resolves.toEqual({ ready: true });
    expect(cosignCalls(runner)).toBe(3);
  });

  test('provisioning re-verifies even when a matching record exists', async () => {
    const { runner, world } = await recordedThenOffline();
    world.cosign = okResult;
    await newDriver(runner).provision({ signal: undefined, onProgress: () => undefined, timeoutSeconds: 600 });
    expect(cosignCalls(runner)).toBe(2);
  });

  test('a provisioned image is recorded so later probes pass offline', async () => {
    const runner = new FakeRunner();
    const world: World = { digest: DIGEST, imageId: IMAGE_ID, cosign: okResult };
    scriptWorld(runner, world);
    await newDriver(runner).provision({ signal: undefined, onProgress: () => undefined, timeoutSeconds: 600 });
    world.cosign = OFFLINE;
    await expect(newDriver(runner).ensureReady()).resolves.toEqual({ ready: true });
    expect(cosignCalls(runner)).toBe(1);
  });

  test('verification needed while offline is image_unavailable with actionable text', async () => {
    const runner = new FakeRunner();
    scriptWorld(runner, { digest: DIGEST, imageId: IMAGE_ID, cosign: OFFLINE });
    const readiness = await newDriver(runner, { cosignPublicKeyPath: keyPath }).ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('image_unavailable');
      expect(readiness.error).toContain('could not reach the image registry');
      expect(readiness.error).toContain('connect to the internet once');
      expect(readiness.error).not.toContain(keyPath);
    }
    expect(runner.callsFor('create')).toHaveLength(0);
  });

  test('a cosign timeout is reported as an unreachable registry, not a bad signature', async () => {
    const runner = new FakeRunner();
    scriptWorld(runner, { digest: DIGEST, imageId: IMAGE_ID, cosign: { ...okResult, exitCode: -1, timedOut: true } });
    const readiness = await newDriver(runner).ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error).toContain('could not reach the image registry');
    }
  });

  test('a rejected signature keeps the verification-failed wording and writes no record', async () => {
    const runner = new FakeRunner();
    scriptWorld(runner, { digest: DIGEST, imageId: IMAGE_ID, cosign: BAD_SIGNATURE });
    const readiness = await newDriver(runner).ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error).toContain('cosign signature verification failed');
      expect(readiness.error).not.toContain('could not reach');
    }
    expect(await readImageVerificationRecord({ stateDir })).toBeUndefined();
  });

  test('an unwritable state dir does not fail an otherwise verified readiness', async () => {
    const blocker = join(keyDir, 'not-a-directory');
    await writeFile(blocker, '');
    const runner = new FakeRunner();
    scriptWorld(runner, { digest: DIGEST, imageId: IMAGE_ID, cosign: okResult });
    await expect(newDriver(runner, { stateDir: blocker }).ensureReady()).resolves.toEqual({ ready: true });
  });

  test('an image whose inspect reports no ID is refused', async () => {
    const runner = new FakeRunner();
    scriptWorld(runner, { digest: DIGEST, imageId: IMAGE_ID, cosign: okResult });
    const ready = runner.runHandler;
    runner.runHandler = (binary, args) => {
      if (binary === 'docker' && args[0] === 'image') {
        return {
          ...okResult,
          stdout: JSON.stringify([{ RepoDigests: [`ghcr.io/climboutlabs/amanuensis-sandbox@${DIGEST}`] }]),
        };
      }
      return ready(binary, args);
    };
    const readiness = await newDriver(runner).ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('image_unavailable');
      expect(readiness.error).toContain('no image ID');
    }
    expect(cosignCalls(runner)).toBe(0);
  });
});

describe('DockerDriver.reapStale', () => {
  test('removes only labeled containers older than 30 minutes', async () => {
    const runner = new FakeRunner();
    const now = Date.now();
    const oldCreated = new Date(now - 31 * 60 * 1000).toISOString();
    const freshCreated = new Date(now - 5 * 60 * 1000).toISOString();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'ps') {
        expect(args).toContain('label=tf.sandbox.run');
        return { ...okResult, stdout: 'old-id\nfresh-id\n' };
      }
      if (args[0] === 'inspect') {
        return { ...okResult, stdout: `old-id ${oldCreated}\nfresh-id ${freshCreated}\n` };
      }
      if (args[0] === 'rm') {
        return okResult;
      }
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const driver = new DockerDriver(driverOptions(), runner);
    await driver.reapStale();
    const rms = runner.callsFor('rm');
    expect(rms).toHaveLength(1);
    expect(rms[0]?.args).toEqual(['rm', '-f', 'old-id']);
  });

  test('does nothing when the daemon is down', async () => {
    const runner = new FakeRunner();
    runner.runHandler = () => ({ ...okResult, exitCode: 1, stderr: 'daemon down' });
    const driver = new DockerDriver(driverOptions(), runner);
    await expect(driver.reapStale()).resolves.toBeUndefined();
  });
});

describe('DockerDriver.dispose', () => {
  test('kills in-flight containers when the drain expires', async () => {
    jest.useFakeTimers();
    try {
      const runner = new FakeRunner();
      runner.runHandler = (_binary, args) => {
        if (args[0] === 'create') {
          return { ...okResult, stdout: 'cid-5\n' };
        }
        return okResult;
      };
      // The post-create isolation verification inspect must see a hardened
      // container or the run is refused before attach ever starts.
      scriptIsolationInspect(runner);
      // Attach hangs until the driver kills the container (dispose path).
      let resolveAttach: ((code: number) => void) | undefined;
      runner.attachHandler = () =>
        new Promise<number>(resolve => {
          resolveAttach = resolve;
        });
      const originalRun: DockerCommandRunner['run'] = runner.run.bind(runner);
      runner.run = async (binary: string, args: string[]) => {
        const result = await originalRun(binary, args, { timeoutMs: 5000, signal: undefined });
        if (args[0] === 'kill') {
          resolveAttach?.(137);
        }
        return result;
      };
      const driver = new DockerDriver(driverOptions(), runner);
      const runPromise = driver.run(runParams());
      await jest.advanceTimersByTimeAsync(10); // let create resolve
      const disposePromise = driver.dispose();
      await jest.advanceTimersByTimeAsync(30000); // expire the 30s drain
      await disposePromise;
      expect(runner.killed).toContain('cid-5');
      const result = await runPromise;
      expect(result.terminatedBy).toBe('completed');
      expect(result.exitCode).toBe(137);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('detectDocker', () => {
  test('returns false for a missing socket path', async () => {
    await expect(detectDocker(join(tmpdir(), 'tf-no-such-socket-xyz.sock'))).resolves.toBe(false);
  });

  test('returns true for an existing socket path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tf-socket-'));
    const socketPath = join(dir, 'docker.sock');
    await writeFile(socketPath, '');
    await expect(detectDocker(socketPath)).resolves.toBe(true);
  });

  test('memoizes the result per socket path', async () => {
    const socketPath = join(tmpdir(), 'tf-memo-socket-xyz.sock');
    const first = detectDocker(socketPath);
    const second = detectDocker(socketPath);
    expect(second).toBe(first);
    await expect(first).resolves.toBe(false);
  });
});

describe('DockerDriver.ensureReady docker detection', () => {
  test('missing socket is docker_unavailable with the exact recovery message', async () => {
    const runner = new FakeRunner();
    const driver = new DockerDriver(
      { ...driverOptions(), dockerSocketPath: join(tmpdir(), 'tf-no-such-socket-abc.sock') },
      runner,
    );
    const readiness = await driver.ensureReady();
    expect(readiness).toEqual({
      ready: false,
      error_code: 'docker_unavailable',
      error: DOCKER_UNAVAILABLE_MESSAGE,
    });
    // The daemon is never touched: no docker CLI invocation at all.
    expect(runner.calls).toHaveLength(0);
  });

  test('docker_unavailable recovery message pins the exact user-facing copy', () => {
    // Pinned literal, not the imported constant: the acceptance copy must not
    // drift without this test failing.
    expect(DOCKER_UNAVAILABLE_MESSAGE).toBe(
      "I can't run code on this machine because Docker isn't available. To enable code execution, install Docker from https://docs.docker.com/engine/install/ and restart Aman.",
    );
  });

  test('present socket proceeds to the normal readiness path', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner);
    const driver = new DockerDriver(driverOptions(), runner);
    await expect(driver.ensureReady()).resolves.toEqual({ ready: true });
  });
});

describe('checkContainerIsolation', () => {
  test('accepts a fully hardened container', () => {
    expect(checkContainerIsolation({ inspectJson: JSON.stringify([goodInspectEntry()]) })).toEqual({ ok: true });
  });

  test('rejects malformed inspect output', () => {
    expect(checkContainerIsolation({ inspectJson: 'not json' }).ok).toBe(false);
    expect(checkContainerIsolation({ inspectJson: '[]' }).ok).toBe(false);
    expect(checkContainerIsolation({ inspectJson: '{}' }).ok).toBe(false);
  });

  test('rejects a container with network access', () => {
    const entry = goodInspectEntry();
    (entry['HostConfig'] as Record<string, unknown>)['NetworkMode'] = 'bridge';
    const result = checkContainerIsolation({ inspectJson: JSON.stringify([entry]) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/NetworkMode/);
    }
  });

  test('rejects a writable root filesystem', () => {
    const entry = goodInspectEntry();
    (entry['HostConfig'] as Record<string, unknown>)['ReadonlyRootfs'] = false;
    const result = checkContainerIsolation({ inspectJson: JSON.stringify([entry]) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/read-only/);
    }
  });

  test.each(['0', 'root', '0:0', ''])('rejects root user %p', user => {
    const entry = goodInspectEntry();
    (entry['Config'] as Record<string, unknown>)['User'] = user;
    expect(checkContainerIsolation({ inspectJson: JSON.stringify([entry]) }).ok).toBe(false);
  });

  test('rejects missing capability drop', () => {
    const entry = goodInspectEntry();
    (entry['HostConfig'] as Record<string, unknown>)['CapDrop'] = [];
    expect(checkContainerIsolation({ inspectJson: JSON.stringify([entry]) }).ok).toBe(false);
  });

  test('rejects missing no-new-privileges', () => {
    const entry = goodInspectEntry();
    (entry['HostConfig'] as Record<string, unknown>)['SecurityOpt'] = ['seccomp=default'];
    const result = checkContainerIsolation({ inspectJson: JSON.stringify([entry]) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no-new-privileges/);
    }
  });

  test('rejects missing seccomp profile', () => {
    const entry = goodInspectEntry();
    (entry['HostConfig'] as Record<string, unknown>)['SecurityOpt'] = ['no-new-privileges:true'];
    const result = checkContainerIsolation({ inspectJson: JSON.stringify([entry]) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/seccomp/);
    }
  });
});

describe('DockerDriver.run isolation refusal', () => {
  test('refuses the run when the created container lacks network isolation', async () => {
    const runner = new FakeRunner();
    let attached = false;
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, stdout: 'cid-badnet\n' };
      }
      if (args[0] === 'inspect' && args.length === 2) {
        const entry = goodInspectEntry();
        (entry['HostConfig'] as Record<string, unknown>)['NetworkMode'] = 'bridge';
        return { ...okResult, stdout: JSON.stringify([entry]) };
      }
      return okResult;
    };
    runner.attachHandler = () => {
      attached = true;
      return Promise.resolve(0);
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const result = await driver.run(runParams());
    expect(result.terminatedBy).toBe('internal');
    expect(result.internalError).toBe(`${ISOLATION_REFUSED_MARKER}${ISOLATION_REFUSED_MESSAGE}`);
    // The program never started: attach was never called.
    expect(attached).toBe(false);
    // The offending container was removed.
    expect(runner.callsFor('rm').length).toBeGreaterThan(0);
  });

  test('refuses the run when the verification inspect itself fails', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, stdout: 'cid-noinspect\n' };
      }
      if (args[0] === 'inspect' && args.length === 2) {
        return { ...okResult, exitCode: 1, stderr: 'no such container' };
      }
      return okResult;
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const result = await driver.run(runParams());
    expect(result.terminatedBy).toBe('internal');
    expect(result.internalError).toBe(`${ISOLATION_REFUSED_MARKER}${ISOLATION_REFUSED_MESSAGE}`);
  });
});

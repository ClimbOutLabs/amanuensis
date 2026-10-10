/**
 * Unit tests for the Docker isolation driver. No daemon: every docker/cosign
 * interaction is scripted through a fake DockerCommandRunner.
 */
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  checkContainerIsolation,
  detectDocker,
  DOCKER_UNAVAILABLE_MESSAGE,
  DockerDriver,
  ISOLATION_REFUSED_MESSAGE,
  resetDockerDetectionForTests,
  type DockerCommandResult,
  type DockerCommandRunner,
  type DockerDriverOptions,
} from '../../../../src/core/sandbox/driver/DockerDriver';
import { ISOLATION_REFUSED_MARKER, type DriverRunParams } from '../../../../src/core/sandbox/driver/IsolationDriver';
import { stageRunDirs } from '../../../../src/core/sandbox/driver/RunStaging';
import { FakeSandboxContainers } from './FakeSandboxContainers';

const DIGEST = 'sha256:' + 'a'.repeat(64);
const IMAGE = `ghcr.io/climboutlabs/amanuensis-sandbox:0.1.0@${DIGEST}`;
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
    dockerBinary: undefined,
    cosignBinary: undefined,
    dockerSocketPath: fakeSocketPath,
    dataDir: fakeDataDir,
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
let fakeDataDir = '';
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tf-docker-socket-'));
  fakeSocketPath = join(dir, 'docker.sock');
  await writeFile(fakeSocketPath, '');
  fakeDataDir = await mkdtemp(join(tmpdir(), 'tf-docker-data-'));
});
afterAll(async () => {
  await rm(fakeDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  resetDockerDetectionForTests();
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
    sandboxIdentity: { uid: 65532, gid: 65532, chownRunDirs: true },
    signal: overrides.signal,
    harvestGraceMs: 2000,
  };
}

/**
 * ensureReady happy path: info, inspect (pinned digest), cosign, create probe,
 * then the canary run (create, isolation inspect, attach, kill, rm). The canary
 * container is the DAC-enforcing fake, so a staging/uid mismatch fails it.
 */
function scriptReadyPath(runner: FakeRunner, digest = DIGEST, containers = new FakeSandboxContainers(undefined)): void {
  runner.attachHandler = input =>
    containers.attach({
      containerId: input.containerId,
      onStderr: chunk => {
        input.onStderr(chunk);
      },
    });
  runner.runHandler = (binary, args) => {
    if (binary === 'docker' && args[0] === 'info') {
      return okResult;
    }
    if (binary === 'docker' && args[0] === 'image') {
      return {
        ...okResult,
        stdout: JSON.stringify([{ RepoDigests: [`ghcr.io/climboutlabs/amanuensis-sandbox@${digest}`] }]),
      };
    }
    if (binary === 'cosign') {
      return okResult;
    }
    if (binary === 'docker' && args[0] === 'create') {
      // The wedged-daemon probe carries --entrypoint; anything else is the canary run.
      const id = args.includes('--entrypoint') ? 'probe-container-id' : containers.create(args);
      return { ...okResult, stdout: `${id}\n` };
    }
    if (binary === 'docker' && args[0] === 'inspect' && args.length === 2) {
      return { ...okResult, stdout: JSON.stringify([goodInspectEntry()]) };
    }
    if (binary === 'docker' && (args[0] === 'rm' || args[0] === 'kill')) {
      return okResult;
    }
    throw new Error(`unexpected call: ${binary} ${args.join(' ')}`);
  };
}

/** A `docker inspect` entry carrying every mandatory isolation flag. */
function goodInspectEntry(user = '65532:65532'): Record<string, unknown> {
  return {
    Config: { User: user },
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

  test('runs as the numeric server uid:gid with no supplementary groups', async () => {
    const runner = new FakeRunner();
    runner.runHandler = (_binary, args) => {
      if (args[0] === 'create') {
        return { ...okResult, stdout: 'cid-1\n' };
      }
      return okResult;
    };
    scriptIsolationInspect(runner);
    const driver = new DockerDriver(driverOptions(), runner);
    await driver.run({ ...runParams(), sandboxIdentity: { uid: 1000, gid: 1001, chownRunDirs: false } });
    const args = runner.callsFor('create')[0]?.args ?? [];
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1001');
    expect(args.some(arg => arg.startsWith('--group-add'))).toBe(false);
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
    // Both throwaway containers are removed: the wedged-daemon probe and the canary run.
    expect(runner.callsFor('rm').map(call => call.args[2])).toEqual(['probe-container-id', 'fake-container-1']);
  });

  test('a canary container that cannot write is daemon_unavailable', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner);
    runner.attachHandler = input => {
      input.onStderr(Buffer.from("PermissionError: [Errno 13] Permission denied: '/egress/out'\n"));
      return Promise.resolve(1);
    };
    const driver = new DockerDriver(driverOptions(), runner);
    const readiness = await driver.ensureReady();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('daemon_unavailable');
      expect(readiness.error).toMatch(/canary run failed/);
      expect(readiness.error).toMatch(/Permission denied/);
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
        return {
          ...okResult,
          stdout: JSON.stringify([{ RepoDigests: [`ghcr.io/climboutlabs/amanuensis-sandbox@${DIGEST}`] }]),
        };
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
        return {
          ...okResult,
          stdout: JSON.stringify([{ RepoDigests: [`ghcr.io/climboutlabs/amanuensis-sandbox@${DIGEST}`] }]),
        };
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
        return {
          ...okResult,
          stdout: JSON.stringify([{ RepoDigests: [`ghcr.io/climboutlabs/amanuensis-sandbox@${DIGEST}`] }]),
        };
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

  test.each(['1000:1001', '65532:65532'])('accepts the non-root numeric user %p', user => {
    expect(checkContainerIsolation({ inspectJson: JSON.stringify([goodInspectEntry(user)]) })).toEqual({ ok: true });
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

describe('DockerDriver.ensureReady canary', () => {
  const fsPromises: typeof import('node:fs/promises') = jest.requireActual('node:fs/promises');
  let chownSpy: jest.SpyInstance;
  let getuidSpy: jest.SpyInstance;
  let getgidSpy: jest.SpyInstance;

  /** The server process acts as this uid:gid; every chown is recorded on the fake host instead of applied. */
  function actAsServer(input: { server: { uid: number; gid: number }; containers: FakeSandboxContainers }): void {
    getuidSpy.mockReturnValue(input.server.uid);
    getgidSpy.mockReturnValue(input.server.gid);
    chownSpy.mockImplementation((path: string, uid: number, gid: number) => {
      input.containers.recordChown({ path, owner: { uid, gid } });
      return Promise.resolve();
    });
  }

  function canaryCreate(runner: FakeRunner): string[] {
    const canary = runner.callsFor('create').find(call => !call.args.includes('--entrypoint'));
    if (canary === undefined) {
      throw new Error('expected a canary docker create');
    }
    return canary.args;
  }

  function flagValues(args: string[], flag: string): string[] {
    return args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ''] : []));
  }

  /** Host dir behind one of the canary container's bind mounts. */
  function hostDirOf(runner: FakeRunner, containerPath: string): string {
    const mount = flagValues(canaryCreate(runner), '-v').find(value => value.split(':')[1] === containerPath);
    const hostDir = mount?.split(':')[0];
    if (hostDir === undefined) {
      throw new Error(`expected a canary mount at ${containerPath}`);
    }
    return hostDir;
  }

  async function runDirEntries(): Promise<string[]> {
    return readdir(join(fakeDataDir, 'sandbox-runs')).catch(() => []);
  }

  beforeEach(() => {
    chownSpy = jest.spyOn(fsPromises, 'chown');
    getuidSpy = jest.spyOn(process, 'getuid');
    getgidSpy = jest.spyOn(process, 'getgid');
  });

  afterEach(async () => {
    chownSpy.mockRestore();
    getuidSpy.mockRestore();
    getgidSpy.mockRestore();
    // A failed canary must not leave its run root behind for the next test's assertions.
    for (const entry of await runDirEntries()) {
      await rm(join(fakeDataDir, 'sandbox-runs', entry), { recursive: true, force: true });
    }
  });

  test('non-root server: canary runs as its own uid:gid, unchowned, under the runs dir, and cleans up', async () => {
    const server = { uid: 4242, gid: 4343 };
    const containers = new FakeSandboxContainers(server);
    const runner = new FakeRunner();
    scriptReadyPath(runner, DIGEST, containers);
    actAsServer({ server, containers });
    const driver = new DockerDriver(driverOptions(), runner);

    await expect(driver.ensureReady()).resolves.toEqual({ ready: true });

    expect(chownSpy).not.toHaveBeenCalled();
    const args = canaryCreate(runner);
    expect(flagValues(args, '--user')).toEqual(['4242:4343']);
    expect(args.some(arg => arg.startsWith('--group-add'))).toBe(false);
    const env = flagValues(args, '-e');
    expect(env).toEqual(expect.arrayContaining(['USER=sandbox', 'LOGNAME=sandbox', 'HOME=/scratch']));
    // The canary is staged beside real runs, never in os.tmpdir().
    const runsDir = join(await realpath(fakeDataDir), 'sandbox-runs');
    const mounts = flagValues(args, '-v');
    expect(mounts).toHaveLength(3);
    for (const mount of mounts) {
      expect(mount.startsWith(`${runsDir}/canary-`)).toBe(true);
    }
    expect(await runDirEntries()).toEqual([]);
  });

  test('a non-root server in group 0 is not ready and starts no canary container', async () => {
    const containers = new FakeSandboxContainers(undefined);
    const runner = new FakeRunner();
    scriptReadyPath(runner, DIGEST, containers);
    getuidSpy.mockReturnValue(4242);
    getgidSpy.mockReturnValue(0);
    const driver = new DockerDriver(driverOptions(), runner);

    const readiness = await driver.ensureReady();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('daemon_unavailable');
      expect(readiness.error).toMatch(/gid 0/);
    }
    // Only the wedged-daemon probe created a container.
    expect(runner.callsFor('create')).toHaveLength(1);
    expect(await runDirEntries()).toEqual([]);
  });

  test('root server: canary runs as the image uid after handing every dir and file to it', async () => {
    const server = { uid: 0, gid: 0 };
    const containers = new FakeSandboxContainers(server);
    const runner = new FakeRunner();
    scriptReadyPath(runner, DIGEST, containers);
    actAsServer({ server, containers });
    const driver = new DockerDriver(driverOptions(), runner);

    await expect(driver.ensureReady()).resolves.toEqual({ ready: true });

    const args = canaryCreate(runner);
    expect(flagValues(args, '--user')).toEqual(['65532:65532']);
    const chowned = chownSpy.mock.calls.map(call => ({ path: String(call[0]), uid: call[1], gid: call[2] }));
    expect(chowned.every(call => call.uid === 65532 && call.gid === 65532)).toBe(true);
    const chownedNames = chowned.map(call => basename(call.path));
    expect(chownedNames).toEqual(
      expect.arrayContaining(['ingress', 'scratch', 'egress', 'canary_in', '__runcode_main.py']),
    );
    expect(await runDirEntries()).toEqual([]);
  });

  test('root server: a failing chown handoff is not ready and starts no canary container', async () => {
    const containers = new FakeSandboxContainers({ uid: 0, gid: 0 });
    const runner = new FakeRunner();
    scriptReadyPath(runner, DIGEST, containers);
    getuidSpy.mockReturnValue(0);
    getgidSpy.mockReturnValue(0);
    chownSpy.mockRejectedValue(new Error('EPERM: operation not permitted, chown'));
    const driver = new DockerDriver(driverOptions(), runner);

    const readiness = await driver.ensureReady();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error_code).toBe('daemon_unavailable');
      expect(readiness.error).toMatch(/could not hand the run directories to sandbox uid 65532:65532/);
      expect(readiness.error).toMatch(/EPERM/);
    }
    // Only the wedged-daemon probe created a container.
    expect(runner.callsFor('create')).toHaveLength(1);
    expect(await runDirEntries()).toEqual([]);
  });

  test('root server: a chown that is silently ignored fails the canary instead of passing', async () => {
    const containers = new FakeSandboxContainers({ uid: 0, gid: 0 });
    const runner = new FakeRunner();
    scriptReadyPath(runner, DIGEST, containers);
    getuidSpy.mockReturnValue(0);
    getgidSpy.mockReturnValue(0);
    chownSpy.mockResolvedValue(undefined);
    const driver = new DockerDriver(driverOptions(), runner);

    const readiness = await driver.ensureReady();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error).toMatch(/canary run failed as 65532:65532/);
      expect(readiness.error).toMatch(/Permission denied/);
      expect(readiness.error).not.toContain(fakeDataDir);
    }
    // The failed canary container is still killed and removed.
    expect(runner.callsFor('rm').map(call => call.args[2])).toContain('fake-container-1');
  });

  test('regression: the image uid against 0700 dirs owned by another server uid is denied, the server uid is not', async () => {
    // Pre-fix shape: the container always ran as 65532 and the dirs belonged to the server.
    const server = { uid: 4242, gid: 4343 };
    const stagedForServer = await stageRunDirs({
      runRoot: join(fakeDataDir, 'legacy-run'),
      language: 'python',
      code: 'pass',
      files: [{ name: 'canary_in', bytes: Buffer.from('token') }],
      identity: { ...server, chownRunDirs: false },
    });
    const mounts = [
      '-v',
      `${stagedForServer.ingressDir}:/ingress:ro`,
      '-v',
      `${stagedForServer.scratchDir}:/scratch:rw`,
      '-v',
      `${stagedForServer.egressDir}:/egress:rw`,
    ];
    const containers = new FakeSandboxContainers(server);
    const denied: string[] = [];
    const legacy = containers.create(['create', '--user', '65532:65532', ...mounts]);
    const legacyExit = await containers.attach({
      containerId: legacy,
      onStderr: chunk => denied.push(chunk.toString()),
    });
    expect(legacyExit).toBe(1);
    expect(denied.join('')).toMatch(/Permission denied/);

    const asServer = containers.create(['create', '--user', '4242:4343', ...mounts]);
    const serverExit = await containers.attach({ containerId: asServer, onStderr: () => undefined });
    expect(serverExit).toBe(0);
    expect(await readFile(join(stagedForServer.egressDir, 'out'), 'utf8')).toBe('token');
  });

  test('a canary that wrote nothing to egress is not ready', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner);
    runner.attachHandler = () => Promise.resolve(0);
    const driver = new DockerDriver(driverOptions(), runner);

    const readiness = await driver.ensureReady();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error).toMatch(/could not read the file the container wrote to egress/);
    }
  });

  test('a canary whose egress output differs from its ingress input is not ready', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner);
    runner.attachHandler = async () => {
      await writeFile(join(hostDirOf(runner, '/egress'), 'out'), 'stale');
      return 0;
    };
    const driver = new DockerDriver(driverOptions(), runner);

    const readiness = await driver.ensureReady();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error).toMatch(/does not match what the container read from ingress/);
    }
  });

  test('a canary whose directories du cannot account for is not ready', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner);
    const runCanaryProgram = runner.attachHandler;
    runner.attachHandler = async input => {
      const exitCode = await runCanaryProgram(input);
      // du fails closed on a dir it cannot read; a vanished dir stands in for an unreadable one.
      await rm(hostDirOf(runner, '/scratch'), { recursive: true, force: true });
      return exitCode;
    };
    const driver = new DockerDriver(driverOptions(), runner);

    const readiness = await driver.ensureReady();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.error).toMatch(/could not measure the canary directories with du/);
    }
  });

  test('a run root that survives removal is not ready', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner);
    const rmSpy = jest.spyOn(fsPromises, 'rm').mockResolvedValue(undefined);
    const driver = new DockerDriver(driverOptions(), runner);
    try {
      const readiness = await driver.ensureReady();
      expect(readiness.ready).toBe(false);
      if (!readiness.ready) {
        expect(readiness.error).toMatch(/run directory still exists after removal/);
      }
    } finally {
      rmSpy.mockRestore();
    }
  });

  test('a failing run root removal is not ready', async () => {
    const runner = new FakeRunner();
    scriptReadyPath(runner);
    const rmSpy = jest.spyOn(fsPromises, 'rm').mockRejectedValue(new Error('EACCES: permission denied, rmdir'));
    const driver = new DockerDriver(driverOptions(), runner);
    try {
      const readiness = await driver.ensureReady();
      expect(readiness.ready).toBe(false);
      if (!readiness.ready) {
        expect(readiness.error).toMatch(/could not remove the run directory: EACCES/);
      }
    } finally {
      rmSpy.mockRestore();
    }
  });
});

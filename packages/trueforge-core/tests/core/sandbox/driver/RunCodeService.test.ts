import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  DriverReadiness,
  DriverRunParams,
  DriverRunResult,
  IsolationDriver,
} from '../../../../src/core/sandbox/driver/IsolationDriver';
import {
  RunCodeService,
  validateRunCodeStartupConfig,
  type HarvestedFile,
} from '../../../../src/core/sandbox/driver/RunCodeService';
import { makeSilentLogger } from '../../harnessMocks';

const OK_RESULT: DriverRunResult = {
  exitCode: 0,
  stdout: 'done',
  stderr: '',
  terminatedBy: 'completed',
  internalError: undefined,
  harvestWarnings: [],
};

class FakeDriver implements IsolationDriver {
  readonly kind = 'docker' as const;
  readiness: DriverReadiness = { ready: true };
  runBehavior: (params: DriverRunParams) => Promise<DriverRunResult> = () => Promise.resolve({ ...OK_RESULT });
  runs: DriverRunParams[] = [];
  provisionCalls = 0;
  reaped = 0;
  disposed = false;

  ensureReady(): Promise<DriverReadiness> {
    return Promise.resolve(this.readiness);
  }

  provision(input: {
    signal: AbortSignal | undefined;
    onProgress: (message: string) => void;
    timeoutSeconds: number;
  }): Promise<void> {
    this.provisionCalls += 1;
    input.onProgress(`fake pulling (timeout ${String(input.timeoutSeconds)}s)`);
    return Promise.resolve();
  }

  run(params: DriverRunParams): Promise<DriverRunResult> {
    this.runs.push(params);
    return this.runBehavior(params);
  }

  reapStale(): Promise<void> {
    this.reaped += 1;
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

function makeService(driver: FakeDriver, dataDir: string, now?: () => number): RunCodeService {
  return new RunCodeService({
    driver,
    dataDir,
    defaultTimeoutSeconds: 120,
    maxTimeoutSeconds: 600,
    memoryMb: 512,
    diskMb: 1024,
    outputCapKb: 256,
    maxConcurrentRuns: 2,
    imagePullTimeoutSeconds: 120,
    harvestGraceMs: 2000,
    logger: makeSilentLogger(),
    now,
    sleepMs: () => new Promise<void>(resolve => setTimeout(resolve, 25)),
  });
}

const VALID_INPUT = { language: 'python', code: 'print("hi")' };

describe('RunCodeService', () => {
  let dataDir: string;
  let driver: FakeDriver;
  let service: RunCodeService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'runcode-test-'));
    driver = new FakeDriver();
    service = makeService(driver, dataDir);
  });

  afterEach(async () => {
    await service.dispose().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects schema-invalid input before touching the driver or the filesystem', async () => {
    const result = await service.runCode({ language: 'ruby', code: 'puts 1' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error_code).toBe('invalid_input');
    }
    expect(driver.runs).toHaveLength(0);
  });

  it('short-circuits on readiness failure before staging anything', async () => {
    driver.readiness = {
      ready: false,
      error_code: 'image_unavailable',
      error: `image missing behind ${dataDir}/images`,
    };
    const result = await service.runCode(VALID_INPUT);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error_code).toBe('image_unavailable');
      // Host path in the readiness detail is scrubbed.
      expect(result.error).not.toContain(dataDir);
      expect(result.error).toContain('<sandbox>/');
    }
    expect(driver.runs).toHaveLength(0);
  });

  it('fails a dormant install closed at first call time with image_unavailable', async () => {
    // Blank SANDBOX_IMAGE leaves run_code dormant: the driver's ensureReady
    // reports image_unavailable (unpinned image, no digest to verify), so the
    // first runCode call fails closed — no provisioning pull is attempted, no
    // run is staged, and nothing executes.
    driver.readiness = {
      ready: false,
      error_code: 'image_unavailable',
      error: `sandbox image '' is not pinned as tag@sha256:<digest> — refusing to run an unpinned image`,
    };
    const result = await service.runCode(VALID_INPUT);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error_code).toBe('image_unavailable');
    } else {
      throw new Error('expected failure');
    }
    expect(driver.provisionCalls).toBe(0);
    expect(driver.runs).toHaveLength(0);
  });

  it('maps daemon_unavailable and kvm_unavailable readiness onto daemon_unavailable', async () => {
    driver.readiness = { ready: false, error_code: 'daemon_unavailable', error: 'socket gone' };
    const r1 = await service.runCode(VALID_INPUT);
    expect(r1.status).toBe('failed');
    if (r1.status === 'failed') {
      expect(r1.error_code).toBe('daemon_unavailable');
    }
    driver.readiness = { ready: false, error_code: 'kvm_unavailable', error: 'no /dev/kvm' };
    const r2 = await service.runCode(VALID_INPUT);
    if (r2.status === 'failed') {
      expect(r2.error_code).toBe('daemon_unavailable');
      expect(r2.error).toContain('no /dev/kvm');
    } else {
      throw new Error('expected failure');
    }
  });

  it('maps docker_unavailable readiness onto docker_unavailable with the exact message', async () => {
    const message =
      "I can't run code on this machine because Docker isn't available. To enable code execution, install Docker from https://docs.docker.com/engine/install/ and restart Aman.";
    driver.readiness = { ready: false, error_code: 'docker_unavailable', error: message };
    const result = await service.runCode(VALID_INPUT);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error_code).toBe('docker_unavailable');
      expect(result.error).toBe(message);
    } else {
      throw new Error('expected failure');
    }
    expect(driver.runs).toHaveLength(0);
  });

  it('maps the isolation-refused marker onto isolation_refused with the exact message', async () => {
    const message = "I can't run this safely — the sandbox couldn't apply all isolation guarantees.";
    driver.runBehavior = () =>
      Promise.resolve({
        exitCode: -1,
        stdout: '',
        stderr: '',
        terminatedBy: 'internal' as const,
        internalError: `isolation_refused:${message}`,
        harvestWarnings: [],
      });
    const result = await service.runCode(VALID_INPUT);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error_code).toBe('isolation_refused');
      expect(result.error).toBe(message);
    } else {
      throw new Error('expected failure');
    }
  });

  it('rejects with concurrency_exceeded when all slots are busy', async () => {
    const single = new RunCodeService({
      driver,
      dataDir,
      defaultTimeoutSeconds: 120,
      maxTimeoutSeconds: 600,
      memoryMb: 512,
      diskMb: 1024,
      outputCapKb: 256,
      maxConcurrentRuns: 1,
      imagePullTimeoutSeconds: 120,
      harvestGraceMs: 2000,
      logger: makeSilentLogger(),
      now: undefined,
      sleepMs: () => new Promise<void>(resolve => setTimeout(resolve, 25)),
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    driver.runBehavior = async () => {
      await gate;
      return { ...OK_RESULT };
    };
    const first = single.runCode(VALID_INPUT);
    await new Promise(resolve => setTimeout(resolve, 100));
    const second = await single.runCode(VALID_INPUT);
    expect(second.status).toBe('failed');
    if (second.status === 'failed') {
      expect(second.error_code).toBe('concurrency_exceeded');
    }
    release();
    const firstResult = await first;
    expect(firstResult.status).toBe('ok');
    await single.dispose().catch(() => undefined);
  });

  it('runs the happy path with a curated environment and clamped timeout', async () => {
    const result = await service.runCode({ ...VALID_INPUT, timeout_seconds: 30 });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toBe('done');
      expect(result.stdout_truncated).toBe(false);
    }
    expect(driver.runs).toHaveLength(1);
    const params = driver.runs[0];
    expect(params).toBeDefined();
    if (params === undefined) {
      throw new Error('expected a recorded run');
    }
    expect(params.timeoutMs).toBe(30_000);
    expect(params.memoryMb).toBe(512);
    expect(params.diskMb).toBe(1024);
    expect(params.harvestGraceMs).toBe(2000);
    expect(params.signal).toBeInstanceOf(AbortSignal);
    // Curated env only — the host process env never passes through.
    expect(params.env).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: '/scratch',
      USER: 'sandbox',
      LOGNAME: 'sandbox',
      PIP_NO_INDEX: '1',
      npm_config_registry: 'http://127.0.0.1:1/',
    });
  });

  describe('sandbox identity', () => {
    const fsPromises: typeof import('node:fs/promises') = jest.requireActual('node:fs/promises');
    let chownSpy: jest.SpyInstance;
    let getuidSpy: jest.SpyInstance;
    let getgidSpy: jest.SpyInstance;

    beforeEach(() => {
      chownSpy = jest.spyOn(fsPromises, 'chown').mockResolvedValue(undefined);
      getuidSpy = jest.spyOn(process, 'getuid');
      getgidSpy = jest.spyOn(process, 'getgid');
    });

    afterEach(() => {
      chownSpy.mockRestore();
      getuidSpy.mockRestore();
      getgidSpy.mockRestore();
    });

    it('runs a non-root server as its own uid:gid without chowning anything', async () => {
      getuidSpy.mockReturnValue(4242);
      getgidSpy.mockReturnValue(4343);
      const result = await service.runCode(VALID_INPUT);
      expect(result.status).toBe('ok');
      expect(driver.runs[0]?.sandboxIdentity).toEqual({ uid: 4242, gid: 4343, chownRunDirs: false });
      expect(chownSpy).not.toHaveBeenCalled();
    });

    it('hands every staged dir and file to the image sandbox uid when the server is root', async () => {
      getuidSpy.mockReturnValue(0);
      getgidSpy.mockReturnValue(0);
      const result = await service.runCode({
        ...VALID_INPUT,
        files_in: [{ name: 'data.csv', content_base64: Buffer.from('a,b').toString('base64') }],
      });
      expect(result.status).toBe('ok');
      expect(driver.runs[0]?.sandboxIdentity).toEqual({ uid: 65532, gid: 65532, chownRunDirs: true });
      const chowned = chownSpy.mock.calls.map(call => ({
        name: basename(String(call[0])),
        uid: call[1],
        gid: call[2],
      }));
      expect(chowned.every(call => call.uid === 65532 && call.gid === 65532)).toBe(true);
      expect(chowned.map(call => call.name)).toEqual(
        expect.arrayContaining(['ingress', 'scratch', 'egress', 'data.csv', '__runcode_main.py']),
      );
    });

    it('refuses to run a non-root server in group 0', async () => {
      getuidSpy.mockReturnValue(4242);
      getgidSpy.mockReturnValue(0);
      const result = await service.runCode(VALID_INPUT);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/gid 0/);
      }
      expect(driver.runs).toHaveLength(0);
    });

    it('fails the run before the container starts when the root handoff fails', async () => {
      getuidSpy.mockReturnValue(0);
      getgidSpy.mockReturnValue(0);
      chownSpy.mockRejectedValue(new Error(`EPERM: operation not permitted, chown '${dataDir}/sandbox-runs/x'`));
      const result = await service.runCode(VALID_INPUT);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error_code).toBe('internal');
        expect(result.error).toMatch(/could not hand the run directories to sandbox uid 65532:65532/);
        expect(result.error).not.toContain(dataDir);
      }
      expect(driver.runs).toHaveLength(0);
      expect(await readdir(join(dataDir, 'sandbox-runs'))).toEqual([]);
    });
  });

  it('removes the run root even when the program stripped its own permissions', async () => {
    driver.runBehavior = async params => {
      await mkdir(join(params.scratchDir, 'locked', 'inner'), { recursive: true });
      await writeFile(join(params.scratchDir, 'locked', 'inner', 'f'), 'x');
      await mkdir(join(params.egressDir, 'sealed'));
      await writeFile(join(params.egressDir, 'sealed', 'g'), 'y');
      await chmod(join(params.scratchDir, 'locked', 'inner'), 0o000);
      await chmod(join(params.scratchDir, 'locked'), 0o000);
      await chmod(join(params.egressDir, 'sealed'), 0o000);
      return { ...OK_RESULT };
    };
    const result = await service.runCode(VALID_INPUT);
    expect(result.status).toBe('ok');
    expect(await readdir(join(dataDir, 'sandbox-runs'))).toEqual([]);
  });

  it('reports a completed non-zero exit verbatim as ok, not as an infra failure', async () => {
    driver.runBehavior = () => Promise.resolve({ ...OK_RESULT, exitCode: 3, stderr: 'traceback' });
    const result = await service.runCode(VALID_INPUT);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.exit_code).toBe(3);
      expect(result.stderr).toBe('traceback');
    }
  });

  it('maps driver terminations onto the error taxonomy', async () => {
    const cases: [DriverRunResult, string][] = [
      [{ ...OK_RESULT, terminatedBy: 'timeout', exitCode: -1 }, 'timeout'],
      [{ ...OK_RESULT, terminatedBy: 'oom', exitCode: 137 }, 'memory_exceeded'],
      [{ ...OK_RESULT, terminatedBy: 'killed', exitCode: 137 }, 'memory_exceeded'],
      [{ ...OK_RESULT, terminatedBy: 'killed', exitCode: -1 }, 'internal'],
      [{ ...OK_RESULT, terminatedBy: 'internal', exitCode: -1, internalError: 'boom' }, 'internal'],
      [
        {
          ...OK_RESULT,
          terminatedBy: 'internal',
          exitCode: -1,
          internalError: 'output_exceeded: stdout hit the 4 MiB transport bound',
        },
        'output_exceeded',
      ],
    ];
    for (const [driverResult, expectedCode] of cases) {
      driver.runBehavior = () => Promise.resolve(driverResult);
      const result = await service.runCode(VALID_INPUT);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error_code).toBe(expectedCode);
      }
    }
  });

  it('propagates driver harvest warnings (e.g. FC pull-before-kill grace)', async () => {
    driver.runBehavior = () =>
      Promise.resolve({
        ...OK_RESULT,
        harvestWarnings: ['pull-before-kill grace expired with zero bytes pulled'],
      });
    const result = await service.runCode(VALID_INPUT);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.harvest_warnings).toContain('pull-before-kill grace expired with zero bytes pulled');
    }
  });

  it('stages files_in and attachments into ingress with the program under a reserved name', async () => {
    const staged: Record<string, string> = {};
    driver.runBehavior = async params => {
      for (const name of ['data.csv', '__runcode_main.py', 'photo.png']) {
        staged[name] = await readFile(join(params.ingressDir, name), 'utf8');
      }
      return { ...OK_RESULT };
    };
    const csv = Buffer.from('a,b\n1,2\n').toString('base64');
    const result = await service.runCode(
      { ...VALID_INPUT, files_in: [{ name: 'data.csv', content_base64: csv }] },
      {
        signal: undefined,
        attachments: [{ name: 'photo.png', bytes: Buffer.from('img') }],
        onProgress: undefined,
        onHarvestedFiles: undefined,
      },
    );
    expect(result.status).toBe('ok');
    expect(staged['data.csv']).toBe('a,b\n1,2\n');
    expect(staged['__runcode_main.py']).toBe('print("hi")');
    expect(staged['photo.png']).toBe('img');
  });

  it('rejects non-canonical base64, reserved names, and attachment collisions', async () => {
    const canonical = Buffer.from('hello').toString('base64');
    // Unpadded base64 decodes but is not canonical.
    const unpadded = canonical.replace(/=+$/, '');
    for (const content of [unpadded, '!!!not-base64!!!']) {
      const result = await service.runCode({
        ...VALID_INPUT,
        files_in: [{ name: 'data.csv', content_base64: content }],
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error_code).toBe('invalid_input');
      }
    }
    const reserved = await service.runCode({
      ...VALID_INPUT,
      files_in: [{ name: '__runcode_evil.py', content_base64: canonical }],
    });
    if (reserved.status === 'failed') {
      expect(reserved.error_code).toBe('invalid_input');
    } else {
      throw new Error('expected reserved-name rejection');
    }
    const collision = await service.runCode(
      { ...VALID_INPUT, files_in: [{ name: 'photo.png', content_base64: canonical }] },
      {
        signal: undefined,
        attachments: [{ name: 'photo.png', bytes: Buffer.from('x') }],
        onProgress: undefined,
        onHarvestedFiles: undefined,
      },
    );
    if (collision.status === 'failed') {
      expect(collision.error_code).toBe('invalid_input');
    } else {
      throw new Error('expected attachment-collision rejection');
    }
    expect(driver.runs).toHaveLength(0);
  });

  it('harvests egress and scratch with warnings for skips, and egress wins collisions', async () => {
    driver.runBehavior = async params => {
      await writeFile(join(params.egressDir, 'report.csv'), 'a,b');
      await writeFile(join(params.egressDir, 'big.bin'), Buffer.alloc(26 * 1024 * 1024));
      await symlink(join(params.egressDir, 'report.csv'), join(params.egressDir, 'link.csv'));
      await mkdir(join(params.egressDir, 'sub'), { recursive: true });
      await writeFile(join(params.egressDir, 'sub', 'nested.txt'), 'nested');
      await writeFile(join(params.scratchDir, 'report.csv'), 'shadowed');
      await writeFile(join(params.scratchDir, 'debug.log'), 'log');
      return { ...OK_RESULT };
    };
    const result = await service.runCode(VALID_INPUT);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok');
    }
    const names = result.files_out.map(f => f.name).sort();
    expect(names).toEqual(['debug.log', 'report.csv']);
    const report = result.files_out.find(f => f.name === 'report.csv');
    expect(report?.sha256).toBe(createHash('sha256').update('a,b').digest('hex'));
    expect(report?.size_bytes).toBe(3);
    expect(result.harvest_warnings.join('\n')).toMatch(/exceeds the 25 MiB per-file cap/);
    expect(result.harvest_warnings.join('\n')).toMatch(/symlinks are not collected/);
    expect(result.harvest_warnings.join('\n')).toMatch(/only top-level files are collected/);
    expect(result.harvest_warnings.join('\n')).toMatch(/takes precedence/);
  });

  it('hands onHarvestedFiles the egress-winner bytes before run-root cleanup', async () => {
    driver.runBehavior = async params => {
      await writeFile(join(params.egressDir, 'report.csv'), 'egress-wins');
      await writeFile(join(params.scratchDir, 'report.csv'), 'shadowed');
      return { ...OK_RESULT };
    };
    let sinkFiles: HarvestedFile[] = [];
    let runRootsAtSinkTime: string[] = [];
    const result = await service.runCode(VALID_INPUT, {
      signal: undefined,
      attachments: undefined,
      onProgress: undefined,
      onHarvestedFiles: async files => {
        sinkFiles = files;
        // The sink must observe the run root before the finally-block cleanup deletes it.
        runRootsAtSinkTime = await readdir(join(dataDir, 'sandbox-runs'));
      },
    });
    expect(result.status).toBe('ok');
    // Egress wins the name collision: the sink gets the egress bytes, not the shadowed scratch copy.
    expect(sinkFiles.map(f => f.name)).toEqual(['report.csv']);
    expect(sinkFiles[0]?.bytes.toString()).toBe('egress-wins');
    expect(sinkFiles[0]?.sha256).toBe(createHash('sha256').update('egress-wins').digest('hex'));
    expect(runRootsAtSinkTime.length).toBeGreaterThan(0);
    // And the run root is gone afterwards: persistence happened before cleanup.
    const runRootsAfter = await readdir(join(dataDir, 'sandbox-runs'));
    expect(runRootsAfter).not.toContain(runRootsAtSinkTime[0]);
  });

  it('turns a throwing onHarvestedFiles into a harvest warning, not a failed run', async () => {
    driver.runBehavior = async params => {
      await writeFile(join(params.egressDir, 'report.csv'), 'a,b');
      return { ...OK_RESULT };
    };
    const result = await service.runCode(VALID_INPUT, {
      signal: undefined,
      attachments: undefined,
      onProgress: undefined,
      onHarvestedFiles: async () => {
        throw new Error('disk on fire');
      },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok');
    }
    expect(result.harvest_warnings.join('\n')).toMatch(/could not be saved for download/);
    expect(result.files_out.map(f => f.name)).toEqual(['report.csv']);
  });

  it('warns and continues when a file becomes unreadable between lstat and read (S3)', async () => {
    driver.runBehavior = async params => {
      await writeFile(join(params.egressDir, 'vanished.bin'), 'here-then-gone');
      await writeFile(join(params.egressDir, 'steady.txt'), 'steady');
      return { ...OK_RESULT };
    };
    // chmod is useless as root, so simulate the TOCTOU race by failing the
    // read itself. The service resolves readFile through the module registry
    // at call time, so the spy targets jest.requireActual's object — a
    // namespace import would only snapshot a per-module copy
    // (_interop_require_wildcard) and never intercept the service module.
    // requireActual is the jest API for this; raw require() is banned by the
    // repo's module rules.
    const fsPromises: typeof import('node:fs/promises') = jest.requireActual('node:fs/promises');
    const origReadFile = fsPromises.readFile;
    const spy = jest.spyOn(fsPromises, 'readFile');
    spy.mockImplementation((...args: Parameters<typeof fsPromises.readFile>) => {
      const [path] = args;
      if (typeof path === 'string' && basename(path) === 'vanished.bin') {
        return Promise.reject(new Error('ENOENT: vanished between lstat and read'));
      }
      return Reflect.apply(origReadFile, fsPromises, args);
    });
    try {
      const result = await service.runCode(VALID_INPUT);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        throw new Error('expected ok');
      }
      expect(result.files_out.map(f => f.name)).toEqual(['steady.txt']);
      expect(result.harvest_warnings.join('\n')).toMatch(/vanished\.bin.*could not be read/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('RunCodeService output truncation', () => {
  let dataDir: string;
  let driver: FakeDriver;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'runcode-trunc-'));
    driver = new FakeDriver();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('truncates per-stream output at the cap without splitting multi-byte chars', async () => {
    const service = new RunCodeService({
      driver,
      dataDir,
      defaultTimeoutSeconds: 120,
      maxTimeoutSeconds: 600,
      memoryMb: 512,
      diskMb: 1024,
      outputCapKb: 1,
      maxConcurrentRuns: 2,
      imagePullTimeoutSeconds: 120,
      harvestGraceMs: 2000,
      logger: makeSilentLogger(),
      now: undefined,
      sleepMs: () => new Promise<void>(resolve => setTimeout(resolve, 25)),
    });
    driver.runBehavior = () => Promise.resolve({ ...OK_RESULT, stdout: 'é'.repeat(2000), stderr: 'x'.repeat(10) });
    const result = await service.runCode(VALID_INPUT);
    await service.dispose().catch(() => undefined);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok');
    }
    expect(result.stdout_truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1024);
    expect(result.stdout).not.toContain('�');
    expect(result.stderr_truncated).toBe(false);
  });
});

describe('RunCodeService lifecycle', () => {
  let dataDir: string;
  let driver: FakeDriver;
  let service: RunCodeService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'runcode-life-'));
    driver = new FakeDriver();
    service = makeService(driver, dataDir);
  });

  afterEach(async () => {
    await service.dispose().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('coalesces concurrent provision calls onto one driver pull', async () => {
    let progress = 0;
    await Promise.all([
      service.provision({
        signal: undefined,
        onProgress: () => {
          progress += 1;
        },
      }),
      service.provision({ signal: undefined, onProgress: undefined }),
    ]);
    expect(driver.provisionCalls).toBe(1);
    expect(progress).toBe(1);
  });

  it('fans provision progress out to every coalesced caller', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    driver.provision = (input: {
      signal: AbortSignal | undefined;
      onProgress: (message: string) => void;
      timeoutSeconds: number;
    }): Promise<void> =>
      gate.then(() => {
        input.onProgress('layer 1/2');
        input.onProgress('layer 2/2');
      });
    const seenA: string[] = [];
    const seenB: string[] = [];
    const pending = Promise.all([
      service.provision({ signal: undefined, onProgress: m => seenA.push(m) }),
      service.provision({ signal: undefined, onProgress: m => seenB.push(m) }),
    ]);
    // Let both callers join the shared pull before it emits progress.
    await new Promise(resolve => setTimeout(resolve, 25));
    release();
    await pending;
    expect(seenA).toEqual(['layer 1/2', 'layer 2/2']);
    expect(seenB).toEqual(['layer 1/2', 'layer 2/2']);
  });

  it('keeps the shared pull alive when one coalesced caller aborts', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let aborted = false;
    driver.provision = (input: {
      signal: AbortSignal | undefined;
      onProgress: (message: string) => void;
      timeoutSeconds: number;
    }): Promise<void> => {
      input.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return gate;
    };
    const controllerA = new AbortController();
    const pendingA = service.provision({ signal: controllerA.signal, onProgress: undefined });
    const pendingB = service.provision({ signal: undefined, onProgress: undefined });
    await new Promise(resolve => setTimeout(resolve, 25));
    controllerA.abort();
    await new Promise(resolve => setTimeout(resolve, 25));
    // A left, but B is still waiting: the pull must not have been aborted.
    expect(aborted).toBe(false);
    release();
    await expect(pendingA).resolves.toBeUndefined();
    await expect(pendingB).resolves.toBeUndefined();
  });

  it('aborts the shared pull when every coalesced caller has left', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let aborted = false;
    driver.provision = (input: {
      signal: AbortSignal | undefined;
      onProgress: (message: string) => void;
      timeoutSeconds: number;
    }): Promise<void> => {
      input.signal?.addEventListener('abort', () => {
        aborted = true;
        release();
      });
      return gate;
    };
    const controller = new AbortController();
    const pending = service.provision({ signal: controller.signal, onProgress: undefined });
    await new Promise(resolve => setTimeout(resolve, 25));
    controller.abort();
    await pending;
    expect(aborted).toBe(true);
  });

  it('passes readiness through and exposes the driver kind', async () => {
    expect(service.driverKind).toBe('docker');
    await expect(service.ensureReady()).resolves.toEqual({ ready: true });
  });

  it('reaps stale run dirs and delegates VM/container reaping to the driver', async () => {
    const parent = join(dataDir, 'sandbox-runs');
    await mkdir(parent, { recursive: true });
    const oldDir = join(parent, 'oldrun');
    const newDir = join(parent, 'newrun');
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await utimes(oldDir, twoHoursAgo, twoHoursAgo);
    await service.reap();
    await expect(readFile(join(parent, 'oldrun', 'x'), 'utf8')).rejects.toThrow();
    await expect(readdir(newDir)).resolves.toEqual([]);
    expect(driver.reaped).toBe(1);
  });

  it('dispose releases driver resources', async () => {
    await service.dispose();
    expect(driver.disposed).toBe(true);
  });

  it('E1: startReaper is idempotent — one timer no matter how many calls', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const callsBefore = spy.mock.calls.length;
    service.startReaper();
    service.startReaper();
    service.startReaper();
    expect(spy.mock.calls.length).toBe(callsBefore + 1);
    spy.mockRestore();
  });

  it('E3: caches successful readiness for 60s', async () => {
    let nowMs = 1_000_000;
    let ensureReadyCalls = 0;
    const counting = new FakeDriver();
    const orig = counting.ensureReady.bind(counting);
    counting.ensureReady = async () => {
      ensureReadyCalls += 1;
      return orig();
    };
    const svc = makeService(counting, dataDir, () => nowMs);
    try {
      await svc.runCode(VALID_INPUT);
      await svc.runCode(VALID_INPUT);
      expect(ensureReadyCalls).toBe(1);
      nowMs += 61_000;
      await svc.runCode(VALID_INPUT);
      expect(ensureReadyCalls).toBe(2);
    } finally {
      await svc.dispose().catch(() => undefined);
    }
  });

  it('E3: coalesces concurrent readiness probes onto one driver call', async () => {
    let nowMs = 1_000_000;
    let ensureReadyCalls = 0;
    let release!: () => void;
    const gate = new Promise<DriverReadiness>(resolve => {
      release = () => resolve({ ready: true });
    });
    const gated = new FakeDriver();
    gated.ensureReady = async () => {
      ensureReadyCalls += 1;
      return gate;
    };
    const svc = makeService(gated, dataDir, () => nowMs);
    try {
      const first = svc.runCode(VALID_INPUT);
      const second = svc.runCode(VALID_INPUT);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(ensureReadyCalls).toBe(1);
      release();
      await Promise.all([first, second]);
      expect(ensureReadyCalls).toBe(1);
    } finally {
      await svc.dispose().catch(() => undefined);
    }
  });

  it('E3: a failed probe is not cached — the next call re-probes', async () => {
    let nowMs = 1_000_000;
    let ensureReadyCalls = 0;
    const flaky = new FakeDriver();
    flaky.ensureReady = async () => {
      ensureReadyCalls += 1;
      return ensureReadyCalls === 1
        ? { ready: false, error_code: 'daemon_unavailable' as const, error: 'down' }
        : { ready: true };
    };
    const svc = makeService(flaky, dataDir, () => nowMs);
    try {
      const first = await svc.runCode(VALID_INPUT);
      expect(first.status).toBe('failed');
      const second = await svc.runCode(VALID_INPUT);
      expect(second.status).toBe('ok');
      expect(ensureReadyCalls).toBe(2);
    } finally {
      await svc.dispose().catch(() => undefined);
    }
  });
});

describe('validateRunCodeStartupConfig', () => {
  const base = {
    networkEgress: false,
    isolationDriver: 'docker' as const,
    platform: 'linux' as NodeJS.Platform,
    image: `sandbox:1.0.0@sha256:${'a'.repeat(64)}`,
    imageConfigured: true,
    imagePullTimeoutSeconds: 120,
    defaultTimeoutSeconds: 120,
    maxTimeoutSeconds: 600,
    memoryMb: 512,
    diskMb: 1024,
    outputCapKb: 256,
    runCodeToolCallTimeoutMs: 800_000 as number | undefined,
    serverExecutionTimeoutSeconds: 900 as number | undefined,
  };

  it('accepts a valid config', () => {
    expect(() => {
      validateRunCodeStartupConfig(base);
    }).not.toThrow();
  });

  it('refuses to start when network_egress is true (reserved, fail closed)', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, networkEgress: true });
    }).toThrow(/network_egress/);
  });

  it('rejects firecracker on darwin', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, isolationDriver: 'firecracker', platform: 'darwin' });
    }).toThrow(/Linux\+KVM/);
  });

  it('refuses firecracker on linux: driver not implemented in this build', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, isolationDriver: 'firecracker', platform: 'linux' });
    }).toThrow(/not implemented in this build/);
  });

  it('rejects an image that is not a pinned digest reference', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, image: 'sandbox:latest' });
    }).toThrow(/pinned digest reference/);
  });

  it('rejects non-positive bounds', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, memoryMb: 0 });
    }).toThrow(/memory_mb/);
  });

  it('rejects default_timeout_seconds above max_timeout_seconds', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, defaultTimeoutSeconds: 900 });
    }).toThrow(/exceeds sandbox.max_timeout_seconds/);
  });

  it('rejects a run_code tool-call timeout below pull + run budget', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, runCodeToolCallTimeoutMs: 1000 });
    }).toThrow(/below image_pull_timeout_seconds/);
  });

  it('allows an absent run_code tool-call timeout', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, runCodeToolCallTimeoutMs: undefined });
    }).not.toThrow();
  });

  it('E4: rejects a turn deadline below the run_code tool-call timeout', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, serverExecutionTimeoutSeconds: 60 });
    }).toThrow(/SERVER_EXECUTION_TIMEOUT_SECONDS/);
  });

  it('E4: allows an absent turn deadline', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, serverExecutionTimeoutSeconds: undefined });
    }).not.toThrow();
  });

  it('S2: dormant installs (blank image) boot without a digest pin or pull-sized timeout', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, image: '', imageConfigured: false, runCodeToolCallTimeoutMs: 1000 });
    }).not.toThrow();
  });

  it('S2: dormant installs still fail closed on bad numeric bounds', () => {
    expect(() => {
      validateRunCodeStartupConfig({ ...base, image: '', imageConfigured: false, memoryMb: 0 });
    }).toThrow(/memory_mb/);
  });

  it('S2: a non-blank image without imageConfigured still skips the pin check', () => {
    // imageConfigured is the single source of truth for "configured"; the
    // string content alone does not opt in.
    expect(() => {
      validateRunCodeStartupConfig({ ...base, image: 'sandbox:latest', imageConfigured: false });
    }).not.toThrow();
  });
});

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  measureRunDiskUsage,
  resolveSandboxIdentity,
  SANDBOX_RUN_ENV,
  sandboxRunsDir,
  stageRunDirs,
} from '../../../../src/core/sandbox/driver/RunStaging';

describe('resolveSandboxIdentity', () => {
  let getuidSpy: jest.SpyInstance;
  let getgidSpy: jest.SpyInstance;

  beforeEach(() => {
    getuidSpy = jest.spyOn(process, 'getuid');
    getgidSpy = jest.spyOn(process, 'getgid');
  });

  afterEach(() => {
    getuidSpy.mockRestore();
    getgidSpy.mockRestore();
  });

  it('runs a non-root server as its own numeric uid:gid with no handoff', () => {
    getuidSpy.mockReturnValue(1000);
    getgidSpy.mockReturnValue(1001);
    expect(resolveSandboxIdentity()).toEqual({ uid: 1000, gid: 1001, chownRunDirs: false });
  });

  it('keeps the image sandbox uid and requires the handoff when the server is root', () => {
    getuidSpy.mockReturnValue(0);
    getgidSpy.mockReturnValue(0);
    expect(resolveSandboxIdentity()).toEqual({ uid: 65532, gid: 65532, chownRunDirs: true });
  });

  it('refuses a non-root server whose gid is 0', () => {
    getuidSpy.mockReturnValue(1000);
    getgidSpy.mockReturnValue(0);
    expect(() => resolveSandboxIdentity()).toThrow(/gid 0/);
  });

  it('takes the root path when the platform has no uid', () => {
    getuidSpy.mockReturnValue(undefined);
    expect(resolveSandboxIdentity()).toEqual({ uid: 65532, gid: 65532, chownRunDirs: true });
  });

  it('never resolves to root', () => {
    for (const uid of [0, 1, 1000, 65532]) {
      getuidSpy.mockReturnValue(uid);
      getgidSpy.mockReturnValue(uid);
      expect(resolveSandboxIdentity().uid).not.toBe(0);
    }
  });
});

describe('SANDBOX_RUN_ENV', () => {
  it('names the user because getpwuid fails for an uid missing from the image', () => {
    expect(SANDBOX_RUN_ENV['USER']).toBe('sandbox');
    expect(SANDBOX_RUN_ENV['LOGNAME']).toBe('sandbox');
  });

  it('is a fixed set of variables, never derived from the host env', () => {
    expect(Object.keys(SANDBOX_RUN_ENV).sort()).toEqual(
      ['HOME', 'LANG', 'LOGNAME', 'PATH', 'PIP_NO_INDEX', 'USER', 'npm_config_registry'].sort(),
    );
  });
});

describe('sandboxRunsDir', () => {
  it('sits under the data dir', () => {
    expect(sandboxRunsDir('/data')).toBe('/data/sandbox-runs');
  });
});

describe('stageRunDirs', () => {
  const fsPromises: typeof import('node:fs/promises') = jest.requireActual('node:fs/promises');
  let root: string;
  let chownSpy: jest.SpyInstance;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'run-staging-'));
    chownSpy = jest.spyOn(fsPromises, 'chown').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    chownSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  const stage = (identity: { uid: number; gid: number; chownRunDirs: boolean }) =>
    stageRunDirs({
      runRoot: join(root, 'run-1'),
      language: 'python',
      code: 'print(1)',
      files: [{ name: 'in.csv', bytes: Buffer.from('a,b') }],
      identity,
    });

  it('creates 0700 dirs and stages inputs and the program as 0400 files', async () => {
    const dirs = await stage({ uid: 1000, gid: 1000, chownRunDirs: false });
    for (const dir of [dirs.ingressDir, dirs.scratchDir, dirs.egressDir]) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
    for (const name of ['in.csv', '__runcode_main.py']) {
      expect((await stat(join(dirs.ingressDir, name))).mode & 0o777).toBe(0o400);
    }
    expect(await readFile(join(dirs.ingressDir, 'in.csv'), 'utf8')).toBe('a,b');
    expect(await readFile(join(dirs.ingressDir, '__runcode_main.py'), 'utf8')).toBe('print(1)');
  });

  it('names the node program with the .mjs extension', async () => {
    const dirs = await stageRunDirs({
      runRoot: join(root, 'run-node'),
      language: 'node',
      code: 'console.log(1)',
      files: [],
      identity: { uid: 1000, gid: 1000, chownRunDirs: false },
    });
    expect((await stat(join(dirs.ingressDir, '__runcode_main.mjs'))).isFile()).toBe(true);
  });

  it('does not chown when the container runs as the server', async () => {
    await stage({ uid: 1000, gid: 1000, chownRunDirs: false });
    expect(chownSpy).not.toHaveBeenCalled();
  });

  it('hands every dir and staged file to the sandbox uid, including nested entries', async () => {
    await mkdir(join(root, 'run-1', 'scratch', 'seed'), { recursive: true });
    await writeFile(join(root, 'run-1', 'scratch', 'seed', 'nested.txt'), 'x');
    const dirs = await stage({ uid: 65532, gid: 65532, chownRunDirs: true });
    const chowned = chownSpy.mock.calls.map(call => ({ path: String(call[0]), uid: call[1], gid: call[2] }));
    expect(chowned.every(call => call.uid === 65532 && call.gid === 65532)).toBe(true);
    expect(chowned.map(call => call.path).sort()).toEqual(
      [
        dirs.ingressDir,
        join(dirs.ingressDir, '__runcode_main.py'),
        join(dirs.ingressDir, 'in.csv'),
        dirs.scratchDir,
        join(dirs.scratchDir, 'seed'),
        join(dirs.scratchDir, 'seed', 'nested.txt'),
        dirs.egressDir,
      ].sort(),
    );
  });

  it('throws with the original failure as the cause when the handoff fails', async () => {
    const failure = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    chownSpy.mockRejectedValue(failure);
    const staged = stage({ uid: 65532, gid: 65532, chownRunDirs: true });
    await expect(staged).rejects.toThrow(/could not hand the run directories to sandbox uid 65532:65532: EPERM/);
    await expect(staged).rejects.toHaveProperty('cause', failure);
  });
});

describe('measureRunDiskUsage', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'run-du-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('sums scratch and egress including nested files', async () => {
    const scratchDir = join(root, 'scratch');
    const egressDir = join(root, 'egress');
    await mkdir(join(scratchDir, 'sub'), { recursive: true });
    await mkdir(egressDir);
    await writeFile(join(scratchDir, 'sub', 'f'), Buffer.alloc(4096));
    await writeFile(join(egressDir, 'out'), Buffer.alloc(2048));
    const bytes = await measureRunDiskUsage({ scratchDir, egressDir });
    expect(bytes).toBeGreaterThanOrEqual(6144);
  });

  it('is undefined when a dir cannot be read, so callers fail closed', async () => {
    const egressDir = join(root, 'egress');
    await mkdir(egressDir);
    await expect(measureRunDiskUsage({ scratchDir: join(root, 'missing'), egressDir })).resolves.toBeUndefined();
  });
});

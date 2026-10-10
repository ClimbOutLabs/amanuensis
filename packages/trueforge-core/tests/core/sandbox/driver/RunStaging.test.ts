import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  measureRunDiskUsage,
  removeRunTree,
  resolveSandboxIdentity,
  SANDBOX_RUN_ENV,
  sandboxRunsDir,
  stageRunDirs,
} from '../../../../src/core/sandbox/driver/RunStaging';

describe('resolveSandboxIdentity', () => {
  let geteuidSpy: jest.SpyInstance;
  let getegidSpy: jest.SpyInstance;

  beforeEach(() => {
    geteuidSpy = jest.spyOn(process, 'geteuid');
    getegidSpy = jest.spyOn(process, 'getegid');
  });

  afterEach(() => {
    geteuidSpy.mockRestore();
    getegidSpy.mockRestore();
  });

  it('runs a non-root server as its own numeric uid:gid with no handoff', () => {
    geteuidSpy.mockReturnValue(1000);
    getegidSpy.mockReturnValue(1001);
    expect(resolveSandboxIdentity()).toEqual({ uid: 1000, gid: 1001, chownRunDirs: false });
  });

  it('keeps the image sandbox uid and requires the handoff when the server is root', () => {
    geteuidSpy.mockReturnValue(0);
    getegidSpy.mockReturnValue(0);
    expect(resolveSandboxIdentity()).toEqual({ uid: 65532, gid: 65532, chownRunDirs: true });
  });

  it('refuses a non-root server whose gid is 0', () => {
    geteuidSpy.mockReturnValue(1000);
    getegidSpy.mockReturnValue(0);
    expect(() => resolveSandboxIdentity()).toThrow(/gid 0/);
  });

  it('takes the root path when the platform has no uid', () => {
    geteuidSpy.mockReturnValue(undefined);
    expect(resolveSandboxIdentity()).toEqual({ uid: 65532, gid: 65532, chownRunDirs: true });
  });

  it('goes by the effective ids, not the real ones a setuid launch leaves behind', () => {
    const getuidSpy = jest.spyOn(process, 'getuid').mockReturnValue(0);
    const getgidSpy = jest.spyOn(process, 'getgid').mockReturnValue(0);
    try {
      geteuidSpy.mockReturnValue(1000);
      getegidSpy.mockReturnValue(1001);
      expect(resolveSandboxIdentity()).toEqual({ uid: 1000, gid: 1001, chownRunDirs: false });
      geteuidSpy.mockReturnValue(0);
      getegidSpy.mockReturnValue(0);
      getuidSpy.mockReturnValue(1000);
      getgidSpy.mockReturnValue(1001);
      expect(resolveSandboxIdentity()).toEqual({ uid: 65532, gid: 65532, chownRunDirs: true });
    } finally {
      getuidSpy.mockRestore();
      getgidSpy.mockRestore();
    }
  });

  it('never resolves to root', () => {
    for (const uid of [0, 1, 1000, 65532]) {
      geteuidSpy.mockReturnValue(uid);
      getegidSpy.mockReturnValue(uid);
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

describe('removeRunTree', () => {
  const fsPromises: typeof import('node:fs/promises') = jest.requireActual('node:fs/promises');
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'run-rm-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('removes a tree whose dirs and files the sandbox stripped of permissions', async () => {
    const runRoot = join(root, 'run');
    await mkdir(join(runRoot, 'scratch', 'locked', 'deeper'), { recursive: true });
    await writeFile(join(runRoot, 'scratch', 'locked', 'deeper', 'f'), 'x');
    await writeFile(join(runRoot, 'egress', 'no-access'), 'y').catch(async () => {
      await mkdir(join(runRoot, 'egress'));
      await writeFile(join(runRoot, 'egress', 'no-access'), 'y');
    });
    await chmod(join(runRoot, 'scratch', 'locked', 'deeper'), 0o000);
    await chmod(join(runRoot, 'scratch', 'locked'), 0o000);
    await chmod(join(runRoot, 'egress', 'no-access'), 0o000);
    await chmod(join(runRoot, 'egress'), 0o500);

    await removeRunTree({ runRoot, runStopped: true });

    await expect(stat(runRoot)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('gives the owner access back to dirs and files once the run is stopped', async () => {
    const runRoot = join(root, 'run');
    await mkdir(join(runRoot, 'locked'), { recursive: true });
    await writeFile(join(runRoot, 'locked', 'f'), 'x');
    await chmod(join(runRoot, 'locked', 'f'), 0o000);
    await chmod(join(runRoot, 'locked'), 0o000);
    const chmodSpy = jest.spyOn(fsPromises, 'chmod');

    await removeRunTree({ runRoot, runStopped: true });

    expect(chmodSpy).toHaveBeenCalledWith(join(runRoot, 'locked'), 0o700);
    expect(chmodSpy).toHaveBeenCalledWith(join(runRoot, 'locked', 'f'), 0o600);
  });

  it('leaves permissions alone while the run may still be alive', async () => {
    const runRoot = join(root, 'run');
    await mkdir(join(runRoot, 'locked'), { recursive: true });
    await writeFile(join(runRoot, 'locked', 'f'), 'x');
    const chmodSpy = jest.spyOn(fsPromises, 'chmod');

    await removeRunTree({ runRoot, runStopped: false });

    expect(chmodSpy).not.toHaveBeenCalled();
    await expect(stat(runRoot)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('never follows a symlink out of the run tree', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep'), 'z');
    await chmod(join(outside, 'keep'), 0o400);
    await chmod(outside, 0o500);
    const runRoot = join(root, 'run');
    await mkdir(runRoot);
    await symlink(outside, join(runRoot, 'link'));

    await removeRunTree({ runRoot, runStopped: true });

    await expect(stat(runRoot)).rejects.toHaveProperty('code', 'ENOENT');
    expect((await stat(outside)).mode & 0o777).toBe(0o500);
    expect((await stat(join(outside, 'keep'))).mode & 0o777).toBe(0o400);
    await chmod(outside, 0o700);
  });

  describe('when an entry is swapped for another between the check and its use', () => {
    const swappedFor = async (target: string) => {
      const outside = join(root, 'outside');
      await mkdir(outside);
      await symlink(outside, target);
      return { outside, linkStats: await fsPromises.lstat(target) };
    };

    /** The first lstat of `path` sees the real entry; every later one sees `after`. */
    const swapAfterFirstLstat = (input: { path: string; after: Awaited<ReturnType<typeof fsPromises.lstat>> }) => {
      let seen = 0;
      const realLstat = fsPromises.lstat;
      jest.spyOn(fsPromises, 'lstat').mockImplementation(async path => {
        if (path === input.path) {
          seen += 1;
          if (seen > 1) {
            return input.after;
          }
        }
        return realLstat(path);
      });
    };

    it('does not chmod a file that became a symlink', async () => {
      const runRoot = join(root, 'run');
      await mkdir(runRoot);
      const file = join(runRoot, 'f');
      await writeFile(file, 'x');
      const { linkStats } = await swappedFor(join(root, 'link'));
      swapAfterFirstLstat({ path: file, after: linkStats });
      const chmodSpy = jest.spyOn(fsPromises, 'chmod');

      await removeRunTree({ runRoot, runStopped: true });

      expect(chmodSpy).not.toHaveBeenCalledWith(file, expect.anything());
    });

    it('does not chmod or list a dir that became a symlink', async () => {
      const runRoot = join(root, 'run');
      const dir = join(runRoot, 'd');
      await mkdir(dir, { recursive: true });
      const { linkStats } = await swappedFor(join(root, 'link'));
      swapAfterFirstLstat({ path: dir, after: linkStats });
      const chmodSpy = jest.spyOn(fsPromises, 'chmod');
      const readdirSpy = jest.spyOn(fsPromises, 'readdir');

      await removeRunTree({ runRoot, runStopped: true });

      expect(chmodSpy).not.toHaveBeenCalledWith(dir, expect.anything());
      expect(readdirSpy).not.toHaveBeenCalledWith(dir);
    });

    it('does not chmod a file replaced by a different file', async () => {
      const runRoot = join(root, 'run');
      await mkdir(runRoot);
      const file = join(runRoot, 'f');
      const other = join(root, 'other');
      await writeFile(file, 'x');
      await writeFile(other, 'y');
      swapAfterFirstLstat({ path: file, after: await fsPromises.lstat(other) });
      const chmodSpy = jest.spyOn(fsPromises, 'chmod');

      await removeRunTree({ runRoot, runStopped: true });

      expect(chmodSpy).not.toHaveBeenCalledWith(file, expect.anything());
    });
  });

  it('is a no-op for a root that does not exist', async () => {
    await expect(removeRunTree({ runRoot: join(root, 'missing'), runStopped: true })).resolves.toBeUndefined();
  });
});

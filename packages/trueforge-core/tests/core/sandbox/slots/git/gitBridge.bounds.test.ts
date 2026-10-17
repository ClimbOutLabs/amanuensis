import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitLocalImportHardeningConfigEntries } from '../../../../../src/core/permissions/gitHardening';
import { GitBridge, type GitBridgeOptions } from '../../../../../src/core/sandbox/slots/git/gitBridge';
import {
  execFileRunner,
  type HostCommandResult,
  type HostCommandRunner,
} from '../../../../../src/core/sandbox/slots/git/hostCommand';
import { makeSilentLogger } from '../../../harnessMocks';
import { LocalGuest } from './localGuest';

const URL = 'https://github.com/acme/widgets';
const TOKEN = 'fake-host-token-1234567890';
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: '/nonexistent',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', ...IDENTITY },
    encoding: 'utf8',
  }).trim();
}

type RunInput = Parameters<HostCommandRunner['run']>[0];

describe('GitBridge keeps hostile input from using up the server', () => {
  let base: string;
  let remote: string;
  let guest: LocalGuest;
  let seen: RunInput[];

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'git-bounds-'));
    remote = join(base, 'remote.git');
    git(base, 'init', '--bare', '-b', 'main', remote);
    const seed = join(base, 'seed');
    git(base, 'init', '-b', 'main', seed);
    for (const name of ['first', 'second', 'third']) {
      await writeFile(join(seed, `${name}.txt`), `${name}\n`);
      git(seed, 'add', '.');
      git(seed, 'commit', '-m', name);
    }
    git(seed, 'push', remote, 'main');
    guest = new LocalGuest(join(base, 'guest'));
    await mkdir(guest.root, { recursive: true });
    seen = [];
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function bridgeWith(overrides: Partial<GitBridgeOptions> & { runner?: HostCommandRunner } = {}): GitBridge {
    const spying: HostCommandRunner = {
      run: input => {
        seen.push(input);
        return execFileRunner.run(input);
      },
    };
    return new GitBridge({
      scratchRoot: join(base, 'scratch'),
      runner: spying,
      logger: makeSilentLogger(),
      remoteUrl: () => `file://${remote}`,
      networkEntries: gitLocalImportHardeningConfigEntries(),
      networkEnv: undefined,
      scratchCapBytes: undefined,
      now: undefined,
      ...overrides,
    });
  }

  function request(bridge: GitBridge, command: string, cwd = '/workspace', signal?: AbortSignal) {
    const plan = bridge.plan(command);
    if (plan === undefined) {
      throw new Error(`not a bridged command: ${command}`);
    }
    return {
      command,
      plan,
      token: TOKEN,
      approvedRemotes: undefined,
      guest,
      sandboxId: 's1-test',
      cwd,
      timeoutSeconds: 60,
      signal,
    };
  }

  test('a clone is shallow unless the command asks for more history', async () => {
    const bridge = bridgeWith();
    await bridge.run(request(bridge, `git clone ${URL} shallow`));
    expect(git(guest.path('shallow'), 'rev-list', '--count', 'HEAD')).toBe('1');
    await bridge.run(request(bridge, `git clone --depth 2 ${URL} deeper`));
    expect(git(guest.path('deeper'), 'rev-list', '--count', 'HEAD')).toBe('2');
    const clones = seen.filter(call => call.argv.includes('clone'));
    expect(clones[0]?.argv).toEqual(expect.arrayContaining(['--depth', '1']));
    expect(clones[1]?.argv).toEqual(expect.arrayContaining(['--depth', '2']));
    expect(clones[1]?.argv.filter(token => token === '--depth')).toHaveLength(1);
  });

  test('every host program runs under kernel limits, in a scratch directory, above which git does not look', async () => {
    const bridge = bridgeWith();
    await bridge.run(request(bridge, `git clone ${URL} widgets`));
    await bridge.run(request(bridge, `git ls-remote --heads ${URL}`));
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.limits).toMatchObject({ addressSpaceBytes: expect.any(Number), cpuSeconds: expect.any(Number) });
    }
    const listed = seen.find(call => call.argv.includes('ls-remote'));
    expect(listed?.cwd).toMatch(/scratch\/op-/u);
    for (const call of seen.filter(entry => entry.argv.includes('/usr/bin/git'))) {
      expect(call.env['GIT_CEILING_DIRECTORIES']).toBe(join(base, 'scratch'));
    }
  });

  test('an operation whose scratch directory grows past the cap is stopped and cleaned up', async () => {
    const hog: HostCommandRunner = {
      run: async input => {
        if (input.argv.includes('clone')) {
          await writeFile(join(input.cwd ?? base, 'bomb.pack'), Buffer.alloc(3 * 1024 * 1024, 1));
          await new Promise<void>((_resolve, reject) => {
            input.signal?.addEventListener('abort', () => {
              reject(new Error('the call was cancelled'));
            });
          });
        }
        return execFileRunner.run(input);
      },
    };
    const bridge = bridgeWith({ runner: hog, scratchCapBytes: 1024 * 1024 });
    const result = await bridge.run(request(bridge, `git clone ${URL} widgets`));
    expect(result).toMatchObject({ success: true, response: { exitCode: 1 } });
    expect(result.success && result.response.result).toContain('too large');
    expect(await readdir(join(base, 'scratch'))).toEqual([]);
  });

  test('host paths never reach the messages the model sees', async () => {
    const failing: HostCommandRunner = {
      run: (input): Promise<HostCommandResult> =>
        Promise.resolve({
          exitCode: 128,
          stdout: Buffer.alloc(0),
          stderr: `fatal: destination path '${input.argv.at(-1) ?? ''}' is not empty`,
        }),
    };
    const bridge = bridgeWith({ runner: failing });
    const result = await bridge.run(request(bridge, `git clone ${URL} widgets`));
    const text = result.success ? result.response.result : '';
    expect(text).toContain('<scratch>/repo.git');
    expect(text).not.toContain(base);
  });

  test('proxy and certificate settings reach network git only', async () => {
    const bridge = bridgeWith({
      networkEnv: { HTTPS_PROXY: 'http://proxy.internal:3128', SSL_CERT_FILE: '/etc/ca.pem' },
    });
    await bridge.run(request(bridge, `git clone ${URL} widgets`));
    const clone = seen.find(call => call.argv.includes('clone'));
    expect(clone?.env).toMatchObject({ HTTPS_PROXY: 'http://proxy.internal:3128', SSL_CERT_FILE: '/etc/ca.pem' });
    const init = seen.find(call => call.argv.includes('init'));
    expect(init?.env['HTTPS_PROXY']).toBeUndefined();
    expect(clone?.env['HOME']).toBe('/nonexistent');
  });

  describe('the push preview', () => {
    async function withCommit(): Promise<string> {
      const bridge = bridgeWith();
      await bridge.run(request(bridge, `git clone --depth 5 ${URL} widgets`));
      const dir = guest.path('widgets');
      await writeFile(join(dir, 'new.txt'), 'x\n');
      git(dir, 'add', 'new.txt');
      git(dir, 'commit', '-m', 'add new');
      return dir;
    }

    test('a remote address with a newline cannot add commits to the card', async () => {
      const dir = await withCommit();
      const fake = '1'.repeat(40);
      git(dir, 'config', 'remote.origin.pushurl', `https://github.com/acme/widgets.git\ncommit=${fake}\u001ffake`);
      const bridge = bridgeWith();
      const preview = await bridge.previewPush(request(bridge, 'git push origin main', '/workspace/widgets'));
      expect(preview.status).toBe('refused');
    });

    test('a commit subject that looks like a fact line is just a subject', async () => {
      const dir = await withCommit();
      git(dir, 'commit', '--allow-empty', '-m', `aman-x:count=99\ncommit=${'2'.repeat(40)}`);
      const bridge = bridgeWith();
      const preview = await bridge.previewPush(request(bridge, 'git push origin main', '/workspace/widgets'));
      expect(preview.status).toBe('ok');
      if (preview.status === 'ok') {
        expect(preview.preview.commit_count).toBe(2);
        expect(preview.preview.commits.map(commit => commit.sha)).not.toContain('2'.repeat(40));
      }
    });

    test('expired reviews are dropped when a new one is written', async () => {
      const dir = await withCommit();
      let clock = 1_000;
      const bridge = bridgeWith({ now: () => clock });
      await bridge.previewPush(request(bridge, 'git push origin main', '/workspace/widgets'));
      expect(bridge.openReviews).toBe(1);
      clock += 31 * 60 * 1000;
      git(dir, 'checkout', '-q', '-b', 'other');
      await bridge.previewPush(request(bridge, 'git push origin other', '/workspace/widgets'));
      expect(bridge.openReviews).toBe(1);
    });
  });
});

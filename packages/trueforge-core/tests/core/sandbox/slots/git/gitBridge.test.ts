import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitLocalImportHardeningConfigEntries } from '../../../../../src/core/permissions/gitHardening';
import type { GitRemotePrecondition } from '../../../../../src/core/sandbox/gitRemoteObservation';
import type { HostAuthenticatedGitPlan } from '../../../../../src/core/sandbox/hostAuthenticatedGit';
import { GitBridge } from '../../../../../src/core/sandbox/slots/git/gitBridge';
import { execFileRunner, type HostCommandRunner } from '../../../../../src/core/sandbox/slots/git/hostCommand';
import { makeSilentLogger } from '../../../harnessMocks';
import { LocalGuest } from './localGuest';

const URL = 'https://github.com/acme/widgets';
const TOKEN = 'fake-host-token-1234567890';
const APPROVED_ORIGIN: GitRemotePrecondition = {
  remotes: [{ name: 'origin', url: `${URL}.git` }],
  summary: `This uses origin, which is ${URL}.git. Your GitHub sign-in is only offered to this repository.`,
};
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: '/nonexistent',
};

/** The GitHub addresses a host git process would offer the token to. */
function credentialScopes(env: Readonly<Record<string, string>>): string[] {
  return Object.values(env).flatMap(value => {
    const scoped = /^credential\.(https:\/\/github\.com\/.+)\.helper$/u.exec(value);
    return scoped?.[1] === undefined ? [] : [scoped[1]];
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', ...IDENTITY },
    encoding: 'utf8',
  }).trim();
}

describe('GitBridge (real git on both sides)', () => {
  let base: string;
  let remote: string;
  let guest: LocalGuest;
  let calls: {
    argv: readonly string[];
    env: Readonly<Record<string, string>>;
    cwd: string | undefined;
    limits: unknown;
  }[];
  let bridge: GitBridge;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'git-bridge-'));
    remote = join(base, 'remote.git');
    git(base, 'init', '--bare', '-b', 'main', remote);
    const seed = join(base, 'seed');
    git(base, 'init', '-b', 'main', seed);
    await writeFile(join(seed, 'README.md'), 'hello\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'first');
    await writeFile(join(seed, 'two.txt'), '2\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'second');
    git(seed, 'push', remote, 'main');
    guest = new LocalGuest(join(base, 'guest'));
    await mkdir(guest.root, { recursive: true });
    calls = [];
    const spying: HostCommandRunner = {
      run: input => {
        calls.push({ argv: input.argv, env: input.env, cwd: input.cwd, limits: input.limits });
        return execFileRunner.run(input);
      },
    };
    bridge = new GitBridge({
      scratchRoot: join(base, 'scratch'),
      runner: spying,
      logger: makeSilentLogger(),
      remoteUrl: () => `file://${remote}`,
      networkEntries: gitLocalImportHardeningConfigEntries(),
      networkEnv: undefined,
      scratchCapBytes: undefined,
      now: undefined,
    });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function planOf(command: string): HostAuthenticatedGitPlan {
    const plan = bridge.plan(command);
    if (plan === undefined) {
      throw new Error(`not a bridged command: ${command}`);
    }
    return plan;
  }

  function input(
    command: string,
    token: string | null = TOKEN,
    cwd = '/workspace',
    approvedRemotes: GitRemotePrecondition | undefined = undefined,
  ) {
    return {
      command,
      plan: planOf(command),
      token,
      approvedRemotes,
      guest,
      sandboxId: 's1-test',
      cwd,
      timeoutSeconds: 60,
      signal: undefined,
    };
  }

  async function cloned(): Promise<string> {
    const result = await bridge.run(input(`git clone ${URL} widgets`));
    expect(result).toMatchObject({ success: true, response: { exitCode: 0 } });
    return guest.path('widgets');
  }

  async function commitInGuest(file: string, message: string, content = 'x\n'): Promise<void> {
    await writeFile(join(guest.path('widgets'), file), content);
    git(guest.path('widgets'), 'add', file);
    git(guest.path('widgets'), 'commit', '-m', message);
  }

  test('clone brings the repository into the sandbox and leaves the GitHub address as origin', async () => {
    const dir = await cloned();
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('hello\n');
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(URL);
    // Clones are shallow unless the command asks for more.
    expect(git(dir, 'log', '--format=%s')).toBe('second');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  test('the token never reaches the sandbox, and only network operations on the host carry it', async () => {
    await cloned();
    expect(guest.commands.join('\n')).not.toContain(TOKEN);
    expect(guest.files).toEqual([expect.stringMatching(/^\/workspace\/\.aman\/transfer\/[0-9a-f]+\/repo\.tar$/)]);
    const withToken = calls.filter(call => call.env['TRUEFORGE_GIT_TOKEN'] === TOKEN);
    expect(withToken.length).toBeGreaterThan(0);
    for (const call of withToken) {
      expect(call.argv).toContain('clone');
    }
    expect(guest.commands.some(command => command.includes('rm -rf'))).toBe(true);
  });

  test('every host git call runs with a scrubbed environment and hardening', async () => {
    await cloned();
    for (const call of calls.filter(entry => entry.argv.includes('/usr/bin/git'))) {
      expect(call.env['HOME']).toBe('/nonexistent');
      expect(call.env['GIT_CONFIG_NOSYSTEM']).toBe('1');
      const config = Object.entries(call.env)
        .filter(([key]) => key.startsWith('GIT_CONFIG_VALUE_'))
        .map(([, value]) => value);
      expect(config).toContain('/dev/null');
      expect(Object.keys(call.env)).not.toContain('SANDBOX_COSIGN_PUBLIC_KEY_PATH');
    }
  });

  test('a shallow clone is delivered shallow', async () => {
    const result = await bridge.run(input(`git clone --depth 1 ${URL} shallow`));
    expect(result).toMatchObject({ success: true, response: { exitCode: 0 } });
    expect(git(guest.path('shallow'), 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  test('clone of something that is not a GitHub repository is refused', async () => {
    const result = await bridge.run({
      ...input(`git clone ${URL} x`),
      plan: { ...planOf(`git clone ${URL} x`), args: ['https://example.com/a/b'] },
    });
    expect(result).toMatchObject({ success: true, response: { exitCode: 1 } });
  });

  test('fetch and pull bring new commits from GitHub into the sandbox', async () => {
    const dir = await cloned();
    const other = join(base, 'other');
    git(base, 'clone', remote, other);
    await writeFile(join(other, 'three.txt'), '3\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'third');
    git(other, 'push', 'origin', 'main');

    const fetched = await bridge.run(input('git fetch origin', TOKEN, '/workspace/widgets', APPROVED_ORIGIN));
    expect(fetched).toMatchObject({ success: true, response: { exitCode: 0 } });
    expect(git(dir, 'log', '--format=%s', 'origin/main', '-1')).toBe('third');
    expect(git(dir, 'log', '--format=%s', '-1')).toBe('second');

    const pulled = await bridge.run(input('git pull --ff-only', TOKEN, '/workspace/widgets', APPROVED_ORIGIN));
    expect(pulled).toMatchObject({ success: true, response: { exitCode: 0 } });
    expect(git(dir, 'log', '--format=%s', '-1')).toBe('third');
    const scopes = calls
      .filter(call => call.env['TRUEFORGE_GIT_TOKEN'] === TOKEN)
      .flatMap(call => credentialScopes(call.env));
    expect(new Set(scopes)).toEqual(new Set([`${URL}.git`, URL]));
  });

  describe('fetch and pull through a named or default remote', () => {
    const tokenCarrying = () => calls.filter(call => call.env['TRUEFORGE_GIT_TOKEN'] !== undefined);

    test.each(['git fetch origin', 'git pull --ff-only'])(
      '%s is refused before any token-carrying call when the guest remote is not the approved one',
      async command => {
        const dir = await cloned();
        git(dir, 'remote', 'set-url', 'origin', 'https://github.com/other/private');
        calls.length = 0;
        const result = await bridge.run(input(command, TOKEN, '/workspace/widgets', APPROVED_ORIGIN));
        expect(result).toMatchObject({ success: true, response: { exitCode: 1 } });
        expect(result.success && result.response.result).toContain('not the one shown for approval');
        expect(tokenCarrying()).toEqual([]);
      },
    );

    test.each(['git fetch origin', 'git pull --ff-only'])(
      '%s without an approved repository is refused and offers the token to nothing',
      async command => {
        await cloned();
        calls.length = 0;
        const result = await bridge.run(input(command, TOKEN, '/workspace/widgets'));
        expect(result).toMatchObject({ success: true, response: { exitCode: 1 } });
        expect(result.success && result.response.result).toContain('No repository was shown for approval');
        expect(tokenCarrying()).toEqual([]);
      },
    );

    test('the token is only ever offered to the approved repository', async () => {
      const dir = await cloned();
      git(dir, 'remote', 'add', 'upstream', 'https://github.com/other/private');
      git(dir, 'config', 'branch.main.remote', 'origin');
      calls.length = 0;
      const fetched = await bridge.run(input('git fetch', TOKEN, '/workspace/widgets', APPROVED_ORIGIN));
      expect(fetched).toMatchObject({ success: true, response: { exitCode: 0 } });
      expect(new Set(tokenCarrying().flatMap(call => credentialScopes(call.env)))).toEqual(
        new Set([`${URL}.git`, URL]),
      );
    });

    test('a url rewrite in the guest config does not move the token to another repository', async () => {
      const dir = await cloned();
      git(dir, 'config', 'url.https://github.com/other/private.insteadOf', URL);
      calls.length = 0;
      await bridge.run(input('git fetch origin', TOKEN, '/workspace/widgets', APPROVED_ORIGIN));
      const scopes = tokenCarrying().flatMap(call => credentialScopes(call.env));
      expect(scopes.length).toBeGreaterThan(0);
      expect(scopes.every(scope => scope.startsWith(URL))).toBe(true);
    });
  });

  test('ls-remote runs on the host', async () => {
    const listed = await bridge.run(input(`git ls-remote --heads ${URL}`));
    expect(listed).toMatchObject({ success: true, response: { exitCode: 0 } });
    expect(listed.success && listed.response.result).toContain('refs/heads/main');
  });

  describe('push', () => {
    async function previewed(command = 'git push origin main') {
      const preview = await bridge.previewPush(input(command, TOKEN, '/workspace/widgets'));
      if (preview.status !== 'ok') {
        throw new Error(preview.message);
      }
      return preview.preview;
    }

    test('previews the commits, then pushes only after verifying them', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      await commitInGuest('b.txt', 'add b');
      const preview = await previewed();
      expect(preview).toMatchObject({ repository: 'acme/widgets', branch: 'main', commit_count: 2 });
      expect(preview.commits.map(commit => commit.subject)).toEqual(['add b', 'add a']);
      expect(git(remote, 'log', '--format=%s', '-1', 'main')).toBe('second');

      const result = await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      expect(result).toMatchObject({ success: true, response: { exitCode: 0 } });
      expect(result.success && result.response.result).toContain('main -> main');
      expect(git(remote, 'log', '--format=%s', '-2', 'main')).toBe('add b\nadd a');
      expect(git(guest.path('widgets'), 'rev-parse', 'refs/remotes/origin/main')).toBe(
        git(remote, 'rev-parse', 'main'),
      );
      expect(guest.commands.join('\n')).not.toContain(TOKEN);
    });

    test('a push that was never reviewed is refused', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      const result = await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      expect(result).toMatchObject({ success: true, response: { exitCode: 1 } });
      expect(result.success && result.response.result).toContain('not reviewed');
      expect(git(remote, 'log', '--format=%s', '-1', 'main')).toBe('second');
    });

    test('a review is used once', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      await previewed();
      await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      await commitInGuest('b.txt', 'add b');
      const again = await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      expect(again.success && again.response.result).toContain('not reviewed');
    });

    test('commits added after the review are not pushed', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      await previewed();
      await commitInGuest('late.txt', 'added after review');
      const result = await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      expect(result.success && result.response.result).toContain('changed after you reviewed');
      expect(git(remote, 'log', '--format=%s', '-1', 'main')).toBe('second');
    });

    test('a second review does not replace the first while it is still open', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      await previewed();
      await commitInGuest('b.txt', 'add b');
      await previewed();
      const result = await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      expect(result.success && result.response.result).toContain('changed after you reviewed');
    });

    test('a non-fast-forward push is refused and the remote is untouched', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      const other = join(base, 'other');
      git(base, 'clone', remote, other);
      await writeFile(join(other, 'theirs.txt'), 't\n');
      git(other, 'add', '.');
      git(other, 'commit', '-m', 'theirs');
      git(other, 'push', 'origin', 'main');
      const before = git(remote, 'rev-parse', 'main');
      await previewed();
      const result = await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      expect(result.success && result.response.result).toMatch(/non-fast-forward|has changed/u);
      expect(git(remote, 'rev-parse', 'main')).toBe(before);
    });

    test.each([['--force'], ['-f'], ['--force-with-lease'], ['--delete'], ['--tags']])(
      '%s is refused at review time',
      async flag => {
        await cloned();
        await commitInGuest('a.txt', 'add a');
        const preview = await bridge.previewPush(input(`git push ${flag} origin main`, TOKEN, '/workspace/widgets'));
        expect(preview.status).toBe('refused');
      },
    );

    test('a leading + refspec and multiple branches are refused', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      expect((await bridge.previewPush(input('git push origin +main', TOKEN, '/workspace/widgets'))).status).toBe(
        'refused',
      );
      expect((await bridge.previewPush(input('git push origin main other', TOKEN, '/workspace/widgets'))).status).toBe(
        'refused',
      );
    });

    test('a submodule or .gitmodules change is refused and nothing is pushed', async () => {
      await cloned();
      const dir = guest.path('widgets');
      git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/lib`);
      git(dir, 'commit', '-m', 'add submodule');
      await previewed();
      const before = git(remote, 'rev-parse', 'main');
      const result = await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      expect(result.success && result.response.result).toContain('submodule');
      expect(git(remote, 'rev-parse', 'main')).toBe(before);
    });

    test('a .gitmodules change is refused', async () => {
      await cloned();
      const dir = guest.path('widgets');
      await writeFile(join(dir, '.gitmodules'), '[submodule "x"]\n path = x\n url = https://example.com/x\n');
      git(dir, 'add', '.gitmodules');
      git(dir, 'commit', '-m', 'gitmodules');
      await previewed();
      const before = git(remote, 'rev-parse', 'main');
      const result = await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      expect(result.success && result.response.result).toContain('.gitmodules');
      expect(git(remote, 'rev-parse', 'main')).toBe(before);
    });

    test('a bundle with an extra ref or a different tip is refused', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      await previewed();
      const dir = guest.path('widgets');
      git(dir, 'branch', 'sneaky');
      guest.tamperGetFile = () => {
        // A hostile sandbox hands back a bundle of everything, including a branch nobody reviewed.
        const out = join(base, 'evil.bundle');
        git(dir, 'bundle', 'create', out, 'main', 'sneaky');
        return Buffer.from(execFileSync('cat', [out]));
      };
      const before = git(remote, 'rev-parse', 'main');
      const result = await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      expect(result.success && result.response.exitCode).toBe(1);
      expect(git(remote, 'rev-parse', 'main')).toBe(before);
      expect(() => git(remote, 'rev-parse', '--verify', 'sneaky')).toThrow();
    });

    test('garbage instead of a bundle is refused', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      await previewed();
      guest.tamperGetFile = () => Buffer.from('not a bundle at all');
      const result = await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      expect(result.success && result.response.exitCode).toBe(1);
    });

    test('without a token nothing is pushed', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      await bridge.previewPush(input('git push origin main', null, '/workspace/widgets'));
      const result = await bridge.run(input('git push origin main', null, '/workspace/widgets'));
      expect(result.success && result.response.result).toContain('no GitHub connector');
    });

    test('--dry-run reports the commits and sends nothing', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      await previewed('git push --dry-run origin main');
      const result = await bridge.run(input('git push --dry-run origin main', TOKEN, '/workspace/widgets'));
      expect(result.success && result.response.result).toContain('Would push 1 commit');
      expect(git(remote, 'log', '--format=%s', '-1', 'main')).toBe('second');
    });

    test('-u records the upstream, and a new branch is created on GitHub', async () => {
      await cloned();
      const dir = guest.path('widgets');
      git(dir, 'checkout', '-b', 'feature');
      await commitInGuest('f.txt', 'feature work');
      await bridge.previewPush(input('git push -u origin feature', TOKEN, '/workspace/widgets'));
      const result = await bridge.run(input('git push -u origin feature', TOKEN, '/workspace/widgets'));
      expect(result.success && result.response.result).toContain('[new branch]');
      expect(git(remote, 'log', '--format=%s', '-1', 'feature')).toBe('feature work');
      expect(git(dir, 'rev-parse', '--abbrev-ref', 'feature@{upstream}')).toBe('origin/feature');
    });

    test('a push with nothing new says so', async () => {
      await cloned();
      const preview = await bridge.previewPush(input('git push origin main', TOKEN, '/workspace/widgets'));
      expect(preview).toMatchObject({ status: 'refused', message: 'Everything up-to-date' });
    });

    test('the scratch area is empty afterwards', async () => {
      await cloned();
      await commitInGuest('a.txt', 'add a');
      await previewed();
      await bridge.run(input('git push origin main', TOKEN, '/workspace/widgets'));
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(join(base, 'scratch'))).toEqual([]);
    });
  });
});

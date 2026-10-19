import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'winston';
import { gitLocalImportHardeningConfigEntries } from '../../../../../src/core/permissions/gitHardening';
import type { GitRemotePrecondition } from '../../../../../src/core/sandbox/gitRemoteObservation';
import type { HostAuthenticatedGitPlan } from '../../../../../src/core/sandbox/hostAuthenticatedGit';
import type { ExecResult } from '../../../../../src/core/sandbox/provider/Provider';
import { GitBridge, type BridgeGuest } from '../../../../../src/core/sandbox/slots/git/gitBridge';
import { execFileRunner, type HostCommandRunner } from '../../../../../src/core/sandbox/slots/git/hostCommand';
import { makeSilentLogger } from '../../../harnessMocks';
import { LocalGuest } from './localGuest';

const URL = 'https://github.com/acme/widgets';
const TOKEN = 'fake-host-token-1234567890';
const APPROVED_ORIGIN: GitRemotePrecondition = {
  remotes: [{ name: 'origin', url: `${URL}.git` }],
  summary: `This uses origin, which is ${URL}.git. Your GitHub sign-in is only offered to this repository.`,
};
const TAR_BINARY = '/usr/bin/tar';
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: '/nonexistent',
};

// A uid the test user does not own. The server packs the repository with it, the way a server that runs as
// another user would, and the guest must still unpack the files without taking that owner.
const SERVER_OWNER = 1234;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', ...IDENTITY },
    encoding: 'utf8',
  }).trim();
}

/** Packs the repository tar as `SERVER_OWNER`, so the tar records a file owner the guest cannot take. */
function packedByAnotherOwner(): HostCommandRunner {
  return {
    run: input => {
      const [binary, ...rest] = input.argv;
      const packs = binary === TAR_BINARY && rest.includes('-cf');
      const argv = packs
        ? [binary, `--owner=${SERVER_OWNER}`, `--group=${SERVER_OWNER}`, '--numeric-owner', ...rest]
        : input.argv;
      return execFileRunner.run({ ...input, argv });
    },
  };
}

describe('GitBridge unpacks a repository in the sandbox', () => {
  let base: string;
  let remote: string;
  let guest: LocalGuest;
  let runner: HostCommandRunner;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'git-unpack-'));
    remote = join(base, 'remote.git');
    git(base, 'init', '--bare', '-b', 'main', remote);
    const seed = join(base, 'seed');
    git(base, 'init', '-b', 'main', seed);
    await writeFile(join(seed, 'README.md'), 'hello\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'first');
    git(seed, 'push', remote, 'main');
    guest = new LocalGuest(join(base, 'guest'));
    await mkdir(guest.root, { recursive: true });
    runner = packedByAnotherOwner();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function bridgeWith(overrides: { runner?: HostCommandRunner; logger?: Logger } = {}): GitBridge {
    return new GitBridge({
      scratchRoot: join(base, 'scratch'),
      runner: overrides.runner ?? runner,
      logger: overrides.logger ?? makeSilentLogger(),
      remoteUrl: () => `file://${remote}`,
      networkEntries: gitLocalImportHardeningConfigEntries(),
      networkEnv: undefined,
      scratchCapBytes: undefined,
      now: undefined,
    });
  }

  function input(
    bridge: GitBridge,
    command: string,
    options: { sandbox?: BridgeGuest; cwd?: string; approved?: boolean } = {},
  ) {
    const plan: HostAuthenticatedGitPlan | undefined = bridge.plan(command);
    if (plan === undefined) {
      throw new Error(`not a bridged command: ${command}`);
    }
    return {
      command,
      plan,
      token: options.approved === true ? TOKEN : null,
      approvedRemotes: options.approved === true ? APPROVED_ORIGIN : undefined,
      guest: options.sandbox ?? guest,
      sandboxId: 's1-test',
      cwd: options.cwd ?? '/workspace',
      timeoutSeconds: 60,
      signal: undefined,
    };
  }

  test("a clone's tar unpacks in the guest as the sandbox user, not as the server's owner", async () => {
    // The guest records who owns the unpacked repository before the bridge removes it.
    const owners: number[] = [];
    const recording: BridgeGuest = {
      exec: exec => {
        const dir = /-C '([^']+)'/u.exec(exec.command)?.[1];
        if (!exec.command.startsWith('tar ') || dir === undefined) {
          return guest.exec(exec);
        }
        return guest.exec({ ...exec, command: `${exec.command} && stat -c %u '${dir}/repo.git'` }).then(result => {
          if (result.success && result.response.exitCode === 0) {
            owners.push(Number(result.response.result.trim().split('\n').pop()));
          }
          return result;
        });
      },
      putFile: putInput => guest.putFile(putInput),
      getFile: getInput => guest.getFile(getInput),
    };
    const bridge = bridgeWith();

    const result = await bridge.run(input(bridge, `git clone ${URL} widgets`, { sandbox: recording }));

    expect(result).toMatchObject({ success: true, response: { exitCode: 0 } });
    expect(await readFile(guest.path('widgets/README.md'), 'utf8')).toBe('hello\n');
    expect(owners).toEqual([(await stat(guest.root)).uid]);
    expect(owners).not.toContain(SERVER_OWNER);
  });

  test('the clone lands in the workspace, which stays writable afterwards', async () => {
    const bridge = bridgeWith();

    const result = await bridge.run(input(bridge, `git clone ${URL} widgets`));
    expect(result).toMatchObject({ success: true, response: { exitCode: 0 } });
    expect((await stat(guest.path('widgets'))).isDirectory()).toBe(true);

    const written = await guest.exec({
      command: 'touch /workspace/notes.txt && test -f /workspace/notes.txt',
      env: undefined,
      cwd: undefined,
    });
    expect(written).toMatchObject({ success: true, response: { exitCode: 0 } });
  });

  describe('an unpack failure says the plain reason', () => {
    /** A guest whose unpack step fails with the given text; everything else runs for real. */
    function failingUnpack(outcome: ExecResult): BridgeGuest {
      return {
        exec: exec => (exec.command.startsWith('tar ') ? Promise.resolve(outcome) : guest.exec(exec)),
        putFile: putInput => guest.putFile(putInput),
        getFile: getInput => guest.getFile(getInput),
      };
    }

    test.each([
      [
        'the disk is full',
        'tar: repo.tar: Cannot open: No space left on device\n',
        'fatal: the sandbox ran out of space for this repository. Try a shallow clone: git clone --depth 1 <url>.',
      ],
      [
        'the files cannot take the owner',
        'tar: repo.git/HEAD: Cannot change ownership to uid 1234, gid 1234: Invalid argument\n',
        'fatal: the sandbox could not save the repository files. Restart Aman, then run git clone again.',
      ],
      [
        'anything else',
        'tar: This does not look like a tar archive\n',
        'fatal: the sandbox could not unpack the repository. Restart Aman, then run git clone again.',
      ],
    ])('%s', async (_case, stderr, message) => {
      const logger = makeSilentLogger();
      const warn = jest.spyOn(logger, 'warn');
      const bridge = bridgeWith({ logger });
      const outcome: ExecResult = { success: true, response: { exitCode: 2, result: stderr } };

      const result = await bridge.run(input(bridge, `git clone ${URL} widgets`, { sandbox: failingUnpack(outcome) }));

      expect(result).toEqual({ success: true, response: { exitCode: 1, result: message } });
      // The raw text from tar is kept for the logs, not shown to the person.
      expect(warn).toHaveBeenCalledWith('git bridge could not unpack a repository in the sandbox', { stderr });
    });

    test('a pull that cannot unpack names the pull, not the clone', async () => {
      const bridge = bridgeWith();
      expect(await bridge.run(input(bridge, `git clone ${URL} widgets`))).toMatchObject({
        success: true,
        response: { exitCode: 0 },
      });
      const outcome: ExecResult = {
        success: true,
        response: { exitCode: 2, result: 'tar: repo.tar: Cannot open: No space left on device\n' },
      };

      const result = await bridge.run(
        input(bridge, 'git pull --ff-only', {
          sandbox: failingUnpack(outcome),
          cwd: '/workspace/widgets',
          approved: true,
        }),
      );

      expect(result).toEqual({
        success: true,
        response: {
          exitCode: 1,
          result:
            'fatal: the sandbox ran out of space for this repository. Free some space in the sandbox or start a new chat, then run git pull again.',
        },
      });
    });
  });
});

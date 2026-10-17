import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitRemotesMatch,
  observeGitRemotes,
  remoteObservationRequired,
  type GitProbeRunner,
} from '../../../src/core/sandbox/gitRemoteObservation';
import { planHostAuthenticatedGit } from '../../../src/core/sandbox/hostAuthenticatedGit';

const GIT = '/usr/bin/git';
const describeWithGit = existsSync(GIT) && existsSync('/usr/bin/env') ? describe : describe.skip;

function planOf(command: string): NonNullable<ReturnType<typeof planHostAuthenticatedGit>> {
  const plan = planHostAuthenticatedGit({ command });
  if (plan === undefined) {
    throw new Error(`expected a plan for ${command}`);
  }
  return plan;
}

describeWithGit('observeGitRemotes against a real checkout', () => {
  let repo: string;
  const git = (...args: string[]): void => {
    execFileSync(GIT, args, { cwd: repo, stdio: 'ignore' });
  };
  const run: GitProbeRunner = probe => {
    const result = spawnSync('/bin/sh', ['-c', probe.command], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...probe.env, LC_ALL: 'C' },
    });
    return Promise.resolve(result.status === 0 ? result.stdout : undefined);
  };
  const observe = (command: string) => observeGitRemotes({ plan: planOf(command), run, workspaceRoot: repo });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-remote-observation-'));
    mkdirSync(repo, { recursive: true });
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', 'https://github.com/o/r');
    git('remote', 'add', 'upstream', 'https://github.com/up/stream.git');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('a named remote resolves to its canonical GitHub address and a card summary', async () => {
    const seen = await observe('git push origin main');
    expect(seen?.remotes).toEqual([{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(seen?.summary).toBe(
      'This uses origin, which is https://github.com/o/r.git. Your GitHub sign-in is only offered to this repository.',
    );
  });

  test('several remotes are each named on the card', async () => {
    expect((await observe('git fetch --all'))?.summary).toBe(
      'This uses origin, which is https://github.com/o/r.git, and upstream, which is https://github.com/up/stream.git. Your GitHub sign-in is only offered to these repositories.',
    );
  });

  // Fetch contacts the first address and push every one, so no single address could be shown.
  test('a remote with more than one address yields no observation', async () => {
    git('config', '--add', 'remote.origin.url', 'https://github.com/o/other');
    expect(await observe('git push origin main')).toBeUndefined();
    expect(await observe('git fetch --all')).toBeUndefined();
  });

  test('a branch whose remote cannot be looked up safely yields no observation instead of a guessed origin', async () => {
    git('symbolic-ref', 'HEAD', 'refs/heads/na\u00efve');
    git('config', 'branch.na\u00efve.remote', 'upstream');
    expect(await observe('git pull')).toBeUndefined();
  });

  test('a bare command follows the branch remote, and origin when none is configured', async () => {
    expect((await observe('git pull'))?.remotes).toEqual([{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    git('config', 'branch.main.remote', 'upstream');
    expect((await observe('git pull'))?.remotes).toEqual([
      { name: 'upstream', url: 'https://github.com/up/stream.git' },
    ]);
  });

  test('--all observes every remote', async () => {
    const seen = await observe('git fetch --all');
    expect(seen?.remotes.map(remote => remote.name).sort()).toEqual(['origin', 'upstream']);
  });

  test('a remote that is not a plain github.com repository yields no observation, so it is never authenticated', async () => {
    git('remote', 'add', 'mirror', 'https://github.com.evil.test/o/r');
    git('remote', 'add', 'local', '/srv/repo.git');
    expect(await observe('git push mirror main')).toBeUndefined();
    expect(await observe('git push local main')).toBeUndefined();
    expect(await observe('git fetch --all')).toBeUndefined();
    expect(await observe('git push nosuchremote')).toBeUndefined();
  });

  test('a repointed remote no longer matches what was shown', async () => {
    const shown = await observe('git push origin main');
    git('remote', 'set-url', 'origin', 'https://github.com/attacker/x');
    const now = await observe('git push origin main');
    if (shown === undefined || now === undefined) {
      throw new Error('expected both observations');
    }
    expect(gitRemotesMatch({ approved: shown, current: now })).toBe(false);
    expect(gitRemotesMatch({ approved: shown, current: shown })).toBe(true);
  });

  test('only commands that do not name a URL need an observation', () => {
    expect(remoteObservationRequired(planOf('git push origin main'))).toBe(true);
    expect(remoteObservationRequired(planOf('git pull'))).toBe(true);
    expect(remoteObservationRequired(planOf('git ls-remote https://github.com/o/r'))).toBe(false);
    expect(remoteObservationRequired(planOf('git clone https://github.com/o/r'))).toBe(false);
  });
});

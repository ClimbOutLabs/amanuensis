import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHostAuthenticatedGit,
  buildHostAuthenticatedGitConfigProbe,
  buildHostGitInvocation,
  HOST_AUTHENTICATED_GIT_BINARY,
  isGitNetworkCommand,
  parseGithubRepository,
  pickGitNetworkEnv,
  planHostAuthenticatedGit,
} from '../../../src/core/sandbox/hostAuthenticatedGit';

// Assembled at runtime so secret scanners do not mistake the synthetic value for a real token.
const TOKEN = ['ghp', 'SyntheticTokenForTestsOnly0123456789'].join('_');

describe('planHostAuthenticatedGit', () => {
  test.each([
    'git clone https://github.com/acme/widgets',
    'git clone https://github.com/acme/widgets.git widgets',
    'git clone --depth 1 --branch main https://github.com/acme/widgets',
    'git clone --depth=1 -b feature/x https://github.com/acme/widgets sub/dir',
    'git fetch',
    'git fetch origin',
    'git fetch --prune origin main',
    'git pull --ff-only',
    'git pull --rebase origin main',
    'git push',
    'git push -u origin feature/x',
    'git push --force-with-lease origin HEAD:refs/heads/feature/x',
    'git ls-remote https://github.com/acme/widgets',
    'git ls-remote --heads https://github.com/acme/widgets main',
  ])('plans `%s`', command => {
    expect(planHostAuthenticatedGit({ command })).toBeDefined();
  });

  test.each([
    ['global -c override', 'git -c credential.helper=!cat push'],
    ['global -C', 'git -C other push'],
    ['unlisted flag', 'git push --receive-pack=evil origin main'],
    ['upload-pack', 'git fetch --upload-pack=evil origin'],
    ['recursion', 'git clone --recurse-submodules https://github.com/acme/widgets'],
    ['non-github host', 'git clone https://evil.example/acme/widgets'],
    ['http scheme', 'git clone http://github.com/acme/widgets'],
    ['lookalike host', 'git clone https://github.com.evil.example/acme/widgets'],
    ['userinfo', 'git clone https://user:pw@github.com/acme/widgets'],
    ['ssh url', 'git clone git@github.com:acme/widgets.git'],
    ['ext transport', 'git fetch ext::sh'],
    ['local path remote', 'git fetch ../other'],
    ['absolute clone dir', 'git clone https://github.com/acme/widgets /etc'],
    ['parent clone dir', 'git clone https://github.com/acme/widgets ../x'],
    ['option-looking refspec', 'git push origin --mirror'],
    ['chained', 'git push origin main && cat .git/config'],
    ['piped', 'git fetch | cat'],
    ['variable expansion', 'git push origin $BRANCH'],
    ['env prefix', 'FOO=1 git push'],
    ['wrapper', 'env git push'],
    ['nice wrapper', 'nice git push'],
    ['other subcommand', 'git remote -v'],
    ['config subcommand', 'git config --list'],
    ['depth not a number', 'git clone --depth abc https://github.com/acme/widgets'],
    ['missing url', 'git clone'],
    ['ls-remote without url', 'git ls-remote origin'],
  ])('rejects %s', (_name, command) => {
    expect(planHostAuthenticatedGit({ command })).toBeUndefined();
  });

  test('ls-remote reads the checkout config but tolerates running outside a repository', () => {
    const plan = planHostAuthenticatedGit({ command: 'git ls-remote https://github.com/o/r' });
    expect(plan).toMatchObject({ readsRepositoryConfig: true, allowsMissingRepository: true });
    expect(planHostAuthenticatedGit({ command: 'git push' })?.allowsMissingRepository).toBe(false);
  });

  test('marks only commands that read the checkout config', () => {
    expect(planHostAuthenticatedGit({ command: 'git push' })?.readsRepositoryConfig).toBe(true);
    expect(planHostAuthenticatedGit({ command: 'git clone https://github.com/a/b' })?.readsRepositoryConfig).toBe(
      false,
    );
  });
});

describe('isGitNetworkCommand', () => {
  test.each([
    ['git push', true],
    ['cd x && git fetch origin', true],
    ['git -c a=b clone https://github.com/a/b', true],
    ['git status', false],
    ['echo hello', false],
  ])('%s -> %s', (command, expected) => {
    expect(isGitNetworkCommand(command)).toBe(expected);
  });
});

function configPairs(env: Record<string, string>): Map<string, string> {
  const pairs = new Map<string, string>();
  for (let index = 0; index < Number(env['GIT_CONFIG_COUNT']); index += 1) {
    pairs.set(env[`GIT_CONFIG_KEY_${String(index)}`] ?? '', env[`GIT_CONFIG_VALUE_${String(index)}`] ?? '');
  }
  return pairs;
}

describe('planHostAuthenticatedGit remote target', () => {
  test.each([
    ['git push', { kind: 'default' }],
    ['git pull --ff-only', { kind: 'default' }],
    ['git fetch --all', { kind: 'all' }],
    ['git push -u origin feature/x', { kind: 'named', name: 'origin' }],
    ['git fetch upstream', { kind: 'named', name: 'upstream' }],
    ['git push https://github.com/o/r main', { kind: 'url', url: 'https://github.com/o/r' }],
    ['git clone https://github.com/o/r', { kind: 'url', url: 'https://github.com/o/r' }],
    ['git ls-remote https://github.com/o/r', { kind: 'url', url: 'https://github.com/o/r' }],
  ])('%s targets %j', (command, remote) => {
    expect(planHostAuthenticatedGit({ command })?.remote).toEqual(remote);
  });
});

describe('buildHostAuthenticatedGit', () => {
  const plan = planHostAuthenticatedGit({ command: 'git push -u origin feature/x' });
  if (plan === undefined) {
    throw new Error('expected a plan');
  }
  const built = buildHostAuthenticatedGit({
    plan,
    token: TOKEN,
    workspaceRoot: '/work/repo',
    remotes: [{ name: 'origin', url: 'https://github.com/o/r.git' }],
  });

  test('uses the pinned git binary and never puts the token in the command', () => {
    expect(built.command.startsWith("'/usr/bin/env' '-u' ")).toBe(true);
    expect(built.command).toContain(`'${HOST_AUTHENTICATED_GIT_BINARY}' '--no-pager'`);
    expect(built.command).toContain("'-u' 'GIT_TRACE_CURL'");
    expect(built.command).toContain("'-u' 'LD_PRELOAD'");
    expect(built.command).not.toContain(TOKEN);
  });

  test('carries the token in exactly one env value and never in a config value', () => {
    const carriers = Object.entries(built.env).filter(([, value]) => value.includes(TOKEN));
    expect(carriers).toEqual([['TRUEFORGE_GIT_TOKEN', TOKEN]]);
  });

  test('keeps system and global config isolated and neutralises hooks and external programs', () => {
    expect(built.env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    });
    const pairs = new Map<string, string>();
    for (let index = 0; index < Number(built.env['GIT_CONFIG_COUNT']); index += 1) {
      pairs.set(
        built.env[`GIT_CONFIG_KEY_${String(index)}`] ?? '',
        built.env[`GIT_CONFIG_VALUE_${String(index)}`] ?? '',
      );
    }
    expect(pairs.get('core.hooksPath')).toBe('/dev/null');
    expect(pairs.get('core.fsmonitor')).toBe('false');
    expect(pairs.get('core.sshCommand')).toBe('');
    expect(pairs.get('protocol.allow')).toBe('never');
    expect(pairs.get('protocol.https.allow')).toBe('always');
    expect(pairs.get('safe.directory')).toBe('/work/repo');
    for (const scope of ['http.', 'http.https://github.com/.']) {
      expect(pairs.get(`${scope}sslVerify`)).toBe('true');
      expect(pairs.get(`${scope}extraHeader`)).toBe('');
      expect(pairs.get(`${scope}curloptResolve`)).toBe('');
      expect(pairs.get(`${scope}followRedirects`)).toBe('false');
    }
    // An empty CA path leaves libcurl without a CA bundle, so every TLS handshake would fail.
    for (const [key, value] of pairs) {
      if (/\.ssl(CAInfo|CAPath)$/iu.test(key)) {
        expect(value).not.toBe('');
      }
    }
    expect(pairs.has('http.sslCAInfo')).toBe(false);
    expect(pairs.has('http.sslCAPath')).toBe(false);
    expect(built.command).not.toContain("'GIT_SSL_CAINFO'");
    expect(built.command).not.toContain("'GIT_SSL_CAPATH'");
    expect(pairs.get('fetch.recurseSubmodules')).toBe('false');
    expect(pairs.get('diff.external')).toBe('');
    expect(pairs.get('status.submoduleSummary')).toBe('false');
    expect(built.env).toMatchObject({ HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent' });
  });

  test('the probe is token-free and read-only', () => {
    const probe = buildHostAuthenticatedGitConfigProbe({ workspaceRoot: '/work/repo' });
    expect(JSON.stringify(probe)).not.toContain('TOKEN');
    expect(probe.command).toContain("'config' '--local'");
  });

  test('offers the token to the observed repository alone and adds no remote address', () => {
    const pairs = configPairs(built.env);
    expect([...pairs.keys()].filter(key => key.startsWith('remote.'))).toEqual([]);
    expect(pairs.get('credential.useHttpPath')).toBe('true');
    expect(pairs.has('credential.https://github.com.helper')).toBe(false);
    expect([...pairs.keys()].filter(key => key.startsWith('credential.https://'))).toEqual([
      'credential.https://github.com/o/r.git.helper',
      'credential.https://github.com/o/r.helper',
    ]);
  });

  describe('real git credential resolution', () => {
    function fill(input: { host: string; path: string }): { status: number | null; stdout: string } {
      const result = spawnSync('git', ['credential', 'fill'], {
        input: `protocol=https\nhost=${input.host}\npath=${input.path}\n\n`,
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: '/nonexistent', ...built.env },
      });
      return { status: result.status, stdout: result.stdout };
    }

    test('answers only for the approved repository on github.com over https', () => {
      for (const path of ['o/r.git', 'o/r']) {
        const approved = fill({ host: 'github.com', path });
        expect(approved.status).toBe(0);
        expect(approved.stdout).toContain('username=x-access-token');
        expect(approved.stdout).toContain(`password=${TOKEN}`);
      }
      for (const other of [
        { host: 'github.com', path: 'o/other.git' },
        { host: 'github.com', path: 'attacker/r.git' },
        { host: 'github.com', path: 'o/r.git.evil' },
        { host: 'evil.example', path: 'o/r.git' },
        { host: 'github.com.evil.example', path: 'o/r.git' },
        { host: 'gist.github.com', path: 'o/r.git' },
      ]) {
        const result = fill(other);
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain(TOKEN);
      }
    });
  });
});

describe('parseGithubRepository', () => {
  test('reads plain github.com repositories and nothing else', () => {
    expect(parseGithubRepository('https://github.com/acme/widgets')).toEqual({
      slug: 'acme/widgets',
      canonical: 'https://github.com/acme/widgets.git',
    });
    expect(parseGithubRepository('https://github.com/acme/widgets.git/')?.slug).toBe('acme/widgets');
    for (const url of [
      'http://github.com/a/b',
      'https://github.com.evil.test/a/b',
      'https://github.com/a',
      'ssh://github.com/a/b',
    ]) {
      expect(parseGithubRepository(url)).toBeUndefined();
    }
  });

  test.each([
    ['o/r', 'o/r'],
    ['o/r.git', 'o/r'],
    ['o/my.repo', 'o/my.repo'],
    ['o/.github', 'o/.github'],
    ['my-org/under_score', 'my-org/under_score'],
  ])('accepts %s', (path, slug) => {
    expect(parseGithubRepository(`https://github.com/${path}`)?.slug).toBe(slug);
  });

  // git normalizes dot segments, so a credential scoped to one would cover a whole owner or all of github.com.
  test.each(['o/.', 'o/..', 'o/...', 'o/..git', './r', '../r', '-o/r', 'o/.git', 'o_o/r', 'o/r%2F..', 'o/r/x'])(
    'rejects %s',
    path => {
      expect(parseGithubRepository(`https://github.com/${path}`)).toBeUndefined();
    },
  );
});

const describeWithGit = existsSync('/usr/bin/git') && existsSync('/usr/bin/env') ? describe : describe.skip;

describeWithGit('buildHostAuthenticatedGit in a real checkout', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'host-auth-git-env-'));
    execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repo });
    execFileSync('/usr/bin/git', ['remote', 'add', 'origin', 'https://github.com/o/r'], { cwd: repo });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('leaves the remote with exactly one address, so a push goes out once', () => {
    const plan = planHostAuthenticatedGit({ command: 'git push origin main' });
    if (plan === undefined) {
      throw new Error('expected a plan');
    }
    const built = buildHostAuthenticatedGit({
      plan,
      token: TOKEN,
      workspaceRoot: repo,
      remotes: [{ name: 'origin', url: 'https://github.com/o/r.git' }],
    });
    const output = execFileSync('/usr/bin/git', ['config', '--get-all', 'remote.origin.url'], {
      cwd: repo,
      encoding: 'utf8',
      env: built.env,
    });
    expect(output).toBe('https://github.com/o/r\n');
  });
});

describe('host git network environment', () => {
  test('keeps only the named proxy and certificate settings with plain values', () => {
    expect(
      pickGitNetworkEnv({
        HTTPS_PROXY: 'http://proxy:3128',
        NO_PROXY: 'localhost',
        SSL_CERT_FILE: '/etc/ca.pem',
        GIT_SSH_COMMAND: 'evil',
        LD_PRELOAD: '/x.so',
        PATH: '/tmp',
        https_proxy: 'http://bad\nproxy',
        SSL_CERT_DIR: '',
        CURL_CA_BUNDLE: undefined,
      }),
    ).toEqual({ HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost', SSL_CERT_FILE: '/etc/ca.pem' });
  });

  test('the token is offered to the one repository the host contacts, and to nothing without a token', () => {
    const scoped = buildHostGitInvocation({
      gitArguments: ['fetch'],
      token: TOKEN,
      credentialRepositories: ['o/r'],
    });
    const helpers = [...configPairs(scoped.env).keys()].filter(key => key.startsWith('credential.https://'));
    expect(helpers).toEqual([
      'credential.https://github.com/o/r.git.helper',
      'credential.https://github.com/o/r.helper',
    ]);
    const bare = buildHostGitInvocation({ gitArguments: ['fetch'], token: undefined, credentialRepositories: ['o/r'] });
    expect([...configPairs(bare.env).keys()].some(key => key.startsWith('credential.'))).toBe(false);
    expect(bare.env['TRUEFORGE_GIT_TOKEN']).toBeUndefined();
  });

  test('the settings sit under the pinned environment, which they cannot override', () => {
    const invocation = buildHostGitInvocation({
      gitArguments: ['status'],
      token: undefined,
      credentialRepositories: [],
      networkEnv: { HTTPS_PROXY: 'http://proxy:3128', HOME: '/root', PATH: '/tmp' },
      ceilingDirectory: '/scratch',
    });
    expect(invocation.env).toMatchObject({
      HTTPS_PROXY: 'http://proxy:3128',
      HOME: '/nonexistent',
      PATH: '/usr/bin:/bin',
      GIT_CEILING_DIRECTORIES: '/scratch',
    });
  });
});

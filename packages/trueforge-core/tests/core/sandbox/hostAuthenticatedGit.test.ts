import { spawnSync } from 'node:child_process';
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

describe('buildHostAuthenticatedGit', () => {
  const plan = planHostAuthenticatedGit({ command: 'git push -u origin feature/x' });
  if (plan === undefined) {
    throw new Error('expected a plan');
  }
  const built = buildHostAuthenticatedGit({ plan, token: TOKEN, workspaceRoot: '/work/repo' });

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

  describe('real git credential resolution', () => {
    function fill(host: string): { status: number | null; stdout: string } {
      const result = spawnSync('git', ['credential', 'fill'], {
        input: `protocol=https\nhost=${host}\n\n`,
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: '/nonexistent', ...built.env },
      });
      return { status: result.status, stdout: result.stdout };
    }

    test('answers only for github.com over https', () => {
      const github = fill('github.com');
      expect(github.status).toBe(0);
      expect(github.stdout).toContain('username=x-access-token');
      expect(github.stdout).toContain(`password=${TOKEN}`);
      for (const host of ['evil.example', 'github.com.evil.example', 'gist.github.com']) {
        const other = fill(host);
        expect(other.status).not.toBe(0);
        expect(other.stdout).not.toContain(TOKEN);
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

  test('the settings sit under the pinned environment, which they cannot override', () => {
    const invocation = buildHostGitInvocation({
      gitArguments: ['status'],
      token: undefined,
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

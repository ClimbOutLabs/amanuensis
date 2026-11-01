import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitLocalConfigIsSafe,
  hashArgv,
  matchAllowlist,
  OFFLINE_SHELL_COMMANDS,
  parseReadOnlyList,
  parseSimpleCommand,
  pinAllowlistedExec,
  pinReadOnlyList,
  resolveOnPinnedPath,
  seedShellAllowlist,
  validateOfflineSubset,
  type PinnedExecInvocation,
  type ShellAllowlistConfig,
} from '../../../src/core/permissions/shellAllowlist';

const PINNED = '/usr/bin:/bin';

/** A pinned dir containing one fake executable, for environment-independent tests. */
function tempBin(name: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-bin-'));
  writeFileSync(join(dir, name), '#!/bin/sh\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function tempConfig(): { config: ShellAllowlistConfig; cleanup: () => void } {
  const { dir, cleanup } = tempBin('mycmd');
  const config: ShellAllowlistConfig = {
    pinned_path: dir,
    commands: {
      mycmd: { args: ['-l'], operands: 'workspace_relative', offline_ok: true, script: null, subcommands: null },
    },
  };
  return { config, cleanup };
}

describe('parseSimpleCommand', () => {
  test('parses a simple command with quoted args', () => {
    const parsed = parseSimpleCommand(`ls -la "my dir"`);
    expect(parsed).toBeDefined();
    expect(parsed?.argv).toEqual(['ls', '-la', 'my dir']);
  });

  test('rejects compound commands', () => {
    expect(parseSimpleCommand('ls; rm -rf /')).toBeUndefined();
    expect(parseSimpleCommand('ls && pwd')).toBeUndefined();
    expect(parseSimpleCommand('ls || pwd')).toBeUndefined();
    expect(parseSimpleCommand('ls | cat')).toBeUndefined();
  });

  test('rejects redirects and heredocs', () => {
    expect(parseSimpleCommand('ls > out.txt')).toBeUndefined();
    expect(parseSimpleCommand('cat < in.txt')).toBeUndefined();
    expect(parseSimpleCommand('cat <<EOF')).toBeUndefined();
  });

  test('rejects newlines, substitutions, and expansions', () => {
    expect(parseSimpleCommand('ls\npwd')).toBeUndefined();
    expect(parseSimpleCommand('echo $(whoami)')).toBeUndefined();
    expect(parseSimpleCommand('echo `whoami`')).toBeUndefined();
    expect(parseSimpleCommand('echo $HOME')).toBeUndefined();
    expect(parseSimpleCommand('echo ${HOME}')).toBeUndefined();
  });

  test('rejects parentheses and malformed quoting', () => {
    expect(parseSimpleCommand('echo (hi)')).toBeUndefined();
    expect(parseSimpleCommand(`echo 'unterminated`)).toBeUndefined();
  });

  test('rejects environment prefixes', () => {
    expect(parseSimpleCommand('FOO=bar ls')).toBeUndefined();
  });

  test('rejects empty input', () => {
    expect(parseSimpleCommand('')).toBeUndefined();
    expect(parseSimpleCommand('   ')).toBeUndefined();
  });

  test('treats a quoted semicolon as literal', () => {
    const parsed = parseSimpleCommand(`echo 'a;b'`);
    expect(parsed?.argv).toEqual(['echo', 'a;b']);
  });

  test('accepts the bare nice wrapper and rejects other wrappers', () => {
    const bare = parseSimpleCommand('nice ls');
    expect(bare?.argv).toEqual(['ls']);
    expect(bare?.wrapper).toBe('nice');
    expect(parseSimpleCommand('nice -n 10 ls')).toBeUndefined();
    expect(parseSimpleCommand('env ls')).toBeUndefined();
    expect(parseSimpleCommand('sudo ls')).toBeUndefined();
    expect(parseSimpleCommand('timeout 5 ls')).toBeUndefined();
    expect(parseSimpleCommand('xargs ls')).toBeUndefined();
  });
});

describe('resolveOnPinnedPath', () => {
  test('resolves a unique executable in the pinned dir', () => {
    const { dir, cleanup } = tempBin('mycmd');
    try {
      expect(resolveOnPinnedPath('mycmd', dir)).toBe(join(dir, 'mycmd'));
      expect(resolveOnPinnedPath('missing', dir)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('rejects names with directory separators', () => {
    const { dir, cleanup } = tempBin('mycmd');
    try {
      expect(resolveOnPinnedPath('./mycmd', dir)).toBeNull();
      expect(resolveOnPinnedPath('/bin/mycmd', dir)).toBeNull();
      expect(resolveOnPinnedPath('', dir)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('rejects duplicate matches across pinned dirs', () => {
    const first = tempBin('dup');
    const second = tempBin('dup');
    try {
      expect(resolveOnPinnedPath('dup', `${first.dir}:${second.dir}`)).toBeNull();
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test('dedupes PATH entries that alias the same file', () => {
    const { dir, cleanup } = tempBin('mycmd');
    const aliasDir = join(tmpdir(), `sentinel-alias-${process.pid}`);
    try {
      symlinkSync(dir, aliasDir);
      expect(resolveOnPinnedPath('mycmd', `${dir}:${aliasDir}`)).toBe(join(dir, 'mycmd'));
    } finally {
      rmSync(aliasDir, { force: true });
      cleanup();
    }
  });
});

describe('matchAllowlist', () => {
  test('matches seeded read-only commands exactly', () => {
    const { config, cleanup } = tempConfig();
    try {
      const parsed = parseSimpleCommand('mycmd -l');
      expect(parsed).toBeDefined();
      if (parsed === undefined) {
        return;
      }
      const matched = matchAllowlist(parsed, config);
      expect(matched).toBeDefined();
      expect(matched?.argv[0]).toBe(join(config.pinned_path, 'mycmd'));
    } finally {
      cleanup();
    }
  });

  test('rejects flag smuggling on an allowlisted binary', () => {
    const { config, cleanup } = tempConfig();
    try {
      const parsed = parseSimpleCommand('mycmd --evil');
      expect(parsed).toBeDefined();
      if (parsed === undefined) {
        return;
      }
      expect(matchAllowlist(parsed, config)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test('rejects non-allowlisted commands', () => {
    const { config, cleanup } = tempConfig();
    try {
      const parsed = parseSimpleCommand('othercmd');
      expect(parsed).toBeDefined();
      if (parsed === undefined) {
        return;
      }
      expect(matchAllowlist(parsed, config)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test('rejects wrappers around allowlisted binaries', () => {
    // 'sh' is a rejected wrapper: the strict parser refuses it outright, so
    // it never reaches allowlist matching.
    expect(parseSimpleCommand('sh -c "mycmd"')).toBeUndefined();
    const { config, cleanup } = tempConfig();
    writeFileSync(join(config.pinned_path, 'nice'), '#!/bin/sh\n');
    try {
      const parsed = parseSimpleCommand('nice mycmd -l');
      expect(parsed).toBeDefined();
      if (parsed === undefined) {
        return;
      }
      // The bare nice wrapper parses, but 'mycmd' under nice still matches
      // the allowlist entry for the underlying command.
      expect(matchAllowlist(parsed, config)).toBeDefined();
    } finally {
      cleanup();
    }
  });
});

describe('matchAllowlist for seeded git', () => {
  const allowed = [
    'git status',
    'git status --short --branch',
    'git log --oneline -n 5',
    'git log --oneline -- src/index.ts',
    'git diff',
    'git diff --cached --stat',
    'git diff --no-ext-diff HEAD',
    'git show HEAD',
    'git show --no-patch HEAD',
    'git branch',
    'git branch --list',
    'git branch -a -v',
    'git rev-parse --show-toplevel',
    'git rev-parse HEAD',
    'git ls-files',
    'git ls-files --others --exclude-standard',
    'git blame src/index.ts',
  ];
  const rejected = [
    'git push origin main',
    'git pull',
    'git fetch',
    'git clone https://example.com/r.git',
    'git remote add origin https://example.com/r.git',
    'git remote -v',
    'git submodule update --init',
    'git config core.fsmonitor "sh x.sh"',
    'git config alias.x "!sh x.sh"',
    'git config --get user.name',
    'git x',
    'git constructor',
    'git __proto__',
    'git "!sh x.sh"',
    'git status "!sh x.sh"',
    'git -c alias.x=!sh status',
    'git -c core.fsmonitor=x status',
    'git -calias.x=!sh x',
    'git --config-env=alias.x=VAR x',
    'git --exec-path=. status',
    'git --exec-path status',
    'git -C . status',
    'git --git-dir=.git status',
    'git --no-pager status',
    'git',
    'git branch newbranch',
    'git branch -D main',
    'git branch --delete main',
    'git branch -m old new',
    'git checkout main',
    'git commit -m x',
    'git reset --hard',
    'git ls-remote',
    'git diff --output=out.txt',
    'git diff --ext-diff',
    'git log --output=out.txt',
    'git show --textconv HEAD',
    'git ls-files --exclude-from=x',
    'git status --upload-pack=x',
  ];

  function matches(command: string, config: ShellAllowlistConfig): boolean {
    const parsed = parseSimpleCommand(command);
    return parsed !== undefined && matchAllowlist(parsed, config) !== undefined;
  }

  test.each(allowed)('accepts %s', command => {
    const { dir, cleanup } = tempBin('git');
    try {
      expect(matches(command, seedShellAllowlist(dir))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test.each(rejected)('rejects %s', command => {
    const { dir, cleanup } = tempBin('git');
    try {
      expect(matches(command, seedShellAllowlist(dir))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('pinAllowlistedExec', () => {
  const hardening = [
    '--no-pager',
    '--no-optional-locks',
    '-c',
    'safe.directory=/ws',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.sshCommand=',
    '-c',
    'diff.external=',
    '-c',
    'diff.ignoreSubmodules=all',
    '-c',
    'submodule.recurse=false',
    '-c',
    'status.submoduleSummary=false',
  ];

  /** Pinned dir holding fake `git`, `ls` and `nice`; the invocation must name them by absolute path. */
  function harden(
    command: string,
    { workspaceRoot }: { workspaceRoot: string | undefined } = { workspaceRoot: '/ws' },
  ): { pinned: PinnedExecInvocation | undefined; dir: string } {
    const { dir, cleanup } = tempBin('git');
    for (const name of ['ls', 'nice']) {
      writeFileSync(join(dir, name), '#!/bin/sh\n');
    }
    try {
      return {
        pinned: pinAllowlistedExec({ command, config: seedShellAllowlist(dir), workspace_root: workspaceRoot }),
        dir,
      };
    } finally {
      cleanup();
    }
  }

  test('pins a non-git command by absolute path even without a workspace root', () => {
    const ls = harden('ls hello.txt', { workspaceRoot: undefined });
    expect(ls.pinned?.argv).toEqual([join(ls.dir, 'ls'), 'hello.txt']);
    expect(ls.pinned?.git_needs_workspace_root).toBe(false);
  });

  test('git without a workspace root is flagged so it is refused rather than run unhardened', () => {
    expect(harden('git status', { workspaceRoot: undefined }).pinned?.git_needs_workspace_root).toBe(true);
  });

  test('prepends global overrides and the subcommand forced flags', () => {
    const status = harden('git status --short');
    expect(status.pinned?.argv).toEqual([
      join(status.dir, 'git'),
      ...hardening,
      'status',
      '--ignore-submodules=all',
      '--short',
    ]);
    const diff = harden('git diff --cached src');
    expect(diff.pinned?.argv).toEqual([
      join(diff.dir, 'git'),
      ...hardening,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--cached',
      'src',
    ]);
    const blame = harden('git blame f.txt');
    expect(blame.pinned?.argv).toEqual([join(blame.dir, 'git'), ...hardening, 'blame', '--no-textconv', 'f.txt']);
  });

  test('isolates system and global config and builds a local-config probe', () => {
    const { pinned, dir } = harden('git status');
    expect(pinned?.env).toEqual({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_PARAMETERS: '',
      GIT_ATTR_NOSYSTEM: '1',
    });
    expect(pinned?.probe_argv).toEqual([
      join(dir, 'git'),
      ...hardening,
      'config',
      '--local',
      '--no-includes',
      '--list',
      '--name-only',
    ]);
    expect(pinned?.pinned_path).toBe(dir);
  });

  test('keeps the nice wrapper in front, by absolute path', () => {
    const { pinned, dir } = harden('nice git status');
    expect(pinned?.argv.slice(0, 2)).toEqual([join(dir, 'nice'), join(dir, 'git')]);
  });

  test('runs other allowlisted commands by absolute path with no probe', () => {
    const { pinned, dir } = harden('ls -l src');
    expect(pinned).toEqual({
      argv: [join(dir, 'ls'), '-l', 'src'],
      probe_argv: null,
      env: {},
      pinned_path: dir,
      git_needs_workspace_root: false,
    });
  });

  test('leaves non-allowlisted commands alone', () => {
    expect(harden('git push origin main').pinned).toBeUndefined();
    expect(harden('git -c core.fsmonitor=x status').pinned).toBeUndefined();
    expect(harden('rm -rf x').pinned).toBeUndefined();
  });

  test('a wrapper that does not resolve on the pinned path is not allowlisted', () => {
    const { dir, cleanup } = tempBin('ls');
    try {
      const config = seedShellAllowlist(dir);
      const parsed = parseSimpleCommand('nice ls');
      expect(parsed === undefined ? undefined : matchAllowlist(parsed, config)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test('glob and brace operands are not allowlisted, since argv is passed literally', () => {
    for (const operand of ['*.ts', 'a?', 'a[0]', 'a{b,c}']) {
      expect(harden(`ls ${operand}`).pinned).toBeUndefined();
    }
  });
});

describe('gitLocalConfigIsSafe', () => {
  test('accepts only the known-safe key set', () => {
    const safe = [
      'core.repositoryformatversion',
      'core.filemode',
      'core.bare',
      'core.logallrefupdates',
      'core.ignorecase',
      'core.precomposeunicode',
      'core.symlinks',
      'remote.origin.url',
      'remote.my.org.fetch',
      'branch.main.remote',
      'branch.feature/x.merge',
      'user.name',
      'user.email',
      'init.defaultbranch',
    ];
    expect(gitLocalConfigIsSafe(safe.join('\n'))).toBe(true);
    expect(gitLocalConfigIsSafe('')).toBe(true);
  });

  test.each([
    'core.fsmonitor',
    'core.pager',
    'core.hookspath',
    'core.alternaterefscommand',
    'core.sshcommand',
    'filter.x.clean',
    'filter.x.smudge',
    'filter.x.process',
    'diff.external',
    'diff.evil.textconv',
    'gpg.program',
    'log.showsignature',
    'include.path',
    'includeif.gitdir:/x.path',
    'extensions.worktreeconfig',
    'alias.x',
    'remote.origin.vcs',
    'remote.origin.pushurl',
    'url.x.insteadof',
  ])('rejects %s even among safe keys', key => {
    expect(gitLocalConfigIsSafe(`core.filemode\n${key}\nuser.name`)).toBe(false);
  });
});

describe('hashArgv', () => {
  test('is deterministic and sensitive to order', () => {
    expect(hashArgv(['ls', '-la'])).toBe(hashArgv(['ls', '-la']));
    expect(hashArgv(['ls', '-la'])).not.toBe(hashArgv(['-la', 'ls']));
  });
});

describe('offline subset', () => {
  test('offline commands are a subset of the seeded allowlist', () => {
    expect(validateOfflineSubset(seedShellAllowlist(PINNED))).toBe(true);
    for (const name of OFFLINE_SHELL_COMMANDS) {
      expect(parseSimpleCommand(name)).toBeDefined();
    }
  });
});

describe('reads the safe list adds: sed print ranges, grep and head', () => {
  const config = seedShellAllowlist(PINNED);
  const matches = (command: string): boolean => {
    const parsed = parseSimpleCommand(command);
    return parsed !== undefined && matchAllowlist(parsed, config) !== undefined;
  };

  test('allows printing a range of lines, and nothing else a sed script can do', () => {
    expect(matches("sed -n '55,172p' README.md")).toBe(true);
    expect(matches("sed -n '12p' README.md")).toBe(true);
    expect(matches("sed -n '1e rm -rf x' README.md")).toBe(false);
    expect(matches("sed -n '1w copy.txt' README.md")).toBe(false);
    expect(matches("sed -i 's/a/b/' README.md")).toBe(false);
    expect(matches('sed -n')).toBe(false);
  });

  test('allows a grep pattern of any shape, but never -R, which follows links out of the workspace', () => {
    expect(matches("grep -rn 'TODO(.*)' src")).toBe(true);
    expect(matches('grep -R TODO src')).toBe(false);
    expect(matches('grep -f patterns.txt src')).toBe(false);
  });

  test('allows head with a count', () => {
    expect(matches('head -n 20 README.md')).toBe(true);
    expect(matches('head -20 README.md')).toBe(true);
    expect(matches('head -7 README.md')).toBe(false);
  });

  test('keeps the offline subset in step with the list', () => {
    expect(validateOfflineSubset(config)).toBe(true);
  });
});

describe('parseReadOnlyList', () => {
  const config = seedShellAllowlist(PINNED);
  const parse = (command: string) => parseReadOnlyList({ command, config });

  test('reads a cd followed by reads, and reads piped into reads', () => {
    expect(parse("cd /workspace/exitramp && sed -n '55,172p' README.md")?.steps).toEqual([
      { kind: 'cd', dir: '/workspace/exitramp' },
      { kind: 'run', parsed: { wrapper: null, argv: ['sed', '-n', '55,172p', 'README.md'] } },
    ]);
    expect(parse('cd exitramp && git status && git log --oneline')?.separators).toEqual(['&&', '&&']);
    expect(parse('grep -rn TODO src | head -20')?.separators).toEqual(['|']);
    expect(parse('ls; pwd')?.separators).toEqual([';']);
  });

  test('is not a list for a single command, a redirect, a substitution, a background job or a command off the list', () => {
    expect(parse('ls -la')).toBeUndefined();
    expect(parse('cd x && cat a > b')).toBeUndefined();
    expect(parse('cd x && cat $(echo a)')).toBeUndefined();
    expect(parse('ls & pwd')).toBeUndefined();
    expect(parse('cd x && rm -rf y')).toBeUndefined();
    expect(parse('ls && ')).toBeUndefined();
  });

  test('never lets a later step run in the directory a failed cd left', () => {
    expect(parse('cd x ; git status')).toBeUndefined();
    expect(parse('cd x && cat a ; git status')).toBeUndefined();
    expect(parse('cd x && cat a || git status')).toBeUndefined();
    expect(parse('ls || cd x && cat a')).toBeUndefined();
    expect(parse('ls | cd x && cat a')).toBeUndefined();
    expect(parse('cd x | cat a')).toBeUndefined();
    expect(parse('ls ; cd x && cat a | head -5')).toBeDefined();
  });

  test('keeps a quoted separator inside its argument', () => {
    expect(parse("grep -n 'a && b' README.md && ls")?.steps).toHaveLength(2);
  });
});

describe('pinReadOnlyList', () => {
  test('pins every command in a list and probes git where it runs', () => {
    const config = seedShellAllowlist(PINNED);
    const pinned = pinReadOnlyList({
      command: 'cd exitramp && git status && cat README.md',
      config,
      workspace_root: '/workspace',
      cwd: '/workspace',
    });
    expect(pinned?.steps[0]).toEqual({ kind: 'cd', dir: 'exitramp' });
    const git = pinned?.steps[1];
    const cat = pinned?.steps[2];
    expect(git?.kind === 'run' && git.argv[0]?.endsWith('/git')).toBe(true);
    expect(git?.kind === 'run' && git.argv).toContain('core.fsmonitor=false');
    expect(git?.kind === 'run' && git.cwd).toBe('/workspace/exitramp');
    expect(cat?.kind === 'run' && cat.argv[0]?.endsWith('/cat')).toBe(true);
    expect(pinned?.probes.map(probe => probe.cwd)).toEqual(['/workspace/exitramp']);
    expect(pinned?.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1' });
  });

  test('refuses git in a list without a workspace to harden it against', () => {
    const pinned = pinReadOnlyList({
      command: 'ls && git status',
      config: seedShellAllowlist(PINNED),
      workspace_root: undefined,
      cwd: '/workspace',
    });
    expect(pinned?.git_needs_workspace_root).toBe(true);
  });
});

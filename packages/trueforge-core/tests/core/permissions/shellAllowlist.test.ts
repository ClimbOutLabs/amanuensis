import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitLocalConfigIsSafe,
  hardenAllowlistedGit,
  hashArgv,
  matchAllowlist,
  OFFLINE_SHELL_COMMANDS,
  parseSimpleCommand,
  resolveOnPinnedPath,
  seedShellAllowlist,
  validateOfflineSubset,
  type HardenedGitInvocation,
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
      mycmd: { args: ['-l'], operands: 'workspace_relative', offline_ok: true, subcommands: null },
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

describe('hardenAllowlistedGit', () => {
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

  function harden(command: string): HardenedGitInvocation | undefined {
    const { dir, cleanup } = tempBin('git');
    try {
      return hardenAllowlistedGit({ command, config: seedShellAllowlist(dir), workspace_root: '/ws' });
    } finally {
      cleanup();
    }
  }

  test('prepends global overrides and the subcommand forced flags', () => {
    expect(harden('git status --short')?.argv).toEqual([
      'git',
      ...hardening,
      'status',
      '--ignore-submodules=all',
      '--short',
    ]);
    expect(harden('git diff --cached src')?.argv).toEqual([
      'git',
      ...hardening,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--cached',
      'src',
    ]);
    expect(harden('git blame f.txt')?.argv).toEqual(['git', ...hardening, 'blame', '--no-textconv', 'f.txt']);
  });

  test('isolates system and global config and builds a local-config probe', () => {
    const hardened = harden('git status');
    expect(hardened?.env).toEqual({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_PARAMETERS: '',
      GIT_ATTR_NOSYSTEM: '1',
    });
    expect(hardened?.probe_argv).toEqual([
      'git',
      ...hardening,
      'config',
      '--local',
      '--no-includes',
      '--list',
      '--name-only',
    ]);
  });

  test('keeps the nice wrapper in front', () => {
    expect(harden('nice git status')?.argv.slice(0, 2)).toEqual(['nice', 'git']);
  });

  test('leaves non-allowlisted and non-git commands alone', () => {
    expect(harden('git push origin main')).toBeUndefined();
    expect(harden('git -c core.fsmonitor=x status')).toBeUndefined();
    expect(harden('ls -l')).toBeUndefined();
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

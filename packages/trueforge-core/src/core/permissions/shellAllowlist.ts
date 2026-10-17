/**
 * Server-side shell allowlist for Sentinel Tier 2 shell commands.
 *
 * A command qualifies only when it parses as a SINGLE simple command. The
 * operative rule is structural: pipes, redirects, lists (`;`, `&&`, `||`,
 * newlines), command substitution, process substitution, and any other
 * compound structure fail closed to Tier 3. The metacharacter check runs on the
 * raw string with quote awareness, so a `;` inside a quoted argument is not
 * misread.
 *
 * Matching requires argv[0] to resolve under a pinned PATH at parse time and
 * every remaining token to match the command's enumerated subcommand/flag
 * list exactly (`--flag=value` and `--flag value` are distinct spellings and
 * are listed separately). The executor runs the resolved absolute program
 * under the same pinned PATH, so the binary that was classified is the one
 * that runs.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { GIT_HARDENING_ENV, gitHardeningConfigEntries } from './gitHardening';

/** Result of parsing a command that is a single simple command. */
export interface ParsedSimpleCommand {
  /** Bare `nice` wrapper when present; any other wrapper fails the parse. */
  wrapper: 'nice' | null;
  /** argv with the wrapper removed; argv[0] is the command name as written. */
  argv: string[];
}

/** Curated per-command argument list. Operands are workspace-relative paths only. */
export interface ShellAllowlistEntry {
  /** Exact tokens allowed after argv[0]: subcommands and every flag spelling. */
  args: readonly string[];
  /** Whether non-flag tokens are allowed, and how they are constrained. */
  operands: 'none' | 'workspace_relative';
  /** True when the command has no network capability (offline-mode subset). */
  offline_ok: boolean;
  /**
   * When non-null the command is subcommand-driven: argv[1] must name one of
   * these and only that subcommand's policy applies; `args`/`operands` are unused.
   */
  subcommands: Readonly<Record<string, ShellSubcommandPolicy>> | null;
}

/** Flags and operands permitted for one subcommand of a subcommand-driven command. */
export interface ShellSubcommandPolicy {
  /** Exact flag spellings allowed after the subcommand. */
  args: readonly string[];
  operands: 'none' | 'workspace_relative';
  /** Flags the executor inserts right after the subcommand; never model-supplied. */
  forced_args: readonly string[];
}

export interface ShellAllowlistConfig {
  /** Pinned PATH used to resolve argv[0] at parse time. */
  pinned_path: string;
  commands: Record<string, ShellAllowlistEntry>;
}

/** Wrapper tokens that are never allowlisted (handled structurally, not matched). */
const REJECTED_WRAPPERS = new Set(['env', 'timeout', 'sudo', 'su', 'xargs', 'find', 'sh', 'bash']);

const ENV_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Quote-aware tokenizer. Returns undefined when the command is anything other
 * than one simple command. A `$` outside single quotes disqualifies (variable
 * expansion and `$(...)`/`${...}` substitution read agent-influenced or
 * hidden state); inside single quotes `$` is a literal and is safe.
 */
export function parseSimpleCommand(command: string): ParsedSimpleCommand | undefined {
  const words: string[] = [];
  let current = '';
  let hasCurrent = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const pushWord = (): void => {
    if (hasCurrent) {
      words.push(current);
      current = '';
      hasCurrent = false;
    }
  };

  for (const ch of command) {
    if (escaped) {
      current += ch;
      hasCurrent = true;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      // Substitution still applies inside double quotes.
      if (quote === '"' && (ch === '$' || ch === '`')) {
        return undefined;
      }
      current += ch;
      hasCurrent = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasCurrent = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      pushWord();
      continue;
    }
    // Structural metacharacters outside quotes: anything compound fails closed.
    if (
      ch === '|' ||
      ch === '&' ||
      ch === ';' ||
      ch === '<' ||
      ch === '>' ||
      ch === '(' ||
      ch === ')' ||
      ch === '`' ||
      ch === '\n' ||
      ch === '\r'
    ) {
      return undefined;
    }
    if (ch === '$' || ch === '~') {
      // Unquoted `$` (expansion/substitution) and `~` (home expansion) are out.
      return undefined;
    }
    current += ch;
    hasCurrent = true;
  }
  if (escaped || quote !== null) {
    return undefined;
  }
  pushWord();
  if (words.length === 0) {
    return undefined;
  }
  // `VAR=val` env-prefix assignments would inject agent-controlled environment
  // (LD_PRELOAD, PYTHONPATH) into the allowlisted binary: rejected outright.
  const first = words[0];
  if (first === undefined || ENV_PREFIX_PATTERN.test(first)) {
    return undefined;
  }
  if (REJECTED_WRAPPERS.has(first)) {
    return undefined;
  }
  let wrapper: 'nice' | null = null;
  let argv = words;
  if (first === 'nice') {
    // Bare form only: `nice` immediately followed by the allowlisted command.
    // Any wrapper argument (e.g. `nice -n 10`) fails closed to Tier 3.
    wrapper = 'nice';
    argv = words.slice(1);
    const argv0 = argv[0];
    if (argv0 === undefined || argv0.startsWith('-') || ENV_PREFIX_PATTERN.test(argv0)) {
      return undefined;
    }
  }
  const argv0 = argv[0];
  if (argv0 === undefined) {
    return undefined;
  }
  return { wrapper, argv };
}

/**
 * Resolve a command name to an absolute path under the pinned PATH. Returns
 * null when the name does not resolve to exactly one executable. Absolute or
 * relative paths (`./x`, `/bin/x`) never resolve: argv[0] must be a bare name.
 * PATH entries that alias the same file (merged-/usr layouts where /bin is a
 * symlink to /usr/bin) count as one match: they name the same binary.
 */
export function resolveOnPinnedPath(name: string, pinnedPath: string): string | null {
  if (name.includes('/') || name === '' || name === '.' || name === '..') {
    return null;
  }
  const matches: string[] = [];
  const seenRealPaths = new Set<string>();
  for (const dir of pinnedPath.split(':')) {
    if (dir === '') {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      if (!existsSync(candidate)) {
        continue;
      }
      const real = realpathSync(candidate);
      if (seenRealPaths.has(real)) {
        continue;
      }
      seenRealPaths.add(real);
      matches.push(candidate);
    } catch {
      return null;
    }
  }
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ?? null;
}

/** Canonical hash of an argv vector, for approval-token binding. */
export function hashArgv(argv: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(argv)).digest('hex');
}

function isWorkspaceRelativeOperand(token: string): boolean {
  // Glob and brace characters are expanded by a shell; the executor passes argv literally, so they ask instead.
  if (token === '' || token.startsWith('/') || token.startsWith('~') || /[*?[\]{}]/u.test(token)) {
    return false;
  }
  const segments = token.split('/');
  if (segments.some(segment => segment === '..')) {
    return false;
  }
  return true;
}

/**
 * The subcommand must be the first token, so global options (`-c`, `-C`,
 * `--exec-path`, `--config-env`) and aliases never reach a policy. A `!`
 * operand is a shell-alias marker and fails closed.
 */
function matchSubcommand(input: {
  tokens: readonly string[];
  subcommands: Readonly<Record<string, ShellSubcommandPolicy>>;
}): boolean {
  const [name, ...rest] = input.tokens;
  if (name === undefined || !Object.hasOwn(input.subcommands, name)) {
    return false;
  }
  const policy = input.subcommands[name];
  if (policy === undefined) {
    return false;
  }
  for (const token of rest) {
    if (token.startsWith('-')) {
      if (!policy.args.includes(token)) {
        return false;
      }
      continue;
    }
    if (token.startsWith('!')) {
      return false;
    }
    if (policy.operands === 'workspace_relative' && isWorkspaceRelativeOperand(token)) {
      continue;
    }
    return false;
  }
  return true;
}

export interface AllowlistMatch {
  /** argv with argv[0] resolved to its absolute path at parse time. */
  argv: string[];
  argv0_resolved: string;
  wrapper: 'nice' | null;
  /** Absolute path of the wrapper program; null when there is no wrapper. */
  wrapper_resolved: string | null;
}

/**
 * Match a parsed simple command against the allowlist. Remaining tokens match
 * exactly against the command's enumerated args; `--flag=value` and
 * `--flag value` are distinct and must each be listed. Non-flag tokens are
 * allowed only when the entry permits workspace-relative operands.
 */
export function matchAllowlist(parsed: ParsedSimpleCommand, config: ShellAllowlistConfig): AllowlistMatch | undefined {
  const argv0 = parsed.argv[0];
  if (argv0 === undefined) {
    return undefined;
  }
  const entry = config.commands[argv0];
  if (entry === undefined) {
    return undefined;
  }
  const argv0Resolved = resolveOnPinnedPath(argv0, config.pinned_path);
  if (argv0Resolved === null) {
    return undefined;
  }
  // The wrapper is a program too: an unresolvable one must not fall back to a shell PATH lookup.
  const wrapperResolved = parsed.wrapper === null ? null : resolveOnPinnedPath(parsed.wrapper, config.pinned_path);
  if (parsed.wrapper !== null && wrapperResolved === null) {
    return undefined;
  }
  const matched = (): AllowlistMatch => ({
    argv: [argv0Resolved, ...parsed.argv.slice(1)],
    argv0_resolved: argv0Resolved,
    wrapper: parsed.wrapper,
    wrapper_resolved: wrapperResolved,
  });
  if (entry.subcommands !== null) {
    if (!matchSubcommand({ tokens: parsed.argv.slice(1), subcommands: entry.subcommands })) {
      return undefined;
    }
    return matched();
  }
  for (const token of parsed.argv.slice(1)) {
    if (token.startsWith('-')) {
      // Flags match exactly; unlisted flags (including smuggled `--config`/`-c`
      // style overrides) fail closed. Listed long-flag tokens are full
      // spellings, never unambiguous prefixes of dangerous flags.
      if (!entry.args.includes(token)) {
        return undefined;
      }
      continue;
    }
    if (entry.args.includes(token)) {
      continue;
    }
    if (entry.operands === 'workspace_relative' && isWorkspaceRelativeOperand(token)) {
      continue;
    }
    return undefined;
  }
  return matched();
}

/**
 * Conservative seed allowlist. Every entry has no network capability and no
 * external effects; curation excludes flag-smuggling (`git --config`/`-c`
 * overrides are absent, so they fail closed). Versioned with server releases;
 * never derived from model output.
 */
export function seedShellAllowlist(pinnedPath: string): ShellAllowlistConfig {
  return {
    pinned_path: pinnedPath,
    commands: {
      ls: {
        args: ['-l', '-a', '-la', '-al', '-lh', '-1', '--all', '--almost-all'],
        operands: 'workspace_relative',
        offline_ok: true,
        subcommands: null,
      },
      cat: {
        args: ['-n'],
        operands: 'workspace_relative',
        offline_ok: true,
        subcommands: null,
      },
      pwd: {
        args: [],
        operands: 'none',
        offline_ok: true,
        subcommands: null,
      },
      git: {
        // Read-only inspection only. Config, remote, network and mutating
        // subcommands, aliases, and global options are absent so they fall to
        // Tier 3. Flags that run external programs or write files are never
        // listed; `forced_args` are added by pinAllowlistedExec at execution.
        args: [],
        operands: 'none',
        offline_ok: true,
        subcommands: {
          status: {
            args: ['--short', '--porcelain', '--branch', '-s', '-b'],
            operands: 'workspace_relative',
            forced_args: ['--ignore-submodules=all'],
          },
          log: {
            args: [
              '--oneline',
              '--stat',
              '--name-only',
              '--name-status',
              '--graph',
              '--decorate',
              '--no-color',
              '--no-ext-diff',
              '--no-textconv',
              '-n',
              '--',
            ],
            operands: 'workspace_relative',
            forced_args: ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all'],
          },
          diff: {
            args: [
              '--cached',
              '--staged',
              '--stat',
              '--shortstat',
              '--numstat',
              '--name-only',
              '--name-status',
              '--no-color',
              '--no-ext-diff',
              '--no-textconv',
              '--',
            ],
            operands: 'workspace_relative',
            forced_args: ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all'],
          },
          show: {
            args: [
              '--no-patch',
              '--stat',
              '--name-only',
              '--name-status',
              '--oneline',
              '--no-color',
              '--no-ext-diff',
              '--no-textconv',
              '--',
            ],
            operands: 'workspace_relative',
            forced_args: ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all'],
          },
          branch: {
            args: ['--list', '--all', '--remotes', '--show-current', '-a', '-r', '-v', '-vv'],
            operands: 'none',
            forced_args: [],
          },
          'rev-parse': {
            args: ['--git-dir', '--show-toplevel', '--abbrev-ref', '--short', '--is-inside-work-tree', '--show-prefix'],
            operands: 'workspace_relative',
            forced_args: [],
          },
          'ls-files': {
            args: [
              '--cached',
              '--modified',
              '--others',
              '--deleted',
              '--stage',
              '--exclude-standard',
              '-c',
              '-m',
              '-o',
              '-d',
              '-s',
              '--',
            ],
            operands: 'workspace_relative',
            forced_args: [],
          },
          blame: {
            args: ['--porcelain', '--line-porcelain', '-w', '-e', '--'],
            operands: 'workspace_relative',
            forced_args: ['--no-textconv'],
          },
        },
      },
      node: {
        args: ['--version'],
        operands: 'none',
        offline_ok: true,
        subcommands: null,
      },
      python3: {
        args: ['--version'],
        operands: 'none',
        offline_ok: true,
        subcommands: null,
      },
    },
  };
}

/** Global git options that disable the known code-running config keys, as defence in depth. */
function gitHardeningGlobalArgs(workspaceRoot: string): string[] {
  return [
    '--no-pager',
    '--no-optional-locks',
    ...gitHardeningConfigEntries({ workspaceRoot }).flatMap(([key, value]) => ['-c', `${key}=${value}`]),
  ];
}

/**
 * Local config keys an allowlisted git command may run under. Fail-closed:
 * every other key (filters, includes, gpg, alternateRefsCommand, hooks, ...)
 * can make git execute a program, so a repo that sets one is not allowlisted.
 */
const SAFE_GIT_LOCAL_CONFIG_KEYS: readonly RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/u,
  /^remote\..+\.(url|fetch)$/u,
  /^branch\..+\.(remote|merge)$/u,
  /^user\.(name|email)$/u,
  /^init\.defaultbranch$/u,
];

/** True when every key printed by `git config --local --list --name-only` is on the safe list. */
export function gitLocalConfigIsSafe(nameOnlyOutput: string): boolean {
  return nameOnlyOutput
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .every(key => SAFE_GIT_LOCAL_CONFIG_KEYS.some(pattern => pattern.test(key)));
}

export interface PinnedExecInvocation {
  /** Argv to execute in place of the model's command; every program in it is an absolute path. */
  argv: string[];
  /** Git only: read-only probe listing the repository's local config key names. */
  probe_argv: string[] | null;
  env: Record<string, string>;
  /** PATH the program runs under, so anything it launches by name resolves on the same pinned path. */
  pinned_path: string;
  /** Git cannot be hardened without a workspace root, so it must not run at all. */
  git_needs_workspace_root: boolean;
}

/**
 * Rewrite an allowlisted command into exactly what the executor must run, or
 * undefined when the command is not allowlisted. Applied at the execution site
 * so the model's argv and the approval binding stay as written. Git gets its
 * hardening and a config probe; the caller must run `probe_argv` and require
 * `gitLocalConfigIsSafe` on its output before running `argv`.
 */
export function pinAllowlistedExec(input: {
  command: string;
  config: ShellAllowlistConfig;
  workspace_root: string | undefined;
}): PinnedExecInvocation | undefined {
  const parsed = parseSimpleCommand(input.command);
  const matched = parsed === undefined ? undefined : matchAllowlist(parsed, input.config);
  if (parsed === undefined || matched === undefined) {
    return undefined;
  }
  const wrapperArgv = matched.wrapper_resolved === null ? [] : [matched.wrapper_resolved];
  const [name, subcommand, ...rest] = parsed.argv;
  const policy =
    name === 'git' && subcommand !== undefined ? input.config.commands[name]?.subcommands?.[subcommand] : undefined;
  if (name !== 'git' || subcommand === undefined || policy === undefined) {
    return {
      argv: [...wrapperArgv, ...matched.argv],
      probe_argv: null,
      env: {},
      pinned_path: input.config.pinned_path,
      git_needs_workspace_root: false,
    };
  }
  if (input.workspace_root === undefined) {
    return {
      argv: [],
      probe_argv: null,
      env: {},
      pinned_path: input.config.pinned_path,
      git_needs_workspace_root: true,
    };
  }
  const globalArgs = gitHardeningGlobalArgs(input.workspace_root);
  return {
    argv: [...wrapperArgv, matched.argv0_resolved, ...globalArgs, subcommand, ...policy.forced_args, ...rest],
    probe_argv: [matched.argv0_resolved, ...globalArgs, 'config', '--local', '--no-includes', '--list', '--name-only'],
    env: { ...GIT_HARDENING_ENV },
    pinned_path: input.config.pinned_path,
    git_needs_workspace_root: false,
  };
}

/**
 * Explicit no-network subset of the allowlist for offline mode. Curated
 * separately from the allowlist itself: a network-capable command added to the
 * allowlist later is not offline-usable until it is listed here.
 * ("read-only" does not imply "no network": `git ls-remote` is read-only and
 * phones home, so it is absent from both lists.)
 */
export const OFFLINE_SHELL_COMMANDS: readonly string[] = ['ls', 'cat', 'pwd', 'git', 'node', 'python3'];

/** True when every allowlisted name in the offline subset exists in the allowlist. */
export function validateOfflineSubset(config: ShellAllowlistConfig): boolean {
  return OFFLINE_SHELL_COMMANDS.every(name => config.commands[name]?.offline_ok === true);
}

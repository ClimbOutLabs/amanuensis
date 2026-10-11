import { parseSimpleCommand } from '../permissions/shellAllowlist';
import { shellEscape } from './provider/Provider';

/**
 * The sandbox never holds a stored git credential: no credential file, no remote
 * URL userinfo, no helper config on ordinary commands. A provider exposes no
 * stdin or secret channel, so the token can only reach github.com through the
 * environment of the one git process the host builds and starts itself. That
 * process runs a strictly validated, hardened argv (the model chooses only
 * allowlisted flags and operands), and the token is not set for any other command.
 */

/** Absolute so a model-writable PATH entry (venv, mcp-client/bin) cannot shadow the binary that receives the token. */
export const HOST_AUTHENTICATED_GIT_BINARY = '/usr/bin/git';

const TOKEN_ENV_KEY = 'TRUEFORGE_GIT_TOKEN';

export type HostAuthenticatedGitSubcommand = 'clone' | 'fetch' | 'pull' | 'push' | 'ls-remote';

export interface HostAuthenticatedGitPlan {
  subcommand: HostAuthenticatedGitSubcommand;
  args: readonly string[];
  /** The command reads the checkout's own config, so it must be proven free of program-running keys first. */
  readsRepositoryConfig: boolean;
}

type OperandShape = 'clone' | 'remote_and_refspecs' | 'ls_remote';

interface SubcommandPolicy {
  flags: ReadonlySet<string>;
  valued: Readonly<Record<string, RegExp>>;
  operands: OperandShape;
  readsRepositoryConfig: boolean;
}

const POSITIVE_INTEGER = /^[1-9][0-9]{0,5}$/u;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/u;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REFSPEC = /^\+?[A-Za-z0-9._/@:^~{}*-]{1,255}$/u;

const POLICIES: Readonly<Record<HostAuthenticatedGitSubcommand, SubcommandPolicy>> = {
  clone: {
    flags: new Set(['--single-branch', '--no-single-branch', '--no-tags', '-q', '--quiet']),
    valued: { '--depth': POSITIVE_INTEGER, '--branch': BRANCH_NAME, '-b': BRANCH_NAME },
    operands: 'clone',
    readsRepositoryConfig: false,
  },
  fetch: {
    flags: new Set([
      '--all',
      '--prune',
      '-p',
      '--tags',
      '-t',
      '--no-tags',
      '--force',
      '-f',
      '--unshallow',
      '--dry-run',
      '-n',
      '-q',
      '--quiet',
    ]),
    valued: { '--depth': POSITIVE_INTEGER },
    operands: 'remote_and_refspecs',
    readsRepositoryConfig: true,
  },
  pull: {
    flags: new Set([
      '--ff-only',
      '--rebase',
      '-r',
      '--no-rebase',
      '--no-edit',
      '--autostash',
      '--prune',
      '-p',
      '--tags',
      '-q',
      '--quiet',
    ]),
    valued: { '--depth': POSITIVE_INTEGER },
    operands: 'remote_and_refspecs',
    readsRepositoryConfig: true,
  },
  push: {
    flags: new Set([
      '-u',
      '--set-upstream',
      '--force-with-lease',
      '--force',
      '-f',
      '--delete',
      '-d',
      '--tags',
      '--follow-tags',
      '--dry-run',
      '-n',
      '--no-verify',
      '--atomic',
      '-q',
      '--quiet',
    ]),
    valued: {},
    operands: 'remote_and_refspecs',
    readsRepositoryConfig: true,
  },
  'ls-remote': {
    flags: new Set(['--heads', '-h', '--tags', '-t', '--refs', '-q', '--quiet']),
    valued: {},
    operands: 'ls_remote',
    readsRepositoryConfig: false,
  },
};

function isHostAuthenticatedSubcommand(value: string): value is HostAuthenticatedGitSubcommand {
  return Object.hasOwn(POLICIES, value);
}

/** True when `git` is followed, possibly after global options, by a network subcommand, however the rest is spelled. */
export function isGitNetworkCommand(command: string): boolean {
  return /(?:^|[\s;&|(])git\s(?:[^;&|]*\s)?(?:clone|fetch|pull|push|ls-remote)(?:\s|$)/u.test(command);
}

function isSafeRelativeDirectory(value: string): boolean {
  return (
    value !== '' &&
    !value.startsWith('/') &&
    !value.startsWith('-') &&
    !value.startsWith('~') &&
    !value.split('/').includes('..')
  );
}

function operandsAreValid(input: { shape: OperandShape; operands: readonly string[] }): boolean {
  const [first, ...rest] = input.operands;
  switch (input.shape) {
    case 'clone':
      return (
        first !== undefined &&
        GITHUB_REPOSITORY_URL.test(first) &&
        rest.length <= 1 &&
        rest.every(isSafeRelativeDirectory)
      );
    case 'ls_remote':
      return first !== undefined && GITHUB_REPOSITORY_URL.test(first) && rest.every(item => REFSPEC.test(item));
    case 'remote_and_refspecs':
      return (
        first === undefined ||
        ((REMOTE_NAME.test(first) || GITHUB_REPOSITORY_URL.test(first)) && rest.every(item => REFSPEC.test(item)))
      );
  }
}

/**
 * Parses a model-authored command into a host-authenticated git plan, or
 * undefined when it is anything but one plain network git command whose every
 * flag and operand is allowlisted. Global options (`-c`, `-C`, `--exec-path`),
 * `--upload-pack`/`--receive-pack`, submodule recursion and non-GitHub URLs are
 * therefore never authenticated.
 */
export function planHostAuthenticatedGit(input: { command: string }): HostAuthenticatedGitPlan | undefined {
  const parsed = parseSimpleCommand(input.command);
  if (parsed === undefined || parsed.wrapper !== null) {
    return undefined;
  }
  const [name, subcommand, ...tokens] = parsed.argv;
  if (name !== 'git' || subcommand === undefined || !isHostAuthenticatedSubcommand(subcommand)) {
    return undefined;
  }
  const policy = POLICIES[subcommand];
  const args: string[] = [];
  const operands: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      return undefined;
    }
    if (!token.startsWith('-')) {
      operands.push(token);
      args.push(token);
      continue;
    }
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const flagName = equals === -1 ? token : token.slice(0, equals);
    const valuePattern = Object.hasOwn(policy.valued, flagName) ? policy.valued[flagName] : undefined;
    if (valuePattern !== undefined) {
      const value = equals === -1 ? tokens[index + 1] : token.slice(equals + 1);
      if (value === undefined || !valuePattern.test(value)) {
        return undefined;
      }
      args.push(token);
      if (equals === -1) {
        args.push(value);
        index += 1;
      }
      continue;
    }
    if (equals === -1 && policy.flags.has(token)) {
      args.push(token);
      continue;
    }
    return undefined;
  }
  if (!operandsAreValid({ shape: policy.operands, operands })) {
    return undefined;
  }
  return { subcommand, args, readsRepositoryConfig: policy.readsRepositoryConfig };
}

const CREDENTIAL_HELPER = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$${TOKEN_ENV_KEY}"; }; f`;

/** Config that ignores everything except the repository's own (separately vetted) config, as env pairs so no argv carries it. */
function gitConfigEnv(input: { entries: readonly (readonly [string, string])[] }): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_PARAMETERS: '',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_CONFIG_COUNT: String(input.entries.length),
  };
  input.entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${String(index)}`] = key;
    env[`GIT_CONFIG_VALUE_${String(index)}`] = value;
  });
  return env;
}

function hardeningEntries(workspaceRoot: string | undefined): (readonly [string, string])[] {
  return [
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['core.sshCommand', ''],
    ['core.askPass', ''],
    ['submodule.recurse', 'false'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ...(workspaceRoot === undefined ? [] : [['safe.directory', workspaceRoot] as const]),
  ];
}

export interface HostAuthenticatedGitExec {
  command: string;
  env: Record<string, string>;
}

/**
 * The token appears only in this env, scoped by git to credential requests for
 * https://github.com; every other credential helper is reset first.
 */
export function buildHostAuthenticatedGit(input: {
  plan: HostAuthenticatedGitPlan;
  token: string;
  workspaceRoot: string | undefined;
}): HostAuthenticatedGitExec {
  const command = [
    HOST_AUTHENTICATED_GIT_BINARY,
    '--no-pager',
    '--no-optional-locks',
    input.plan.subcommand,
    ...input.plan.args,
  ]
    .map(shellEscape)
    .join(' ');
  const env = gitConfigEnv({
    entries: [
      ...hardeningEntries(input.workspaceRoot),
      ['credential.helper', ''],
      ['credential.https://github.com.helper', CREDENTIAL_HELPER],
    ],
  });
  return { command, env: { ...env, [TOKEN_ENV_KEY]: input.token } };
}

/** Token-free probe listing the checkout's local config key names, run before any command that reads that config. */
export function buildHostAuthenticatedGitConfigProbe(input: {
  workspaceRoot: string | undefined;
}): HostAuthenticatedGitExec {
  const command = [
    HOST_AUTHENTICATED_GIT_BINARY,
    '--no-pager',
    '--no-optional-locks',
    'config',
    '--local',
    '--no-includes',
    '--list',
    '--name-only',
  ]
    .map(shellEscape)
    .join(' ');
  return { command, env: gitConfigEnv({ entries: hardeningEntries(input.workspaceRoot) }) };
}

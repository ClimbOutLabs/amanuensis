import { z } from '@hono/zod-openapi';
import {
  GIT_HARDENING_ENV,
  gitHardeningConfigEntries,
  gitNetworkHardeningConfigEntries,
  type GitConfigEntry,
} from '../permissions/gitHardening';
import { parseSimpleCommand } from '../permissions/shellAllowlist';
import { shellEscape } from './provider/Provider';
import { hasControlCharacter } from './slots/git/gitText';

/** Absolute so a model-writable PATH entry (venv, mcp-client/bin) cannot shadow the binary that receives the token. */
export const HOST_AUTHENTICATED_GIT_BINARY = '/usr/bin/git';

const TOKEN_ENV_KEY = 'TRUEFORGE_GIT_TOKEN';

/** Absolute so the env wrapper, like git, is found without any PATH lookup. */
export const ENV_BINARY = '/usr/bin/env';

/**
 * Inherited variables that can redirect, trace or inject code into git; the model cannot set them, the image might.
 * GIT_SSL_CAINFO and GIT_SSL_CAPATH stay: images may supply their only CA bundle through them.
 */
const SCRUBBED_ENV_KEYS: readonly string[] = [
  'GIT_EXEC_PATH',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CONFIG',
  'GIT_CONFIG_SYSTEM',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND',
  'GIT_SSL_NO_VERIFY',
  'GIT_SSL_CERT',
  'GIT_SSL_KEY',
  'GIT_CURL_VERBOSE',
  'GIT_TRACE',
  'GIT_TRACE_CURL',
  'GIT_TRACE_CURL_NO_DATA',
  'GIT_TRACE_PACKET',
  'GIT_TRACE_PERFORMANCE',
  'GIT_TRACE_SETUP',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
];

/** Home and config dirs that exist nowhere, so no per-user git, curl or netrc file is read. */
const PINNED_HOME_ENV: Readonly<Record<string, string>> = {
  HOME: '/nonexistent',
  XDG_CONFIG_HOME: '/nonexistent',
  PATH: '/usr/bin:/bin',
};

/** True when an exec env carries the token, so callers can keep it out of the in-sandbox lock wrapper. */
export function carriesHostAuthenticatedGitToken(env: Readonly<Record<string, string>> | undefined): boolean {
  return env?.[TOKEN_ENV_KEY] !== undefined;
}

export type HostAuthenticatedGitSubcommand = 'clone' | 'fetch' | 'pull' | 'push' | 'ls-remote';

/** Which repository a network git command contacts, as far as its own text says. */
export type GitRemoteTarget =
  { kind: 'url'; url: string } | { kind: 'named'; name: string } | { kind: 'default' } | { kind: 'all' };

export interface HostAuthenticatedGitPlan {
  subcommand: HostAuthenticatedGitSubcommand;
  args: readonly string[];
  remote: GitRemoteTarget;
  /** The command reads the checkout's own config, so it must be proven free of program-running keys first. */
  readsRepositoryConfig: boolean;
  /** Outside a repository the command reads no local config, so a missing one is not a refusal. */
  allowsMissingRepository: boolean;
}

type OperandShape = 'clone' | 'remote_and_refspecs' | 'ls_remote';

interface SubcommandPolicy {
  flags: ReadonlySet<string>;
  valued: Readonly<Record<string, RegExp>>;
  operands: OperandShape;
  readsRepositoryConfig: boolean;
  allowsMissingRepository: boolean;
}

const POSITIVE_INTEGER = /^[1-9][0-9]{0,5}$/u;
export const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/u;
const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const GITHUB_REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/u;
export const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REFSPEC = /^\+?[A-Za-z0-9._/@:^~{}*-]{1,255}$/u;

const POLICIES: Readonly<Record<HostAuthenticatedGitSubcommand, SubcommandPolicy>> = {
  clone: {
    flags: new Set(['--single-branch', '--no-single-branch', '--no-tags', '-q', '--quiet']),
    valued: { '--depth': POSITIVE_INTEGER, '--branch': BRANCH_NAME, '-b': BRANCH_NAME },
    operands: 'clone',
    readsRepositoryConfig: false,
    allowsMissingRepository: false,
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
    allowsMissingRepository: false,
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
    allowsMissingRepository: false,
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
    allowsMissingRepository: false,
  },
  'ls-remote': {
    flags: new Set(['--heads', '-h', '--tags', '-t', '--refs', '-q', '--quiet']),
    valued: {},
    operands: 'ls_remote',
    readsRepositoryConfig: true,
    allowsMissingRepository: true,
  },
};

/**
 * The owner/name and canonical address of a plain github.com repository URL, or undefined for anything else.
 * Dot-only names are refused: git normalizes them away, so a credential scoped to one would cover a whole owner
 * or all of github.com.
 */
export function parseGithubRepository(url: string): { slug: string; canonical: string } | undefined {
  const match = GITHUB_REPOSITORY_URL.exec(url);
  const owner = match?.[1];
  const segment = match?.[2];
  if (owner === undefined || segment === undefined || !GITHUB_OWNER.test(owner)) {
    return undefined;
  }
  const name = segment.endsWith('.git') ? segment.slice(0, -'.git'.length) : segment;
  if (!GITHUB_REPOSITORY_NAME.test(name) || /^\.+$/u.test(name)) {
    return undefined;
  }
  return { slug: `${owner}/${name}`, canonical: `https://github.com/${owner}/${name}.git` };
}

function isGithubRepositoryUrl(value: string): boolean {
  return parseGithubRepository(value) !== undefined;
}

function remoteTargetOf(input: { operand: string | undefined; all: boolean }): GitRemoteTarget {
  if (input.operand === undefined) {
    return input.all ? { kind: 'all' } : { kind: 'default' };
  }
  return REMOTE_NAME.test(input.operand) ? { kind: 'named', name: input.operand } : { kind: 'url', url: input.operand };
}

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
        first !== undefined && isGithubRepositoryUrl(first) && rest.length <= 1 && rest.every(isSafeRelativeDirectory)
      );
    case 'ls_remote':
      return first !== undefined && isGithubRepositoryUrl(first) && rest.every(item => REFSPEC.test(item));
    case 'remote_and_refspecs':
      return (
        first === undefined ||
        ((REMOTE_NAME.test(first) || isGithubRepositoryUrl(first)) && rest.every(item => REFSPEC.test(item)))
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
  if (parsed?.wrapper !== null) {
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
  return {
    subcommand,
    args,
    remote: remoteTargetOf({ operand: operands[0], all: args.includes('--all') }),
    readsRepositoryConfig: policy.readsRepositoryConfig,
    allowsMissingRepository: policy.allowsMissingRepository,
  };
}

const CREDENTIAL_HELPER = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$${TOKEN_ENV_KEY}"; }; f`;

/** Config passed as env pairs so no argv carries it; system and global files are ignored. */
function gitConfigEnv(input: { entries: readonly GitConfigEntry[] }): Record<string, string> {
  const env: Record<string, string> = {
    ...GIT_HARDENING_ENV,
    ...PINNED_HOME_ENV,
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

function hardeningEntries(workspaceRoot: string | undefined): GitConfigEntry[] {
  return [...gitHardeningConfigEntries({ workspaceRoot }), ...gitNetworkHardeningConfigEntries()];
}

/** Every binary is absolute: nothing here may be resolved through a model-writable PATH entry. */
function pinnedGitArgv(gitArguments: readonly string[]): string[] {
  return [
    ENV_BINARY,
    ...SCRUBBED_ENV_KEYS.flatMap(key => ['-u', key]),
    HOST_AUTHENTICATED_GIT_BINARY,
    '--no-pager',
    '--no-optional-locks',
    ...gitArguments,
  ];
}

function pinnedGitCommand(gitArguments: readonly string[]): string {
  return pinnedGitArgv(gitArguments).map(shellEscape).join(' ');
}

/**
 * The token is offered to the named repositories only: git matches the full path (`useHttpPath`), so a remote
 * repointed to another repository, or a redirect to one, is asked for credentials it never receives.
 */
function credentialEntries(input: { repositories: readonly string[] }): GitConfigEntry[] {
  return [
    ['credential.helper', ''],
    ['credential.useHttpPath', 'true'],
    ...[...new Set(input.repositories)].flatMap((slug): GitConfigEntry[] => [
      [`credential.https://github.com/${slug}.git.helper`, CREDENTIAL_HELPER],
      [`credential.https://github.com/${slug}.helper`, CREDENTIAL_HELPER],
    ]),
  ];
}

/** The owner/name slugs of GitHub URLs; a URL that is not a plain github.com repository contributes none. */
function githubSlugs(urls: readonly string[]): string[] {
  return urls.flatMap(url => {
    const repository = parseGithubRepository(url);
    return repository === undefined ? [] : [repository.slug];
  });
}

/**
 * The only variables of the server's own environment that reach host git, so a deployment behind a proxy or
 * with its own certificate authority still works. They configure how git reaches the network and nothing else.
 */
export const GIT_NETWORK_ENV_NAMES: readonly string[] = [
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'CURL_CA_BUNDLE',
];

/** Keeps the allowlisted names with plain values; anything else is dropped. */
export function pickGitNetworkEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of GIT_NETWORK_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined && value !== '' && !hasControlCharacter(value)) {
      picked[name] = value;
    }
  }
  return picked;
}

export interface HostGitInvocation {
  /** Absolute program first; run it with `execFile`, never through a shell. */
  argv: string[];
  /** The complete environment of the process; nothing is inherited from the server. */
  env: Record<string, string>;
}

/**
 * Git run by the server itself for the sandbox slots, whose guests are offline. Same pinned binary, scrubbed
 * environment and hardening config as the in-sandbox form; the token, when given, is only in this process's
 * environment and only offered to https://github.com.
 */
export function buildHostGitInvocation(input: {
  gitArguments: readonly string[];
  token: string | undefined;
  /** GitHub repositories (owner/name) the token may be offered to; ignored without a token. */
  credentialRepositories: readonly string[];
  networkEntries?: readonly GitConfigEntry[] | undefined;
  extraEntries?: readonly GitConfigEntry[] | undefined;
  /** Network settings picked by pickGitNetworkEnv; applied first, so nothing here can override the pinned values. */
  networkEnv?: Readonly<Record<string, string>> | undefined;
  /** Directory git must not search above for a repository. */
  ceilingDirectory?: string | undefined;
}): HostGitInvocation {
  const env = gitConfigEnv({
    entries: [
      ...gitHardeningConfigEntries({ workspaceRoot: undefined }),
      ...(input.networkEntries ?? gitNetworkHardeningConfigEntries()),
      ...(input.extraEntries ?? []),
      ...(input.token === undefined ? [] : credentialEntries({ repositories: input.credentialRepositories })),
    ],
  });
  const complete = {
    ...(input.networkEnv ?? {}),
    ...env,
    ...(input.ceilingDirectory === undefined ? {} : { GIT_CEILING_DIRECTORIES: input.ceilingDirectory }),
  };
  return {
    argv: pinnedGitArgv(input.gitArguments),
    env: input.token === undefined ? complete : { ...complete, [TOKEN_ENV_KEY]: input.token },
  };
}

export interface HostAuthenticatedGitExec {
  command: string;
  env: Record<string, string>;
}

/** A named remote and the canonical GitHub address it was observed to have. */
export const GitRemoteSchema = z.object({ name: z.string().min(1), url: z.string().min(1) });

export type GitRemote = z.infer<typeof GitRemoteSchema>;

/**
 * Network git is the one place a token must reach the sandbox: providers offer
 * no stdin or secret channel. It appears only in this process env, scoped by git
 * to credential requests for https://github.com (every other helper is reset),
 * and callers must run the command outside the in-sandbox lock wrapper.
 */
export function buildHostAuthenticatedGit(input: {
  plan: HostAuthenticatedGitPlan;
  token: string;
  workspaceRoot: string | undefined;
  /** The remotes observed before approval and re-checked at run time; the only repositories offered the token. */
  remotes: readonly GitRemote[];
}): HostAuthenticatedGitExec {
  const command = pinnedGitCommand([input.plan.subcommand, ...input.plan.args]);
  const urlOperand = input.plan.remote.kind === 'url' ? [input.plan.remote.url] : [];
  const repositories = githubSlugs([...urlOperand, ...input.remotes.map(remote => remote.url)]);
  const env = gitConfigEnv({
    entries: [...hardeningEntries(input.workspaceRoot), ...credentialEntries({ repositories })],
  });
  return { command, env: { ...env, [TOKEN_ENV_KEY]: input.token } };
}

/** Token-free, offline git run in the checkout, for reading its own state before anything is authenticated. */
export function buildHostAuthenticatedGitProbe(input: {
  gitArguments: readonly string[];
  workspaceRoot: string | undefined;
}): HostAuthenticatedGitExec {
  return {
    command: pinnedGitCommand(input.gitArguments),
    env: gitConfigEnv({ entries: hardeningEntries(input.workspaceRoot) }),
  };
}

/** Token-free probe listing the checkout's local config key names, run before any command that reads that config. */
export function buildHostAuthenticatedGitConfigProbe(input: {
  workspaceRoot: string | undefined;
}): HostAuthenticatedGitExec {
  return buildHostAuthenticatedGitProbe({
    gitArguments: ['config', '--local', '--no-includes', '--list', '--name-only'],
    workspaceRoot: input.workspaceRoot,
  });
}

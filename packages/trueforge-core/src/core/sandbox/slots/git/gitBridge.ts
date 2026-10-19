import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'winston';
import {
  gitLocalImportHardeningConfigEntries,
  gitObjectCheckConfigEntries,
  type GitConfigEntry,
} from '../../../permissions/gitHardening';
import {
  GIT_REMOTE_CHANGED_REFUSAL,
  gitProbeRunner,
  gitRemotesMatch,
  observeGitRemotes,
  type GitRemotePrecondition,
} from '../../gitRemoteObservation';
import {
  BRANCH_NAME,
  buildHostGitInvocation,
  parseGithubRepository,
  planHostAuthenticatedGit,
  REMOTE_NAME,
  type HostAuthenticatedGitPlan,
} from '../../hostAuthenticatedGit';
import {
  shellEscape,
  type ExecResult,
  type HostGitPushPreview as PushPreview,
  type HostGitPushPreviewResult as PushPreviewResult,
} from '../../provider/Provider';
import { parseBundleHeader } from './bundleHeader';
import { replaceControlCharacters, OBJECT_ID as SHA } from './gitText';
import type { HostCommandLimits, HostCommandResult, HostCommandRunner } from './hostCommand';
import { pushDiffProblem } from './pushChecks';

/** Where repository tars and bundles cross between the server and a guest. */
const TRANSFER_ROOT = '/workspace/.aman/transfer';
const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
const MAX_COMMITS = 500;
const PREVIEW_COMMITS = 50;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_HOST_OUTPUT_BYTES = 8 * 1024 * 1024;
/** The most one operation may leave in its scratch directory: a pack or delta bomb is stopped here. */
const MAX_SCRATCH_BYTES = 1024 * 1024 * 1024;
const SCRATCH_POLL_MS = 1_000;
const HOST_GIT_LIMITS: HostCommandLimits = {
  addressSpaceBytes: 8 * 1024 * 1024 * 1024,
  cpuSeconds: 300,
  fileBytes: MAX_SCRATCH_BYTES,
};
const TAR_BINARY = '/usr/bin/tar';
const HOST_PATH_ENV = { PATH: '/usr/bin:/bin' };
/**
 * The guest is unpacked as its own root, which cannot give files to the server's owner (only one uid is
 * mapped into the guest), so the files are kept as the guest creates them.
 */
const GUEST_UNPACK_FLAGS = '--no-same-owner --no-same-permissions';

/** The guest the bridge moves repositories into and out of. */
export interface BridgeGuest {
  exec(input: {
    command: string;
    env: Record<string, string> | undefined;
    cwd: string | undefined;
    timeoutSeconds: number | undefined;
    signal: AbortSignal | undefined;
  }): Promise<ExecResult>;
  putFile(input: { path: string; content: Buffer; signal: AbortSignal | undefined }): Promise<void>;
  getFile(input: { path: string; signal: AbortSignal | undefined }): Promise<Buffer>;
}

export interface GitBridgeOptions {
  /** Server-side scratch directory, emptied after every operation. */
  scratchRoot: string;
  runner: HostCommandRunner;
  logger: Logger;
  /** Maps a GitHub URL to the address git contacts; identity unless a test points it at a local repository. */
  remoteUrl: ((githubUrl: string) => string) | undefined;
  /** Replaces the network hardening for operations that contact the remote; tests allow `file`. */
  networkEntries: readonly GitConfigEntry[] | undefined;
  now: (() => number) | undefined;
  /** Largest scratch directory one operation may leave behind, bytes; default 1 GiB. */
  scratchCapBytes: number | undefined;
  /** Proxy and certificate settings handed to host git (see pickGitNetworkEnv); empty where none are needed. */
  networkEnv: Readonly<Record<string, string>> | undefined;
}

interface RunInput {
  command: string;
  plan: HostAuthenticatedGitPlan;
  token: string | null;
  /** The repositories the user approved; a fetch or pull that names a remote offers the token to these alone. */
  approvedRemotes: GitRemotePrecondition | undefined;
  guest: BridgeGuest;
  sandboxId: string;
  cwd: string | undefined;
  timeoutSeconds: number | undefined;
  signal: AbortSignal | undefined;
}

class Refusal extends Error {}

const UNAPPROVED_REMOTE_REFUSAL =
  'No repository was shown for approval for this git command, so the host did not authenticate it and it was not run. Run it as a sandbox command so its repository can be reviewed.';

function ok(output: string): ExecResult {
  return { success: true, response: { exitCode: 0, result: output } };
}

function failed(output: string): ExecResult {
  return { success: true, response: { exitCode: 1, result: output } };
}

/** One plain sentence for why the sandbox could not unpack; tar's own words are logged, never shown. */
function unpackFailure(input: { stderr: string; subcommand: string }): string {
  const again = `run git ${input.subcommand} again`;
  if (/No space left on device|File too large|Disk quota exceeded/u.test(input.stderr)) {
    return input.subcommand === 'clone'
      ? 'fatal: the sandbox ran out of space for this repository. Try a shallow clone: git clone --depth 1 <url>.'
      : `fatal: the sandbox ran out of space for this repository. Free some space in the sandbox or start a new chat, then ${again}.`;
  }
  if (
    /Operation not permitted|Permission denied|Invalid argument|Cannot change (?:ownership|mode)/u.test(input.stderr)
  ) {
    return `fatal: the sandbox could not save the repository files. Restart Aman, then ${again}.`;
  }
  return `fatal: the sandbox could not unpack the repository. Restart Aman, then ${again}.`;
}

function hostFailure(stderr: string): string {
  const text = stderr.trim();
  return text === '' ? 'git failed.' : text;
}

function operandsOf(input: { args: readonly string[]; valued: ReadonlySet<string> }): string[] {
  const operands: string[] = [];
  for (let index = 0; index < input.args.length; index += 1) {
    const token = input.args[index] ?? '';
    if (!token.startsWith('-')) {
      operands.push(token);
    } else if (input.valued.has(token)) {
      index += 1;
    }
  }
  return operands;
}

function flagsOf(input: { args: readonly string[]; valued: ReadonlySet<string> }): string[] {
  const flags: string[] = [];
  for (let index = 0; index < input.args.length; index += 1) {
    const token = input.args[index] ?? '';
    if (token.startsWith('-')) {
      flags.push(token);
      if (input.valued.has(token)) {
        flags.push(input.args[index + 1] ?? '');
        index += 1;
      }
    }
  }
  return flags;
}

function depthFlags(args: readonly string[]): string[] {
  const at = args.indexOf('--depth');
  if (at !== -1) {
    return ['--depth', args[at + 1] ?? '1'];
  }
  const inline = args.find(token => token.startsWith('--depth='));
  return inline === undefined ? [] : [inline];
}

function plainSubject(subject: string): string {
  return replaceControlCharacters(subject).replace(/\s+/gu, ' ').trim().slice(0, 100);
}

/**
 * Network git for sandboxes that have no network. The server runs git against GitHub with the user's token,
 * outside any sandbox, and moves repositories across as plain files: a bare repository comes in as a tar and
 * the guest runs the user's own command against it; new commits go out as a bundle that the server unpacks
 * into a scratch repository, checks, and only then pushes.
 */
export class GitBridge {
  private readonly previews = new Map<string, { preview: PushPreview; expiresAt: number }>();
  /** Lets the scratch-size watcher cancel the operation that owns an input. */
  private readonly cancellers = new WeakMap<RunInput, AbortController>();
  private readonly overflowed = new WeakSet<RunInput>();
  private readonly now: () => number;

  constructor(private readonly options: GitBridgeOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Reviews of pushes that are waiting to be carried out. */
  get openReviews(): number {
    return this.previews.size;
  }

  /** The plan when `command` is one plain network git command this bridge carries out. */
  plan(command: string): HostAuthenticatedGitPlan | undefined {
    return planHostAuthenticatedGit({ command });
  }

  /** The input with a signal that also fires when the operation's scratch directory outgrows its cap. */
  private bound(input: RunInput): RunInput {
    const canceller = new AbortController();
    const signal = input.signal === undefined ? canceller.signal : AbortSignal.any([input.signal, canceller.signal]);
    const bounded = { ...input, signal };
    this.cancellers.set(bounded, canceller);
    return bounded;
  }

  async run(unbounded: RunInput): Promise<ExecResult> {
    const input = this.bound(unbounded);
    try {
      switch (input.plan.subcommand) {
        case 'clone':
          return await this.clone(input);
        case 'fetch':
        case 'pull':
          return await this.fetchOrPull(input);
        case 'push':
          return await this.push(input);
        case 'ls-remote':
          return await this.lsRemote(input);
      }
    } catch (error) {
      if (this.overflowed.has(input)) {
        return failed(
          'fatal: this repository is too large for the server to handle on behalf of the sandbox (over 1 GB once unpacked). Try git clone --depth 1 --single-branch <url>.',
        );
      }
      if (error instanceof Refusal) {
        return failed(error.message);
      }
      throw error;
    }
  }

  // ---- clone, fetch, pull ----------------------------------------------------------------------------

  private async clone(input: RunInput): Promise<ExecResult> {
    const operands = operandsOf({ args: input.plan.args, valued: new Set(['--depth', '--branch', '-b']) });
    const rawUrl = operands[0];
    const repo = rawUrl === undefined ? undefined : parseGithubRepository(rawUrl);
    if (rawUrl === undefined || repo === undefined) {
      throw new Refusal('Only https://github.com repositories can be cloned from the sandbox.');
    }
    const flags = flagsOf({ args: input.plan.args, valued: new Set(['--depth', '--branch', '-b']) });
    // Full history of a large repository is the easiest way to exhaust the server, so the default is shallow;
    // `git fetch --unshallow` in the sandbox brings the rest.
    const bounded = flags.some(flag => flag === '--depth' || flag.startsWith('--depth='))
      ? flags
      : ['--depth', '1', ...flags];
    return this.withScratch(input, async scratch => {
      const repoPath = join(scratch, 'repo.git');
      const cloned = await this.hostGit({
        args: ['clone', '--bare', '--quiet', ...bounded, '--', this.contact(repo.canonical), repoPath],
        token: input.token,
        repository: repo.slug,
        network: true,
        cwd: scratch,
        input,
      });
      if (cloned.exitCode !== 0) {
        throw new Refusal(`fatal: could not clone ${repo.slug}: ${hostFailure(cloned.stderr)}`);
      }
      return this.deliverAndRun({ input, scratch, slug: repo.slug });
    });
  }

  private async fetchOrPull(input: RunInput): Promise<ExecResult> {
    const repo = await this.fetchSource(input);
    const noTags = input.plan.args.includes('--no-tags');
    return this.withScratch(input, async scratch => {
      const repoPath = join(scratch, 'repo.git');
      const init = await this.hostGit({
        args: ['init', '--bare', '--quiet', '--template=', repoPath],
        token: undefined,
        repository: undefined,
        network: false,
        cwd: scratch,
        input,
      });
      if (init.exitCode !== 0) {
        throw new Refusal(`fatal: ${hostFailure(init.stderr)}`);
      }
      const fetched = await this.hostGit({
        args: [
          'fetch',
          '--quiet',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          ...(noTags ? ['--no-tags'] : []),
          ...depthFlags(input.plan.args),
          '--',
          this.contact(repo.canonical),
          '+refs/heads/*:refs/heads/*',
          ...(noTags ? [] : ['+refs/tags/*:refs/tags/*']),
        ],
        token: input.token,
        repository: repo.slug,
        network: true,
        cwd: repoPath,
        input,
      });
      if (fetched.exitCode !== 0) {
        throw new Refusal(`fatal: could not fetch ${repo.slug}: ${hostFailure(fetched.stderr)}`);
      }
      return this.deliverAndRun({ input, scratch, slug: repo.slug });
    });
  }

  /**
   * The one repository a fetch or pull contacts: the URL it names, or else the remote the user approved, read
   * again from the guest's own config just before and refused unless it is still that repository.
   */
  private async fetchSource(input: RunInput): Promise<{ slug: string; canonical: string }> {
    const { plan, approvedRemotes } = input;
    if (plan.remote.kind === 'url') {
      const named = parseGithubRepository(plan.remote.url);
      if (named === undefined) {
        throw new Refusal('Only https://github.com remotes can be fetched from the sandbox.');
      }
      return named;
    }
    if (input.token !== null && approvedRemotes === undefined) {
      throw new Refusal(UNAPPROVED_REMOTE_REFUSAL);
    }
    const current = await observeGitRemotes({
      plan,
      run: gitProbeRunner(probe =>
        input.guest.exec({
          command: probe.command,
          env: probe.env,
          cwd: input.cwd,
          timeoutSeconds: 30,
          signal: input.signal,
        }),
      ),
      workspaceRoot: input.cwd,
    });
    if (
      approvedRemotes !== undefined &&
      (current === undefined || !gitRemotesMatch({ approved: approvedRemotes, current }))
    ) {
      throw new Refusal(GIT_REMOTE_CHANGED_REFUSAL);
    }
    const [only, ...others] = current?.remotes ?? [];
    const repository = only === undefined ? undefined : parseGithubRepository(only.url);
    if (repository === undefined) {
      throw new Refusal('Only https://github.com remotes can be fetched from the sandbox.');
    }
    if (others.length > 0) {
      throw new Refusal('fatal: fetch one remote at a time from the sandbox.');
    }
    return repository;
  }

  /** Puts the scratch repository into the guest and runs the user's own command against it. */
  private async deliverAndRun(input: { input: RunInput; scratch: string; slug: string }): Promise<ExecResult> {
    const { guest, signal } = input.input;
    const tarPath = join(input.scratch, 'repo.tar');
    const packed = await this.options.runner.run({
      argv: [TAR_BINARY, '-C', input.scratch, '-cf', tarPath, 'repo.git'],
      env: HOST_PATH_ENV,
      cwd: undefined,
      timeoutMs: 120_000,
      signal,
      maxStdoutBytes: MAX_HOST_OUTPUT_BYTES,
      limits: HOST_GIT_LIMITS,
    });
    if (packed.exitCode !== 0) {
      throw new Refusal(`fatal: could not package the repository: ${hostFailure(this.clean(packed.stderr))}`);
    }
    const tar = await readFile(tarPath);
    if (tar.byteLength > MAX_TRANSFER_BYTES) {
      throw new Refusal(
        'fatal: this repository is too large to bring into the sandbox (over 100 MB). Try a shallow clone: git clone --depth 1 --single-branch <url>.',
      );
    }
    const dir = `${TRANSFER_ROOT}/${randomBytes(8).toString('hex')}`;
    try {
      await guest.putFile({ path: `${dir}/repo.tar`, content: tar, signal });
      const unpacked = await guest.exec({
        command: `tar ${GUEST_UNPACK_FLAGS} -xf ${shellEscape(`${dir}/repo.tar`)} -C ${shellEscape(dir)} && rm -f ${shellEscape(`${dir}/repo.tar`)}`,
        env: undefined,
        cwd: undefined,
        timeoutSeconds: 120,
        signal,
      });
      if (!unpacked.success || unpacked.response.exitCode !== 0) {
        const stderr = unpacked.success ? unpacked.response.result : unpacked.error;
        this.options.logger.warn('git bridge could not unpack a repository in the sandbox', { stderr });
        throw new Refusal(unpackFailure({ stderr, subcommand: input.input.plan.subcommand }));
      }
      // Every spelling of the repository's address is mapped, so the remote resolves however its URL is written.
      const address = `https://github.com/${input.slug}`;
      const command = [
        'git',
        ...[address, `${address}/`, `${address}.git`, `${address}.git/`].flatMap(spelling => [
          '-c',
          `url.file://${dir}/repo.git.insteadOf=${spelling}`,
        ]),
        input.input.plan.subcommand,
        ...input.input.plan.args,
      ]
        .map(shellEscape)
        .join(' ');
      return await guest.exec({
        command,
        env: undefined,
        cwd: input.input.cwd,
        timeoutSeconds: input.input.timeoutSeconds,
        signal,
      });
    } finally {
      await guest
        .exec({
          command: `rm -rf ${shellEscape(dir)}`,
          env: undefined,
          cwd: undefined,
          timeoutSeconds: 60,
          signal: undefined,
        })
        .catch((error: unknown) => {
          this.options.logger.warn('git bridge could not remove a transfer directory', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  private async lsRemote(input: RunInput): Promise<ExecResult> {
    const url = input.plan.args.find(token => token.startsWith('https://'));
    const repo = url === undefined ? undefined : parseGithubRepository(url);
    if (url === undefined || repo === undefined) {
      throw new Refusal('Only https://github.com repositories can be listed from the sandbox.');
    }
    const args = input.plan.args.map(token => (token === url ? this.contact(repo.canonical) : token));
    const listed = await this.withScratch(input, scratch =>
      this.hostGit({
        args: ['ls-remote', ...args],
        token: input.token,
        repository: repo.slug,
        network: true,
        cwd: scratch,
        input,
      }),
    );
    return listed.exitCode === 0 ? ok(listed.stdout.toString('utf8')) : failed(`fatal: ${hostFailure(listed.stderr)}`);
  }

  // ---- push ------------------------------------------------------------------------------------------

  /**
   * Works out what a `git push` would send, from facts the guest reports. It runs before the approval card is
   * shown, and the result is remembered; execution recomputes the same facts from verified objects and refuses
   * unless they match what was approved.
   */
  async previewPush(input: RunInput): Promise<PushPreviewResult> {
    try {
      const preview = await this.describePush(input);
      // The first review stays on record until it is used or expires: if the commits change before the push
      // runs, the push is refused instead of quietly adopting the newer list.
      const key = this.previewKey(input);
      for (const [other, entry] of this.previews) {
        if (entry.expiresAt < this.now()) {
          this.previews.delete(other);
        }
      }
      const existing = this.previews.get(key);
      if (existing === undefined || existing.expiresAt < this.now()) {
        this.previews.set(key, { preview, expiresAt: this.now() + PREVIEW_TTL_MS });
      }
      return { status: 'ok', preview };
    } catch (error) {
      if (error instanceof Refusal) {
        return { status: 'refused', message: error.message };
      }
      throw error;
    }
  }

  private previewKey(input: Pick<RunInput, 'sandboxId' | 'cwd' | 'command'>): string {
    return `${input.sandboxId}\n${input.cwd ?? ''}\n${input.command}`;
  }

  private async describePush(input: RunInput): Promise<PushPreview> {
    const { flags, remote, source, destination } = this.parsePushArguments(input.plan.args);
    // Everything the repository controls (its remote address, branch names, commit subjects) is base64 on a line
    // that starts with a one-time marker, so no text in the repository can add or alter a fact.
    const marker = `aman-${randomBytes(12).toString('hex')}`;
    const script = [
      'set -u',
      `emit() { printf '%s:%s=%s\\n' ${shellEscape(marker)} "$1" "$(printf %s "$2" | base64 -w0)"; }`,
      'cur=$(git symbolic-ref -q --short HEAD || true)',
      `remote=${shellEscape(remote)}`,
      'if [ -z "$remote" ]; then remote=$(git config --get "branch.$cur.remote" 2>/dev/null || true); fi',
      'if [ -z "$remote" ]; then remote=origin; fi',
      `src=${shellEscape(source)}`,
      'if [ "$src" = HEAD ] || [ -z "$src" ]; then src=$cur; fi',
      `dst=${shellEscape(destination)}`,
      'if [ -z "$dst" ]; then dst=$(git config --get "branch.$src.merge" 2>/dev/null | sed "s#^refs/heads/##"); fi',
      'if [ -z "$dst" ]; then dst=$src; fi',
      'case "$remote" in https://*) url=$remote; trackname=origin ;; *) url=$(git remote get-url --push "$remote" 2>/dev/null || true); trackname=$remote ;; esac',
      'tip=$(git rev-parse --verify -q "refs/heads/$src^{commit}" || true)',
      'base=$(git rev-parse --verify -q "refs/remotes/$trackname/$dst^{commit}" || true)',
      'emit remote "$trackname"; emit url "$url"; emit src "$src"; emit dst "$dst"; emit tip "$tip"; emit base "$base"',
      'if [ -n "$tip" ]; then',
      '  if [ -n "$base" ]; then range="$base..$tip"; else',
      '    # A new branch: only commits the remote default branch does not have are new.',
      '    hb=$(git rev-parse --verify -q "refs/remotes/$trackname/HEAD^{commit}" || true)',
      '    if [ -n "$hb" ]; then range="$tip ^$hb"; else range="$tip"; fi',
      '  fi',
      '  emit count "$(git rev-list --count $range)"',
      `  git log --format='%H%x1f%s' -n ${String(PREVIEW_COMMITS)} $range | while IFS= read -r line; do emit commit "$line"; done`,
      'fi',
    ].join('\n');
    const result = await input.guest.exec({
      command: script,
      env: undefined,
      cwd: input.cwd,
      timeoutSeconds: 60,
      signal: input.signal,
    });
    if (!result.success) {
      throw new Refusal(result.error);
    }
    if (result.response.exitCode !== 0) {
      throw new Refusal(`fatal: ${result.response.result.trim() || 'this directory is not a git repository.'}`);
    }
    const facts = new Map<string, string>();
    const commits: { sha: string; subject: string }[] = [];
    for (const line of result.response.result.split('\n')) {
      if (!line.startsWith(`${marker}:`)) {
        continue;
      }
      const field = line.slice(marker.length + 1);
      const eq = field.indexOf('=');
      if (eq === -1) {
        continue;
      }
      const key = field.slice(0, eq);
      const value = Buffer.from(field.slice(eq + 1), 'base64').toString('utf8');
      if (key === 'commit') {
        const [sha = '', subject = ''] = value.split('\u001f');
        if (SHA.test(sha)) {
          commits.push({ sha, subject: plainSubject(subject) });
        }
      } else if (!facts.has(key)) {
        facts.set(key, value);
      }
    }
    const url = facts.get('url') ?? '';
    const repo = parseGithubRepository(url);
    const branch = facts.get('dst') ?? '';
    const sourceBranch = facts.get('src') ?? '';
    const tip = facts.get('tip') ?? '';
    const base = facts.get('base') ?? '';
    const remoteName = facts.get('remote') ?? 'origin';
    if (repo === undefined) {
      throw new Refusal('fatal: only https://github.com remotes can be pushed to from the sandbox.');
    }
    if (!BRANCH_NAME.test(branch) || !BRANCH_NAME.test(sourceBranch) || !REMOTE_NAME.test(remoteName)) {
      throw new Refusal('fatal: this push needs a branch with a plain name.');
    }
    if (!SHA.test(tip)) {
      throw new Refusal(`fatal: there is no local branch '${sourceBranch}' with commits to push.`);
    }
    if (base !== '' && !SHA.test(base)) {
      throw new Refusal('fatal: the remote-tracking branch is malformed.');
    }
    const count = Number.parseInt(facts.get('count') ?? '', 10);
    if (!Number.isInteger(count) || count < 1) {
      throw new Refusal('Everything up-to-date');
    }
    if (count > MAX_COMMITS) {
      throw new Refusal(
        `fatal: this push has ${String(count)} new commits; at most ${String(MAX_COMMITS)} can be pushed at once.`,
      );
    }
    return {
      repository: repo.slug,
      remote_name: remoteName,
      remote_url: repo.canonical,
      source_branch: sourceBranch,
      branch,
      tip,
      base: base === '' ? undefined : base,
      commit_count: count,
      commits,
      dry_run: flags.dryRun,
      set_upstream: flags.setUpstream,
    };
  }

  private parsePushArguments(args: readonly string[]): {
    flags: { dryRun: boolean; setUpstream: boolean };
    remote: string;
    source: string;
    destination: string;
  } {
    const refused = args.find(token =>
      ['--force', '-f', '--force-with-lease', '--delete', '-d', '--tags', '--follow-tags'].includes(token),
    );
    if (refused !== undefined) {
      throw new Refusal(
        `fatal: ${refused} is not available from the sandbox. Pushes can only add commits to a branch; rewriting or deleting remote history has to be done on GitHub.`,
      );
    }
    const operands = args.filter(token => !token.startsWith('-'));
    const [remote = '', refspec = '', ...extra] = operands;
    if (extra.length > 0) {
      throw new Refusal('fatal: push one branch at a time from the sandbox.');
    }
    if (remote !== '' && !REMOTE_NAME.test(remote) && !remote.startsWith('https://')) {
      throw new Refusal('fatal: that remote name is not supported.');
    }
    let source = '';
    let destination = '';
    if (refspec !== '') {
      if (refspec.startsWith('+')) {
        throw new Refusal('fatal: forced pushes (a leading +) are not available from the sandbox.');
      }
      const [from = '', to = '', ...more] = refspec.split(':');
      const strip = (name: string): string => name.replace(/^refs\/heads\//u, '');
      if (
        more.length > 0 ||
        from === '' ||
        (to !== '' && !BRANCH_NAME.test(strip(to))) ||
        (from !== 'HEAD' && !BRANCH_NAME.test(strip(from)))
      ) {
        throw new Refusal('fatal: push a branch, or <branch>:<branch>.');
      }
      source = from === 'HEAD' ? '' : strip(from);
      destination = strip(to);
    }
    return {
      flags: {
        dryRun: args.includes('--dry-run') || args.includes('-n'),
        setUpstream: args.includes('-u') || args.includes('--set-upstream'),
      },
      remote,
      source,
      destination,
    };
  }

  private async push(input: RunInput): Promise<ExecResult> {
    const key = this.previewKey(input);
    const remembered = this.previews.get(key);
    this.previews.delete(key);
    if (remembered === undefined || remembered.expiresAt < this.now()) {
      throw new Refusal(
        'This push was not reviewed first, or its review expired. Run the same push command again so you can see and approve what it sends.',
      );
    }
    const approved = remembered.preview;
    const fresh = await this.describePush(input);
    if (JSON.stringify(fresh) !== JSON.stringify(approved)) {
      throw new Refusal(
        'The commits to push changed after you reviewed them, so nothing was pushed. Run the push again to review the new list.',
      );
    }
    if (approved.dry_run) {
      return ok(this.describeDryRun(approved));
    }
    if (input.token === null) {
      throw new Refusal(
        'fatal: no GitHub connector with a token is attached, so nothing can be pushed. Attach the GitHub connector and try again.',
      );
    }
    return this.withScratch(input, async scratch => {
      const dir = `${TRANSFER_ROOT}/${randomBytes(8).toString('hex')}`;
      try {
        const bundle = await this.bundleInGuest({ input, preview: approved, dir });
        const checked = await this.verifyBundle({ input, preview: approved, bundle, scratch });
        const pushed = await this.hostGit({
          args: [
            'push',
            '--porcelain',
            '--no-verify',
            '--',
            this.contact(approved.remote_url),
            `refs/aman/incoming:refs/heads/${approved.branch}`,
          ],
          token: input.token,
          repository: approved.repository,
          network: true,
          cwd: join(scratch, 'v.git'),
          input,
        });
        if (pushed.exitCode !== 0) {
          throw new Refusal(
            `To ${approved.remote_url}\n ! [remote rejected] ${approved.source_branch} -> ${approved.branch}\n${hostFailure(pushed.stderr)}`,
          );
        }
        await this.recordPushInGuest({ input, preview: approved });
        return ok(this.describePushResult({ preview: approved, remoteTip: checked.remoteTip }));
      } finally {
        await input.guest
          .exec({
            command: `rm -rf ${shellEscape(dir)}`,
            env: undefined,
            cwd: undefined,
            timeoutSeconds: 60,
            signal: undefined,
          })
          .catch((error: unknown) => {
            this.options.logger.warn('git bridge could not remove a transfer directory', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    });
  }

  private async bundleInGuest(input: { input: RunInput; preview: PushPreview; dir: string }): Promise<Buffer> {
    const { guest, signal, cwd } = input.input;
    const ref = `refs/heads/${input.preview.source_branch}`;
    const made = await guest.exec({
      command: [
        `mkdir -p ${shellEscape(input.dir)}`,
        `git bundle create ${shellEscape(`${input.dir}/out.bundle`)} ${shellEscape(ref)}${input.preview.base === undefined ? '' : ` ${shellEscape(`^${input.preview.base}`)}`}`,
      ].join(' && '),
      env: undefined,
      cwd,
      timeoutSeconds: 300,
      signal,
    });
    if (!made.success || made.response.exitCode !== 0) {
      throw new Refusal(
        `fatal: the sandbox could not package the new commits${made.success ? `: ${made.response.result.trim()}` : ''}.`,
      );
    }
    return guest.getFile({ path: `${input.dir}/out.bundle`, signal });
  }

  /** Unpacks the bundle into a scratch repository and refuses unless every rule holds. */
  private async verifyBundle(input: {
    input: RunInput;
    preview: PushPreview;
    bundle: Buffer;
    scratch: string;
  }): Promise<{ remoteTip: string | undefined }> {
    const { preview } = input;
    if (input.bundle.byteLength > MAX_TRANSFER_BYTES) {
      throw new Refusal('fatal: the new commits are too large to push from the sandbox (over 100 MB).');
    }
    const header = parseBundleHeader(input.bundle);
    if (!header.ok) {
      throw new Refusal(`fatal: ${header.reason}.`);
    }
    const expectedRef = `refs/heads/${preview.source_branch}`;
    const [onlyRef, ...otherRefs] = header.header.refs;
    if (onlyRef === undefined || otherRefs.length > 0 || onlyRef.name !== expectedRef || onlyRef.oid !== preview.tip) {
      throw new Refusal('fatal: the package from the sandbox does not contain exactly the branch that was reviewed.');
    }
    const allowedPrerequisites = preview.base === undefined ? [] : [preview.base];
    if (header.header.prerequisites.some(oid => !allowedPrerequisites.includes(oid))) {
      throw new Refusal('fatal: the package from the sandbox builds on commits that were not reviewed.');
    }

    const repoPath = join(input.scratch, 'v.git');
    const init = await this.hostGit({
      args: ['init', '--bare', '--quiet', '--template=', repoPath],
      token: undefined,
      repository: undefined,
      network: false,
      cwd: input.scratch,
      input: input.input,
    });
    if (init.exitCode !== 0) {
      throw new Refusal(`fatal: ${hostFailure(init.stderr)}`);
    }
    const remoteUrl = this.contact(preview.remote_url);
    const fetchedRemote = await this.hostGit({
      args: [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--',
        remoteUrl,
        `+refs/heads/${preview.branch}:refs/aman/remote`,
      ],
      token: input.input.token,
      repository: preview.repository,
      network: true,
      cwd: repoPath,
      input: input.input,
    });
    const remoteExists = fetchedRemote.exitCode === 0;
    if (!remoteExists && !/couldn't find remote ref/iu.test(fetchedRemote.stderr)) {
      throw new Refusal(`fatal: could not read ${preview.repository} on GitHub: ${hostFailure(fetchedRemote.stderr)}`);
    }
    if (!remoteExists && preview.base !== undefined) {
      throw new Refusal(`fatal: the branch ${preview.branch} no longer exists on GitHub, so nothing was pushed.`);
    }
    let rangeBase = remoteExists ? 'refs/aman/remote' : undefined;
    if (!remoteExists) {
      // A new branch: compare against the default branch so only genuinely new commits are checked.
      const head = await this.hostGit({
        args: ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', remoteUrl, '+HEAD:refs/aman/default'],
        token: input.input.token,
        repository: preview.repository,
        network: true,
        cwd: repoPath,
        input: input.input,
      });
      rangeBase = head.exitCode === 0 ? 'refs/aman/default' : undefined;
    }

    const bundlePath = join(input.scratch, 'in.bundle');
    await writeFile(bundlePath, input.bundle, { mode: 0o600 });
    const unpacked = await this.hostGit({
      args: [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--',
        bundlePath,
        `+${expectedRef}:refs/aman/incoming`,
      ],
      token: undefined,
      repository: undefined,
      network: false,
      cwd: repoPath,
      input: input.input,
    });
    if (unpacked.exitCode !== 0) {
      const missing = /prerequisite|missing|not.*complete/iu.test(unpacked.stderr);
      throw new Refusal(
        missing
          ? `fatal: ${preview.branch} on GitHub has changed since the sandbox last fetched it. Run git fetch, then push again.`
          : `fatal: the package from the sandbox was refused: ${hostFailure(unpacked.stderr)}`,
      );
    }
    const incoming = (
      await this.hostGit({
        args: ['rev-parse', '--verify', 'refs/aman/incoming^{commit}'],
        token: undefined,
        repository: undefined,
        network: false,
        cwd: repoPath,
        input: input.input,
      })
    ).stdout
      .toString('utf8')
      .trim();
    if (incoming !== preview.tip) {
      throw new Refusal('fatal: the package from the sandbox does not end at the commit that was reviewed.');
    }

    let remoteTip: string | undefined;
    if (remoteExists) {
      remoteTip = (
        await this.hostGit({
          args: ['rev-parse', '--verify', 'refs/aman/remote^{commit}'],
          token: undefined,
          repository: undefined,
          network: false,
          cwd: repoPath,
          input: input.input,
        })
      ).stdout
        .toString('utf8')
        .trim();
      const ancestor = await this.hostGit({
        args: ['merge-base', '--is-ancestor', 'refs/aman/remote', 'refs/aman/incoming'],
        token: undefined,
        repository: undefined,
        network: false,
        cwd: repoPath,
        input: input.input,
      });
      if (ancestor.exitCode !== 0) {
        throw new Refusal(
          `! [rejected] ${preview.source_branch} -> ${preview.branch} (non-fast-forward)\nThe branch on GitHub has commits you do not have. Run git pull, then push again.`,
        );
      }
    }

    const range = rangeBase === undefined ? ['refs/aman/incoming'] : ['refs/aman/incoming', '--not', rangeBase];
    const list = await this.hostGit({
      args: ['rev-list', '--reverse', ...range],
      token: undefined,
      repository: undefined,
      network: false,
      cwd: repoPath,
      input: input.input,
    });
    const shas = list.stdout
      .toString('utf8')
      .split('\n')
      .filter(line => SHA.test(line));
    const approvedShas = preview.commits.map(commit => commit.sha);
    const newestFirst = [...shas].reverse().slice(0, PREVIEW_COMMITS);
    if (
      shas.length !== preview.commit_count ||
      newestFirst.length !== approvedShas.length ||
      newestFirst.some((sha, index) => sha !== approvedShas[index])
    ) {
      throw new Refusal('The commits in the package are not the ones you reviewed, so nothing was pushed.');
    }
    const raw = await this.hostGit({
      // The hardening config hides submodule changes from diffs; this check needs to see exactly those.
      args: [
        'log',
        '-m',
        '--raw',
        '-z',
        '--no-abbrev',
        '--no-renames',
        '--ignore-submodules=none',
        '--format=%x01%H',
        ...range,
      ],
      token: undefined,
      repository: undefined,
      network: false,
      cwd: repoPath,
      input: input.input,
    });
    if (raw.exitCode !== 0) {
      throw new Refusal(`fatal: the new commits could not be checked: ${hostFailure(raw.stderr)}`);
    }
    const problem = pushDiffProblem(raw.stdout.toString('utf8'));
    if (problem !== undefined) {
      throw new Refusal(`fatal: ${problem}. Submodule changes cannot be pushed from the sandbox.`);
    }
    return { remoteTip };
  }

  private async recordPushInGuest(input: { input: RunInput; preview: PushPreview }): Promise<void> {
    const { preview } = input;
    const lines = [
      `git update-ref ${shellEscape(`refs/remotes/${preview.remote_name}/${preview.branch}`)} ${shellEscape(preview.tip)}`,
      ...(preview.set_upstream
        ? [
            `git branch --set-upstream-to=${shellEscape(`${preview.remote_name}/${preview.branch}`)} ${shellEscape(preview.source_branch)}`,
          ]
        : []),
    ];
    const result = await input.input.guest.exec({
      command: lines.join(' && '),
      env: undefined,
      cwd: input.input.cwd,
      timeoutSeconds: 60,
      signal: undefined,
    });
    if (!result.success || result.response.exitCode !== 0) {
      this.options.logger.warn('git bridge could not update the sandbox tracking ref after a push');
    }
  }

  private describeDryRun(preview: PushPreview): string {
    const lines = preview.commits.map(commit => `  ${commit.sha.slice(0, 7)} ${commit.subject}`);
    return `Would push ${String(preview.commit_count)} commit${preview.commit_count === 1 ? '' : 's'} to ${preview.repository} (${preview.branch}):\n${lines.join('\n')}\n`;
  }

  private describePushResult(input: { preview: PushPreview; remoteTip: string | undefined }): string {
    const { preview } = input;
    const move =
      input.remoteTip === undefined
        ? ' * [new branch]'
        : `   ${input.remoteTip.slice(0, 7)}..${preview.tip.slice(0, 7)}`;
    return `To ${preview.remote_url}\n${move}      ${preview.source_branch} -> ${preview.branch}\n`;
  }

  // ---- host plumbing ---------------------------------------------------------------------------------

  private contact(githubUrl: string): string {
    return this.options.remoteUrl === undefined ? githubUrl : this.options.remoteUrl(githubUrl);
  }

  /** A fresh scratch directory that is removed afterwards and cancels the operation if it outgrows its cap. */
  private async withScratch<T>(input: RunInput, work: (scratch: string) => Promise<T>): Promise<T> {
    await mkdir(this.options.scratchRoot, { recursive: true, mode: 0o700 });
    const scratch = await mkdtemp(join(this.options.scratchRoot, 'op-'));
    const watcher = setInterval(() => {
      void directoryBytes(scratch).then(bytes => {
        if (bytes > (this.options.scratchCapBytes ?? MAX_SCRATCH_BYTES)) {
          this.overflowed.add(input);
          this.cancellers.get(input)?.abort();
        }
      });
    }, SCRATCH_POLL_MS);
    watcher.unref();
    try {
      return await work(scratch);
    } finally {
      clearInterval(watcher);
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Messages for the model never carry the server's scratch paths. */
  private clean(text: string): string {
    const root = this.options.scratchRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return text.replace(new RegExp(`${root}/op-[A-Za-z0-9]+`, 'gu'), '<scratch>');
  }

  private async hostGit(input: {
    args: readonly string[];
    token: string | null | undefined;
    /** The one GitHub repository (owner/name) the token may be offered to. */
    repository: string | undefined;
    network: boolean;
    cwd: string | undefined;
    input: Pick<RunInput, 'timeoutSeconds' | 'signal'>;
  }): Promise<HostCommandResult> {
    const token = input.token ?? undefined;
    const invocation = buildHostGitInvocation({
      gitArguments: input.args,
      token,
      credentialRepositories: input.repository === undefined ? [] : [input.repository],
      networkEntries: input.network ? this.options.networkEntries : gitLocalImportHardeningConfigEntries(),
      extraEntries: gitObjectCheckConfigEntries(),
      networkEnv: input.network ? this.options.networkEnv : undefined,
      ceilingDirectory: this.options.scratchRoot,
    });
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, (input.input.timeoutSeconds ?? 0) * 1000 || DEFAULT_TIMEOUT_MS);
    const result = await this.options.runner.run({
      argv: invocation.argv,
      env: invocation.env,
      cwd: input.cwd,
      timeoutMs,
      signal: input.input.signal,
      maxStdoutBytes: MAX_HOST_OUTPUT_BYTES,
      limits: HOST_GIT_LIMITS,
    });
    const stderr = this.clean(token === undefined ? result.stderr : result.stderr.split(token).join('***'));
    return { ...result, stderr };
  }
}

/** Disk space an operation's scratch directory really holds, counting allocated blocks so sparse files cannot hide. */
async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        try {
          total += (await lstat(join(entry.parentPath, entry.name))).blocks * 512;
        } catch {
          // Removed while counting.
        }
      }
    }
  } catch {
    // The directory is gone: nothing left to count.
  }
  return total;
}

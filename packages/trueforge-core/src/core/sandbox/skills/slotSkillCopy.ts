import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, sep } from 'node:path';
import type { SandboxInitUpload } from '../provider/Provider';
import { shellEscape } from '../provider/Provider';
import { execFileRunner, type HostCommandRunner } from '../slots/git/hostCommand';
import type { GitSkill, Skill } from './SkillMounter';

// A sandbox with no network cannot fetch skills, so the host fetches and checks them. Each skill
// becomes one tar archive, uploaded to the sandbox's transfer folder and unpacked by its own step.
// A skill that fails leaves only itself out.

const DOWNLOAD_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 300_000;
const ARCHIVE_LIST_TIMEOUT_MS = 60_000;
// Same cap the in-sandbox downloader applies. It also fits the sandbox's transfer folder (128 MB).
const MAX_SKILL_BYTES = 100 * 1024 * 1024;
const MAX_SKILL_FILES = 2_000;
const MAX_TOOL_OUTPUT_BYTES = 8 * 1024 * 1024;
const HOST_TOOL_LIMITS = { addressSpaceBytes: 8 * 1024 * 1024 * 1024, cpuSeconds: 300, fileBytes: 1024 * 1024 * 1024 };
const HOST_PATH_ENV = { PATH: '/usr/bin:/bin' };
const TAR_BINARY = '/usr/bin/tar';
const STAGING_DIR_NAME = '.tfy-staging';
const OBJECT_ID = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u;
const REF_PATTERN = /^[A-Za-z0-9._/-]+$/u;

/** What the model sees for a skill that could not be copied. The full error is not shown. */
export const SKILL_COPY_FAILED_REASON = "couldn't be copied into the sandbox";

/** The network failed or answered with an error. */
export class SkillDownloadError extends Error {}

/** The git repository has no such branch, tag or commit. */
export class SkillMissingVersionError extends Error {}

/** The skill is bigger than the size cap. */
export class SkillTooLargeError extends Error {}

/** The skill has no files to load: an empty archive, an empty folder, or a missing folder. */
export class SkillNoFilesError extends Error {}

export type SkillCopyCause = 'download' | 'missing_version' | 'too_large' | 'damaged' | 'no_files';

export interface SkillCopyFailure {
  cause: SkillCopyCause;
}

/** The one plain line a person sees when a skill is left out. Each cause gives one thing to do. */
export function skillCopyFailedNotice(input: { name: string; cause: SkillCopyCause }): string {
  switch (input.cause) {
    case 'download':
      return `The skill ${input.name} couldn't be downloaded, so Aman is working without it. Check your internet connection.`;
    case 'missing_version':
      return `The skill ${input.name} couldn't be loaded because the version you picked wasn't found, so Aman is working without it. Pick another version.`;
    case 'too_large':
      return `The skill ${input.name} is larger than 100 MB, so Aman is working without it. Make it smaller.`;
    case 'damaged':
      return `The skill ${input.name} couldn't be loaded because its files are damaged, so Aman is working without it. Remove it from your skills.`;
    case 'no_files':
      return `The skill ${input.name} has no files to load, so Aman is working without it. Add its files to the skill.`;
    default: {
      const unreachable: never = input.cause;
      throw new Error(`unexpected skill copy cause: ${String(unreachable)}`);
    }
  }
}

export interface SkillCopyDeps {
  /** Downloads a registry skill's tarball. Defaults to an HTTPS fetch with a timeout and size cap. */
  fetchArchive?: ((url: string, signal: AbortSignal) => Promise<Buffer>) | undefined;
  /** Runs git and tar on the host. */
  host?: HostCommandRunner | undefined;
  signal?: AbortSignal | undefined;
}

export interface StagedSkill {
  name: string;
  skill: Skill;
  /** The commit a git skill was fetched at; null for registry skills. */
  objectId: string | null;
  /** The skill's tar archive, uploaded to the sandbox's transfer folder. */
  archive: SandboxInitUpload;
  /** The one step that unpacks and moves the skill into place. Its failure removes only this skill. */
  command: string;
}

export interface SkillCopyResult {
  staged: readonly StagedSkill[];
  /** Skill name to why it was left out. */
  failed: ReadonlyMap<string, SkillCopyFailure>;
}

/**
 * Downloads a registry tarball. Redirects are refused, so the bytes come only from the presigned
 * URL's own host, and the body is read with the size cap enforced while it streams in.
 */
export async function fetchRegistryArchive(input: {
  url: string;
  signal: AbortSignal;
  maxBytes?: number | undefined;
}): Promise<Buffer> {
  const maxBytes = input.maxBytes ?? MAX_SKILL_BYTES;
  let response: Response;
  try {
    response = await fetch(input.url, {
      redirect: 'error',
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
    });
  } catch (error) {
    throw new SkillDownloadError('download could not start', { cause: error });
  }
  if (!response.ok) {
    throw new SkillDownloadError(`download answered ${String(response.status)}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new SkillTooLargeError('skill archive is too large');
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) {
    throw new SkillDownloadError('download had no body');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let next: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;
    try {
      next = await reader.read();
    } catch (error) {
      throw new SkillDownloadError('download was interrupted', { cause: error });
    }
    if (next.done) {
      break;
    }
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SkillTooLargeError('skill archive is too large');
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

// The subdirectory must stay inside the repository: no absolute paths, no `..`, no empty segments.
function isSafeSubdir(path: string): boolean {
  return (
    path === '' ||
    (!path.startsWith('/') &&
      !path.includes('\\') &&
      path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'))
  );
}

function isSafeSkillName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/u.test(name) && !name.startsWith('.tfy-');
}

function isSafeRef(ref: string): boolean {
  return REF_PATTERN.test(ref) && !ref.startsWith('-');
}

function isInside(input: { path: string; root: string }): boolean {
  return input.path === input.root || input.path.startsWith(`${input.root}${sep}`);
}

/**
 * Rejects an archive that is not a tar, holds a link or special file, or has a path that leaves the
 * skill folder. An archive with no files is reported as having no files. The archive is listed,
 * never extracted, on the host.
 */
async function assertSafeArchive(input: {
  archive: Buffer;
  host: HostCommandRunner;
  signal: AbortSignal;
}): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'tfy-archive-'));
  try {
    const file = join(work, 'skill.tar');
    await writeFile(file, input.archive);
    const list = async (flag: string): Promise<string[]> => {
      const result = await input.host.run({
        argv: [TAR_BINARY, flag, file],
        env: HOST_PATH_ENV,
        cwd: work,
        timeoutMs: ARCHIVE_LIST_TIMEOUT_MS,
        signal: input.signal,
        maxStdoutBytes: MAX_TOOL_OUTPUT_BYTES,
        limits: HOST_TOOL_LIMITS,
      });
      if (result.exitCode !== 0) {
        throw new Error('archive could not be read as a tar');
      }
      return result.stdout
        .toString('utf-8')
        .split('\n')
        .filter(line => line !== '');
    };
    const details = await list('-tvf');
    const names = await list('-tf');
    if (details.length !== names.length) {
      throw new Error('archive listing does not match');
    }
    for (const line of details) {
      const kind = line.charAt(0);
      if ((kind !== '-' && kind !== 'd') || line.includes(' link to ')) {
        throw new Error('archive holds a link or a special file');
      }
    }
    for (const name of names) {
      if (name.startsWith('/') || name.split('/').includes('..')) {
        throw new Error('archive path leaves the skill folder');
      }
    }
    if (!details.some(line => line.startsWith('-'))) {
      throw new SkillNoFilesError('archive has no files');
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Checks the skill folder: every entry resolves inside the checkout, no link is followed, and there
 * is at least one file. Any link inside the skill fails the whole skill.
 */
async function checkSkillFolder(input: { skillDir: string; repo: string; expectedDir: string }): Promise<void> {
  const repoReal = await realpath(input.repo);
  let dirReal: string;
  try {
    dirReal = await realpath(input.skillDir);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new SkillNoFilesError('skill folder is missing', { cause: error });
    }
    throw error;
  }
  if (dirReal !== input.expectedDir || !isInside({ path: dirReal, root: repoReal })) {
    throw new Error('skill folder is a link or leaves the repository');
  }
  let count = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error('skill contains a link');
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const real = await realpath(path);
      if (!isInside({ path: real, root: repoReal })) {
        throw new Error('skill file leaves the repository');
      }
      count += 1;
      bytes += (await readFile(real)).byteLength;
      if (bytes > MAX_SKILL_BYTES || count > MAX_SKILL_FILES) {
        throw new SkillTooLargeError('skill is too large');
      }
    }
  };
  await walk(dirReal);
  if (count === 0) {
    throw new SkillNoFilesError('skill folder has no files');
  }
}

function objectIdForRef(input: { lsRemoteStdout: string; ref: string }): string {
  const { ref } = input;
  const refs = input.lsRemoteStdout.split('\n').map(line => line.split('\t'));
  for (const wanted of [`refs/heads/${ref}`, `refs/tags/${ref}`, ref]) {
    const hit = refs.find(([, name]) => name === wanted);
    const sha = hit?.[0];
    if (sha !== undefined && OBJECT_ID.test(sha)) {
      return sha;
    }
  }
  throw new SkillMissingVersionError('ref not found in the repository');
}

/** Sparse-clones the skill folder at a pinned commit, checks it, and packs it into a tar archive. */
async function fetchGitSkill(input: {
  skill: GitSkill;
  host: HostCommandRunner;
  signal: AbortSignal;
}): Promise<{ objectId: string; archive: Buffer }> {
  const { skill, host, signal } = input;
  if (!isSafeSubdir(skill.path) || !isSafeRef(skill.ref) || skill.url.startsWith('-')) {
    throw new Error('git skill has an unsafe url, ref or path');
  }
  const work = await mkdtemp(join(tmpdir(), 'tfy-skill-'));
  try {
    // Hooks, global config and terminal prompts stay off, so a repository cannot run code on the host.
    const env = {
      ...HOST_PATH_ENV,
      HOME: work,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'https',
    };
    const run = async (args: readonly string[], cwd: string): Promise<string> => {
      const result = await host.run({
        argv: ['git', '-c', 'core.hooksPath=/dev/null', ...args],
        env,
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
        signal,
        maxStdoutBytes: MAX_TOOL_OUTPUT_BYTES,
        limits: HOST_TOOL_LIMITS,
      });
      if (result.exitCode !== 0) {
        throw new SkillDownloadError(`git ${args[0] ?? ''} exited with ${String(result.exitCode)}`);
      }
      return result.stdout.toString('utf-8');
    };
    const objectId = OBJECT_ID.test(skill.ref)
      ? skill.ref
      : objectIdForRef({ lsRemoteStdout: await run(['ls-remote', skill.url, skill.ref], work), ref: skill.ref });
    const repo = join(work, 'repo');
    await mkdir(repo);
    await run(['init', '-q', repo], work);
    await run(['-C', repo, 'fetch', '-q', '--depth', '1', '--filter=blob:none', skill.url, objectId], work);
    if (skill.path !== '') {
      await run(['-C', repo, 'sparse-checkout', 'set', '--cone', '--', skill.path], work);
    }
    await run(['-C', repo, 'checkout', '-q', 'FETCH_HEAD'], work);
    const repoReal = await realpath(repo);
    const expectedDir = skill.path === '' ? repoReal : join(repoReal, skill.path);
    await checkSkillFolder({ skillDir: join(repo, skill.path), repo, expectedDir });
    const tarPath = join(work, 'skill.tar');
    const packed = await host.run({
      argv: [TAR_BINARY, '--exclude=.git', '-cf', tarPath, '-C', expectedDir, '.'],
      env: HOST_PATH_ENV,
      cwd: work,
      timeoutMs: GIT_TIMEOUT_MS,
      signal,
      maxStdoutBytes: MAX_TOOL_OUTPUT_BYTES,
      limits: HOST_TOOL_LIMITS,
    });
    if (packed.exitCode !== 0) {
      throw new Error('skill folder could not be packed');
    }
    const archive = await readFile(tarPath);
    if (archive.byteLength > MAX_SKILL_BYTES) {
      throw new SkillTooLargeError('skill archive is too large');
    }
    return { objectId, archive };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Fetches and checks each skill on the host. A skill that fails is left out and reported; the others
 * are staged. Aborts are rethrown.
 */
export async function copySkillsIntoSandbox(input: {
  skills: readonly Skill[];
  skillsDir: string;
  archiveDir: string;
  deps: SkillCopyDeps;
}): Promise<SkillCopyResult> {
  const { skillsDir, archiveDir, deps } = input;
  const signal = deps.signal ?? new AbortController().signal;
  const fetchArchive =
    deps.fetchArchive ?? ((url: string, abort: AbortSignal) => fetchRegistryArchive({ url, signal: abort }));
  const host = deps.host ?? execFileRunner;
  const staged: StagedSkill[] = [];
  const failed = new Map<string, SkillCopyFailure>();

  for (const skill of input.skills) {
    try {
      if (!isSafeSkillName(skill.name)) {
        throw new Error('unsafe skill name');
      }
      const paths = stagingPaths({ skillsDir, archiveDir, name: skill.name });
      if (skill.type === 'registry') {
        const archive = await fetchArchive(skill.presignedUrl, signal);
        await assertSafeArchive({ archive, host, signal });
        staged.push({
          name: skill.name,
          skill,
          objectId: null,
          archive: { remotePath: paths.archive, content: archive },
          command: stageCommand(paths),
        });
        continue;
      }
      const fetched = await fetchGitSkill({ skill, host, signal });
      staged.push({
        name: skill.name,
        skill,
        objectId: fetched.objectId,
        archive: { remotePath: paths.archive, content: fetched.archive },
        command: stageCommand(paths),
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      failed.set(skill.name, { cause: causeOf(error) });
    }
  }
  return { staged, failed };
}

function causeOf(error: unknown): SkillCopyCause {
  if (error instanceof SkillDownloadError) {
    return 'download';
  }
  if (error instanceof SkillMissingVersionError) {
    return 'missing_version';
  }
  if (error instanceof SkillTooLargeError) {
    return 'too_large';
  }
  if (error instanceof SkillNoFilesError) {
    return 'no_files';
  }
  return 'damaged';
}

interface StagingPaths {
  /** Where the skill lives once it is in place. */
  dir: string;
  /** The skill's own folder in the sandbox's staging area, until the move. */
  stage: string;
  /** The skill's tar archive, in the transfer folder. */
  archive: string;
  /** The staging area itself, removed once it is empty. */
  staging: string;
}

function stagingPaths(input: { skillsDir: string; archiveDir: string; name: string }): StagingPaths {
  const staging = posix.join(input.skillsDir, STAGING_DIR_NAME);
  return {
    dir: posix.join(input.skillsDir, input.name),
    stage: posix.join(staging, input.name),
    archive: posix.join(input.archiveDir, `.tfy-skill-${input.name}.tar`),
    staging,
  };
}

// Unpacks into the skill's staging folder and moves it into place. A failure removes this skill's
// staging and archive and exits non-zero, so the sandbox's init carries on without this skill.
function stageCommand(paths: StagingPaths): string {
  const dir = shellEscape(paths.dir);
  const stage = shellEscape(paths.stage);
  const archive = shellEscape(paths.archive);
  const staging = shellEscape(paths.staging);
  return [
    '(',
    [
      `rm -rf -- ${stage}`,
      `mkdir -p -- ${stage}`,
      `tar --no-same-owner --no-same-permissions -xf ${archive} -C ${stage}`,
      `rm -f -- ${archive}`,
      `rm -rf -- ${dir}`,
      `mv -- ${stage} ${dir}`,
    ].join(' && '),
    `) && { rmdir -- ${staging} 2>/dev/null || true; } || { rm -rf -- ${stage} ${archive}; rmdir -- ${staging} 2>/dev/null || true; false; }`,
  ].join(' ');
}

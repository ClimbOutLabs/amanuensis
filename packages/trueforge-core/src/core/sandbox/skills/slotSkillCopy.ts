import { lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { SandboxInitUpload } from '../provider/Provider';
import { shellEscape } from '../provider/Provider';
import { execFileRunner, type HostCommandRunner } from '../slots/git/hostCommand';
import type { GitSkill, Skill } from './SkillMounter';

// A sandbox with no network cannot fetch skills, so the host fetches them and copies the files in.
// Registry tarballs are uploaded and unpacked inside the sandbox; git skills are sparse-cloned here
// and their files uploaded one by one.

const DOWNLOAD_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 300_000;
// Same caps the in-sandbox downloader applies, so a skill cannot be bigger here than there.
const MAX_SKILL_BYTES = 100 * 1024 * 1024;
const MAX_SKILL_FILES = 2_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const HOST_GIT_LIMITS = { addressSpaceBytes: 8 * 1024 * 1024 * 1024, cpuSeconds: 300, fileBytes: 1024 * 1024 * 1024 };
const HOST_PATH_ENV = { PATH: '/usr/bin:/bin' };
const OBJECT_ID = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u;
const REF_PATTERN = /^[A-Za-z0-9._/-]+$/u;

/** What a person sees for a skill that could not be copied. The full error is not shown. */
export const SKILL_COPY_FAILED_REASON = "couldn't be copied into the sandbox";

export interface SkillCopyDeps {
  /** Downloads a registry skill's tarball. Defaults to an HTTPS fetch with a timeout. */
  fetchArchive?: ((url: string, signal: AbortSignal) => Promise<Buffer>) | undefined;
  /** Runs git on the host for git skills. */
  git?: HostCommandRunner | undefined;
  signal?: AbortSignal | undefined;
}

export interface CopiedSkill {
  skill: Skill;
  /** The commit a git skill was fetched at; null for registry skills. */
  objectId: string | null;
}

export interface SkillCopyResult {
  copied: readonly CopiedSkill[];
  /** Files to upload before the unpack commands run. */
  uploads: readonly SandboxInitUpload[];
  /** Shell steps that unpack registry tarballs inside the sandbox. */
  unpackCommands: readonly string[];
  /** Skill name to the plain reason it was left out. */
  failed: ReadonlyMap<string, string>;
}

async function fetchArchiveBytes(url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) });
  if (!response.ok) {
    throw new Error(`download answered ${String(response.status)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SKILL_BYTES) {
    throw new Error('skill archive is too large');
  }
  return bytes;
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

interface SkillFile {
  relPath: string;
  content: Buffer;
}

/** Every regular file under `root`. Symlinks and `.git` are left out, so nothing reads outside the skill. */
async function readSkillFiles(root: string): Promise<SkillFile[]> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) {
    throw new Error('skill path is not a directory');
  }
  const files: SkillFile[] = [];
  let bytes = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.isSymbolicLink()) {
        continue;
      }
      const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const content = await readFile(join(dir, entry.name));
      bytes += content.byteLength;
      if (bytes > MAX_SKILL_BYTES || files.length >= MAX_SKILL_FILES) {
        throw new Error('skill is too large');
      }
      files.push({ relPath, content });
    }
  };
  await walk(root, '');
  return files;
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
  throw new Error('ref not found in the repository');
}

async function fetchGitSkill(input: {
  skill: GitSkill;
  git: HostCommandRunner;
  signal: AbortSignal;
}): Promise<{ objectId: string; files: SkillFile[] }> {
  const { skill, git, signal } = input;
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
      const result = await git.run({
        argv: ['git', '-c', 'core.hooksPath=/dev/null', ...args],
        env,
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
        signal,
        maxStdoutBytes: MAX_GIT_OUTPUT_BYTES,
        limits: HOST_GIT_LIMITS,
      });
      if (result.exitCode !== 0) {
        throw new Error(`git ${args[0] ?? ''} exited with ${String(result.exitCode)}`);
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
    const files = await readSkillFiles(skill.path === '' ? repo : join(repo, skill.path));
    return { objectId, files };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Fetches each skill on the host and lists what to copy into the sandbox. A skill that fails is
 * left out and reported; the others still copy. Aborts are rethrown.
 */
export async function copySkillsIntoSandbox(input: {
  skills: readonly Skill[];
  skillsDir: string;
  deps: SkillCopyDeps;
}): Promise<SkillCopyResult> {
  const { skillsDir, deps } = input;
  const signal = deps.signal ?? new AbortController().signal;
  const fetchArchive = deps.fetchArchive ?? fetchArchiveBytes;
  const git = deps.git ?? execFileRunner;
  const copied: CopiedSkill[] = [];
  const uploads: SandboxInitUpload[] = [];
  const unpackCommands: string[] = [];
  const failed = new Map<string, string>();

  for (const skill of input.skills) {
    try {
      if (!isSafeSkillName(skill.name)) {
        throw new Error('unsafe skill name');
      }
      if (skill.type === 'registry') {
        const archive = await fetchArchive(skill.presignedUrl, signal);
        const archivePath = posix.join(skillsDir, `.tfy-archive-${skill.name}.tar`);
        uploads.push({ remotePath: archivePath, content: archive });
        unpackCommands.push(unpackRegistrySkillCommand({ dir: posix.join(skillsDir, skill.name), archivePath }));
        copied.push({ skill, objectId: null });
        continue;
      }
      const fetched = await fetchGitSkill({ skill, git, signal });
      for (const file of fetched.files) {
        uploads.push({ remotePath: posix.join(skillsDir, skill.name, file.relPath), content: file.content });
      }
      copied.push({ skill, objectId: fetched.objectId });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      failed.set(skill.name, SKILL_COPY_FAILED_REASON);
    }
  }
  return { copied, uploads, unpackCommands, failed };
}

// The tarball's own layout is the skill directory, as the downloader would extract it. Ownership
// from the host's tar entries is dropped: the sandbox's root user cannot take a host file owner.
function unpackRegistrySkillCommand(input: { dir: string; archivePath: string }): string {
  const dir = shellEscape(input.dir);
  const archive = shellEscape(input.archivePath);
  return [
    `rm -rf -- ${dir}`,
    `mkdir -p -- ${dir}`,
    `tar --no-same-owner --no-same-permissions -xf ${archive} -C ${dir}`,
    `rm -f -- ${archive}`,
  ].join(' && ');
}

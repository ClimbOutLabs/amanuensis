import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { chmod, chown, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCodeProgramName, type RunCodeLanguage, type SandboxIdentity } from './IsolationDriver';

/** Uid:gid of the sandbox user, used when the server is root and cannot run the code as itself. */
const IMAGE_SANDBOX_UID = 65532;
const IMAGE_SANDBOX_GID = 65532;

/**
 * Curated container environment; the host process env never passes through.
 * USER and LOGNAME are explicit because getpwuid fails for a uid that is not in
 * the image's passwd file.
 */
export const SANDBOX_RUN_ENV: Readonly<Record<string, string>> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  HOME: '/scratch',
  USER: 'sandbox',
  LOGNAME: 'sandbox',
  // Belt-and-braces: offline environment, so stray installs fail fast.
  PIP_NO_INDEX: '1',
  npm_config_registry: 'http://127.0.0.1:1/',
};

/**
 * A non-root server runs the container as itself: everything it stages is then
 * already accessible, with no chown it could not perform and no supplementary
 * groups. Root cannot (the container user must be non-root), so it hands the
 * run dirs to the image's sandbox user instead. A non-root server whose gid is
 * 0 is refused: the sandbox must never run in group 0. The effective ids are
 * used because they own the files the server creates; a setuid launch can leave
 * the real ids different.
 */
export function resolveSandboxIdentity(): SandboxIdentity {
  const uid = process.geteuid?.();
  const gid = process.getegid?.();
  if (uid === undefined || gid === undefined || uid === 0) {
    return { uid: IMAGE_SANDBOX_UID, gid: IMAGE_SANDBOX_GID, chownRunDirs: true };
  }
  if (gid === 0) {
    throw new Error(
      `the server runs as uid ${String(uid)} with gid 0, and the sandbox must never run in group 0; run the server with a non-zero primary group`,
    );
  }
  return { uid, gid, chownRunDirs: false };
}

/** Parent of every per-run root, so the readiness canary shares the filesystem of real runs. */
export function sandboxRunsDir(dataDir: string): string {
  return join(dataDir, 'sandbox-runs');
}

export interface StagedRunDirs {
  runRoot: string;
  ingressDir: string;
  scratchDir: string;
  egressDir: string;
}

/** Staged files are server-owned 0400, so the sandbox uid must own the files too, not only the dirs. */
async function chownRecursive(input: { root: string; identity: SandboxIdentity }): Promise<void> {
  await chown(input.root, input.identity.uid, input.identity.gid);
  const entries = await readdir(input.root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(input.root, entry.name);
    if (entry.isDirectory()) {
      await chownRecursive({ root: full, identity: input.identity });
    } else {
      await chown(full, input.identity.uid, input.identity.gid);
    }
  }
}

/**
 * Creates the per-run dirs (0700) and stages the files plus the program into
 * ingress (0400). When the server cannot run as the sandbox uid the dirs are
 * handed over to it, and a failed handoff throws: running anyway would fail
 * later on permissions with a far less useful error.
 */
export async function stageRunDirs(input: {
  runRoot: string;
  language: RunCodeLanguage;
  code: string;
  files: readonly { name: string; bytes: Buffer }[];
  identity: SandboxIdentity;
}): Promise<StagedRunDirs> {
  await mkdir(join(input.runRoot, 'ingress'), { recursive: true, mode: 0o700 });
  await mkdir(join(input.runRoot, 'scratch'), { recursive: true, mode: 0o700 });
  await mkdir(join(input.runRoot, 'egress'), { recursive: true, mode: 0o700 });
  // realpath guards against symlink games on the parent.
  const runRoot = await realpath(input.runRoot).catch(() => input.runRoot);
  const ingressDir = join(runRoot, 'ingress');
  const scratchDir = join(runRoot, 'scratch');
  const egressDir = join(runRoot, 'egress');

  for (const file of input.files) {
    await writeFile(join(ingressDir, file.name), file.bytes, { mode: 0o400 });
  }
  // The program rides in ingress under a reserved name (never harvested).
  await writeFile(join(ingressDir, runCodeProgramName(input.language)), input.code, { mode: 0o400 });

  if (input.identity.chownRunDirs) {
    try {
      for (const root of [ingressDir, scratchDir, egressDir]) {
        await chownRecursive({ root, identity: input.identity });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `could not hand the run directories to sandbox uid ${String(input.identity.uid)}:${String(input.identity.gid)}: ${detail}`,
        { cause: error },
      );
    }
  }
  return { runRoot, ingressDir, scratchDir, egressDir };
}

/**
 * Bytes under scratch + egress, the two user-writable dirs; ingress
 * holds harness-staged inputs the model cannot grow. Undefined when du fails or
 * its output is unparseable, so callers can fail closed.
 */
export function measureRunDiskUsage(input: { scratchDir: string; egressDir: string }): Promise<number | undefined> {
  const parseTotalBytes = (stdout: string, perLineUnitBytes: number): number | undefined => {
    let total = 0;
    let lines = 0;
    for (const line of stdout.split('\n')) {
      const first = line.split(/\s+/)[0];
      if (first === undefined || first === '') {
        continue;
      }
      const n = Number.parseInt(first, 10);
      if (!Number.isFinite(n)) {
        return undefined;
      }
      total += n * perLineUnitBytes;
      lines += 1;
    }
    return lines === 2 ? total : undefined;
  };
  return new Promise(resolve => {
    // --apparent-size counts sparse writes honestly; fall back to -sk on BSD du.
    execFile(
      'du',
      ['-sb', '--apparent-size', input.scratchDir, input.egressDir],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          execFile(
            'du',
            ['-sk', input.scratchDir, input.egressDir],
            { timeout: 5000 },
            (fallbackError, fallbackStdout) => {
              if (fallbackError) {
                resolve(undefined);
                return;
              }
              resolve(parseTotalBytes(fallbackStdout, 1024));
            },
          );
          return;
        }
        resolve(parseTotalBytes(stdout, 1));
      },
    );
  });
}

/** The entry as lstat last saw it, still a real dir or file at the same inode; undefined when it changed. */
async function stillSame(path: string, seen: Stats): Promise<Stats | undefined> {
  const now = await lstat(path).catch(() => undefined);
  const unchanged = now?.dev === seen.dev && now.ino === seen.ino;
  return unchanged && (now.isDirectory() || now.isFile()) ? now : undefined;
}

/**
 * Gives the owner back rwx on dirs and rw on files so a tree whose permissions
 * sandbox code stripped can be deleted. Only real dirs and files are touched:
 * chmod and readdir follow symlinks, so each entry is re-checked with lstat right
 * before it is used. Best-effort: the removal that follows reports anything still stuck.
 */
async function restoreOwnerAccess(path: string): Promise<void> {
  const seen = await lstat(path).catch(() => undefined);
  if (seen === undefined || (!seen.isDirectory() && !seen.isFile())) {
    return;
  }
  const beforeChmod = await stillSame(path, seen);
  if (beforeChmod === undefined) {
    return;
  }
  await chmod(path, (beforeChmod.mode & 0o7777) | (beforeChmod.isDirectory() ? 0o700 : 0o600)).catch(() => undefined);
  if (!beforeChmod.isDirectory() || (await stillSame(path, seen)) === undefined) {
    return;
  }
  const names = await readdir(path).catch(() => []);
  for (const name of names) {
    await restoreOwnerAccess(join(path, name));
  }
}

/**
 * Deletes a run tree. Owner access is restored first only when the run's
 * container is confirmed stopped and removed: while it may be alive, sandbox
 * code could swap entries for symlinks between the check and the chmod. A tree
 * whose removal then fails stays for the reaper; throws when the removal fails.
 */
export async function removeRunTree({ runRoot, runStopped }: { runRoot: string; runStopped: boolean }): Promise<void> {
  if (runStopped) {
    await restoreOwnerAccess(runRoot);
  }
  await rm(runRoot, { recursive: true, force: true });
}

import fs from "node:fs";
import path from "node:path";

/**
 * Resolve `filename` inside `baseDir` and refuse anything that escapes the
 * base. Mirrors the pattern that download_attachment has used since v1; this
 * helper exists so download_email (and any new code path that writes a file
 * derived from external input) can share it.
 *
 * Steps:
 *   1. Reduce filename to its basename so absolute paths and `../` prefixes
 *      are stripped before joining.
 *   2. Resolve both base and full path to absolute form.
 *   3. Verify the full path is within (or equal to) the resolved base.
 *
 * Throws Error("Invalid filename: path traversal detected") on violation.
 */
export function safeJoinWithinBase(baseDir: string, filename: string): string {
  const safeName = path.basename(filename);
  const resolvedBase = path.resolve(baseDir);
  const fullPath = path.resolve(resolvedBase, safeName);
  // path.relative is robust against the `baseDir === "/"` edge case where
  // a naive `startsWith(resolvedBase + path.sep)` would compare against "//".
  const rel = path.relative(resolvedBase, fullPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    if (fullPath !== resolvedBase) {
      throw new Error("Invalid filename: path traversal detected");
    }
  }
  return fullPath;
}

/**
 * True when `target` is inside `base` — both compared as absolute,
 * symlink-resolved paths. Precise about the `..` prefix so a sibling whose
 * name merely starts with `..` is not misclassified as an escape.
 */
export function isWithinBase(base: string, target: string): boolean {
  if (target === base) return true;
  const rel = path.relative(base, target);
  return !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/**
 * Resolve a user-supplied file path against a sandbox `baseDir` for READS
 * (email attachments / inline images). The file must exist.
 *
 * - Relative paths resolve against the base dir.
 * - Absolute paths are allowed only when they land inside the base dir.
 * - Symlinks are followed (realpath) on both the base and the target, so a
 *   symlink pointing outside the base is rejected.
 *
 * Throws on missing files and on escape attempts.
 */
export function resolveSandboxedFile(baseDir: string, userPath: string): string {
  let realBase: string;
  try {
    realBase = fs.realpathSync(baseDir);
  } catch {
    throw new Error(`Sandbox directory is not accessible: ${baseDir}`);
  }
  const candidate = path.isAbsolute(userPath)
    ? path.normalize(userPath)
    : path.resolve(realBase, userPath);
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(candidate);
  } catch {
    throw new Error(`File does not exist: ${userPath}`);
  }
  if (!isWithinBase(realBase, realTarget)) {
    throw new Error(`Path is outside the allowed attachments directory: ${userPath}`);
  }
  return realTarget;
}

/**
 * Resolve a user-supplied directory path against a sandbox `baseDir` for
 * WRITES (download_attachment / download_email savePath). The directory is
 * created when missing.
 *
 * - Empty/undefined resolves to the base dir itself.
 * - Relative paths resolve against the base dir.
 * - Absolute paths are allowed only when they land inside the base dir.
 * - Directories are created ONE LEVEL AT A TIME, resolving symlinks at each
 *   level and re-checking containment. A naive `mkdir -p` would happily
 *   create `<base>/evil-link/subdir` when `evil-link` points outside the
 *   base — the directory would be created outside BEFORE any post-hoc
 *   realpath check could reject it. Component-wise creation closes that
 *   nested-symlink escape.
 *
 * Throws on escape attempts. Returns the real (symlink-resolved) path.
 */
export function resolveSandboxedDir(baseDir: string, userDir?: string): string {
  fs.mkdirSync(baseDir, { recursive: true });
  const realBase = fs.realpathSync(baseDir);
  const candidate =
    !userDir || userDir.trim().length === 0
      ? realBase
      : path.isAbsolute(userDir)
        ? path.normalize(userDir)
        : path.resolve(realBase, userDir);
  if (!isWithinBase(realBase, candidate)) {
    throw new Error(`Directory is outside the allowed downloads directory: ${userDir}`);
  }
  // Walk from the base to the candidate one component at a time so a
  // symlink at any level cannot redirect creation outside the base.
  const rel = path.relative(realBase, candidate);
  const parts = rel.split(path.sep).filter((p) => p.length > 0 && p !== "." && p !== "..");
  let cur = realBase;
  for (const part of parts) {
    const next = path.join(cur, part);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(next);
    } catch {
      st = undefined;
    }
    if (st && !st.isSymbolicLink() && !st.isDirectory()) {
      throw new Error(`Path component is not a directory: ${userDir}`);
    }
    if (!st) {
      // Parent `cur` is real and inside the base by construction, so a
      // single-level mkdir cannot escape.
      fs.mkdirSync(next);
    }
    const realNext = fs.realpathSync(next);
    if (!isWithinBase(realBase, realNext)) {
      throw new Error(`Directory resolves outside the allowed downloads directory: ${userDir}`);
    }
    cur = realNext;
  }
  return cur;
}

/**
 * Write `content` to `filePath` without following a symlink at the final
 * component. If the destination already exists as a symlink (planted by an
 * attacker, or left over from an earlier exploit), the write is refused
 * instead of being redirected outside the sandbox. The O_NOFOLLOW open
 * closes the check-then-write race on POSIX; the lstat pre-check gives a
 * clear error message on every platform.
 *
 * `filePath` must already be contained in the sandbox (use
 * safeJoinWithinBase first) — this only guards the final component.
 */
export function writeFileNoFollow(filePath: string, content: string | Buffer): void {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    st = undefined;
  }
  if (st?.isSymbolicLink()) {
    throw new Error(`Refusing to write through a symlink: ${filePath}`);
  }
  if (st && !st.isFile()) {
    throw new Error(`Refusing to write to non-regular file: ${filePath}`);
  }
  const O_NOFOLLOW: number = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

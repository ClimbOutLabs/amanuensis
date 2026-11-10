/**
 * The path rules of the Notes folder connector: which folders may be picked (never one that
 * overlaps any of Aman's own data folders: its memory, its persona knowledge, the app data
 * folder that holds its database, or the root the sandbox slot workspace disks live under),
 * which note paths a tool may touch
 * (inside the folder, Markdown only, never a way out), and what the inbox file may be called
 * (a plain file name, so an append can only ever land in the folder's top level). The overlap
 * check follows links on disk before it compares, so a link cannot dress one of Aman's
 * folders up as another folder. Every problem is one plain sentence that says the one thing
 * to do next.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export const NOTES_FOLDER_OVERLAP_MESSAGE =
  'That folder is one of the folders Aman keeps its own data in, so it cannot be your notes folder too. Pick the folder that holds your notes, such as the vault you open in Obsidian.';
export const NOTES_FOLDER_NOT_FOUND_MESSAGE =
  'Aman could not find that folder on this computer. Check the path and try again.';
export const NOTES_FOLDER_NOT_A_FOLDER_MESSAGE =
  'That path is a file, not a folder. Pick the folder that holds your notes and try again.';
export const NOTES_FOLDER_EMPTY_MESSAGE = 'Type the path of the folder that holds your notes.';
export const INBOX_FILE_NAME_MESSAGE =
  'The inbox file name must be a plain Markdown file name, like Aman inbox.md, with no folders in it.';
export const NOTE_PATH_MESSAGE =
  'That is not a note inside your notes folder. Use the path of a Markdown note in the folder, like Projects/Ideas.md.';
export const NOTE_NOT_FOUND_MESSAGE =
  'Aman could not find that note in your notes folder. Check the name and try again.';
export const NOTE_ALREADY_THERE_MESSAGE =
  'A note is already there under that name, and Aman does not change notes that are already written. Pick a different name.';
export const INBOX_FILE_MISSING_MESSAGE =
  'Your notes inbox file is not there. Check the folder in Settings, under Connectors, Notes folder.';

/** The absolute form of a path as typed, resolved against the server's working directory. */
export function resolveFolderPath(folderPath: string): string {
  return path.resolve(folderPath.trim());
}

/** True when two absolute paths are the same place, or one holds the other. */
export function pathsOverlap({ a, b }: { a: string; b: string }): boolean {
  const first = path.resolve(a);
  const second = path.resolve(b);
  if (first === second) {
    return true;
  }
  return isUnder({ child: first, parent: second }) || isUnder({ child: second, parent: first });
}

/** True when `child` sits inside `parent` (both already resolved). */
export function isUnder({ child, parent }: { child: string; parent: string }): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** The real location of a path, links followed, or null when it is not on disk to be read. */
async function realPathOrNull(target: string): Promise<string | null> {
  return realpath(target).catch(() => null);
}

/**
 * The overlap problem for a picked folder, or null when it may be used. The folder is
 * compared against every one of Aman's own data folders. Both sides are compared where they
 * really are: a picked folder that is a link to one of those folders, into it, or around it
 * is the same overlap as naming the place outright. A side that is not on disk yet is
 * compared as written.
 */
export async function folderOverlapProblem({
  folderPath,
  protectedDirs,
}: {
  folderPath: string;
  protectedDirs: readonly string[];
}): Promise<string | null> {
  const folder = resolveFolderPath(folderPath);
  const realFolder = await realPathOrNull(folder);
  for (const protectedDir of protectedDirs) {
    const dir = path.resolve(protectedDir);
    const realDir = await realPathOrNull(dir);
    if (pathsOverlap({ a: realFolder ?? folder, b: realDir ?? dir })) {
      return NOTES_FOLDER_OVERLAP_MESSAGE;
    }
  }
  return null;
}

/** The problem with an inbox file name, or null when it is a plain Markdown file name. */
export function inboxFileNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (
    trimmed === '' ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.length > 255 ||
    !trimmed.toLowerCase().endsWith('.md')
  ) {
    return INBOX_FILE_NAME_MESSAGE;
  }
  return null;
}

/**
 * The problem with a note path a tool named, or null when it is a Markdown note inside the
 * folder. Paths are the folder-relative form the search results hand back, such as
 * `Projects/Ideas.md`; anything absolute, anything climbing out with `..`, and anything that
 * is not Markdown is refused here, before the disk is touched.
 */
export function notePathProblem(relativePath: string): string | null {
  const trimmed = relativePath.trim();
  if (trimmed === '' || path.isAbsolute(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return NOTE_PATH_MESSAGE;
  }
  const segments = trimmed.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some(segment => segment === '..')) {
    return NOTE_PATH_MESSAGE;
  }
  if (!segments[segments.length - 1]?.toLowerCase().endsWith('.md')) {
    return NOTE_PATH_MESSAGE;
  }
  return null;
}

/** The folder-relative form of a note path, with the folder's own separators. */
export function normalizeNotePath(relativePath: string): string {
  return relativePath
    .trim()
    .split(/[\\/]+/)
    .filter(segment => segment !== '' && segment !== '.')
    .join(path.sep);
}

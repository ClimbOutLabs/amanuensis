import { shellEscape } from './provider/Provider';

export const GIT_INDEX_ENTRIES_COMMAND = 'git ls-files -s -z';

/**
 * Prints `kind NUL path NUL value NUL` per tracked path, then each batch's raw content hashes as
 * `H NUL hashes NUL`. Unlike a worktree `git diff`, nothing here runs a clean filter or textconv.
 */
const TRACKED_WORKTREE_SCRIPT = [
  'for p do',
  '  shift',
  '  if [ -L "$p" ]; then printf "l\\0%s\\0" "$p"; readlink -- "$p" || exit 255; printf "\\0"',
  '  elif [ -f "$p" ]; then',
  '    if [ -x "$p" ]; then k=x; else k=f; fi',
  '    printf "%s\\0%s\\0\\0" "$k" "$p"',
  '    set -- "$@" "$p"',
  '  elif [ -d "$p" ]; then printf "d\\0%s\\0\\0" "$p"',
  '  elif [ -e "$p" ]; then printf "o\\0%s\\0\\0" "$p"',
  '  else printf "m\\0%s\\0\\0" "$p"',
  '  fi',
  'done',
  'if [ "$#" -gt 0 ]; then printf "H\\0"; git hash-object --no-filters -- "$@" || exit 255; printf "\\0"; fi',
].join('\n');
export const TRACKED_WORKTREE_COMMAND = `git ls-files -z | xargs -0 sh -c ${shellEscape(TRACKED_WORKTREE_SCRIPT)} sh`;

export interface TrackedWorktreeEntry {
  path: string;
  kind: string;
  value: string;
}

/**
 * Pairs each regular file with its hash and checks the listing covers exactly the index's paths.
 * Submodules are left out, matching the capture's `diff.ignoreSubmodules=all`.
 */
export function parseTrackedWorktreeListing(input: {
  listing: string;
  indexEntries: string;
}): TrackedWorktreeEntry[] | undefined {
  const indexPaths = new Set<string>();
  const submodulePaths = new Set<string>();
  for (const entry of input.indexEntries.split('\0')) {
    if (entry === '') {
      continue;
    }
    const match = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/su.exec(entry);
    const mode = match?.[1];
    const path = match?.[2];
    if (mode === undefined || path === undefined) {
      return undefined;
    }
    indexPaths.add(path);
    if (mode === '160000') {
      submodulePaths.add(path);
    }
  }
  const tokens = input.listing.split('\0');
  if (tokens.pop() !== '') {
    return undefined;
  }
  const entries = new Map<string, TrackedWorktreeEntry>();
  let unhashed: TrackedWorktreeEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const kind = tokens[index];
    if (kind === 'H') {
      const hashes = (tokens[index + 1] ?? '').split('\n').filter(line => line !== '');
      if (hashes.length !== unhashed.length) {
        return undefined;
      }
      unhashed.forEach((entry, position) => {
        entry.value = hashes[position] ?? '';
      });
      unhashed = [];
      index += 2;
      continue;
    }
    const path = tokens[index + 1];
    const value = tokens[index + 2];
    if (kind === undefined || !/^[lfxdom]$/u.test(kind) || path === undefined || value === undefined) {
      return undefined;
    }
    const entry = { path, kind, value };
    entries.set(path, entry);
    if (kind === 'f' || kind === 'x') {
      unhashed.push(entry);
    }
    index += 3;
  }
  if (unhashed.length > 0 || entries.size !== indexPaths.size || [...indexPaths].some(path => !entries.has(path))) {
    return undefined;
  }
  return [...entries.values()].filter(entry => !submodulePaths.has(entry.path));
}

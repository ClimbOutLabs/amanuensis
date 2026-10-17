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
 * True when a path came out of the exec output altered: undecodable bytes turn into U+FFFD, so two
 * distinct names could read as one and an edit to either would go unseen.
 */
export function pathLostBytes(path: string): boolean {
  return path.includes('\uFFFD');
}

/**
 * Pairs each regular file with its hash and checks the listing covers exactly the index's paths, as
 * often as the index lists them (once per conflict stage). Fails closed on any path that lost bytes
 * or repeats where the index does not. Submodules are left out, matching `diff.ignoreSubmodules=all`.
 */
export function parseTrackedWorktreeListing(input: {
  listing: string;
  indexEntries: string;
}): TrackedWorktreeEntry[] | undefined {
  const indexCounts = new Map<string, number>();
  const indexKeys = new Set<string>();
  const submodulePaths = new Set<string>();
  for (const entry of input.indexEntries.split('\0')) {
    if (entry === '') {
      continue;
    }
    const match = /^(\d{6}) [0-9a-f]+ (\d)\t(.+)$/su.exec(entry);
    const mode = match?.[1];
    const stage = match?.[2];
    const path = match?.[3];
    if (mode === undefined || stage === undefined || path === undefined || pathLostBytes(path)) {
      return undefined;
    }
    const key = `${stage}\t${path}`;
    if (indexKeys.has(key)) {
      return undefined;
    }
    indexKeys.add(key);
    indexCounts.set(path, (indexCounts.get(path) ?? 0) + 1);
    if (mode === '160000') {
      submodulePaths.add(path);
    }
  }
  const tokens = input.listing.split('\0');
  if (tokens.pop() !== '') {
    return undefined;
  }
  const listed: TrackedWorktreeEntry[] = [];
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
    if (
      kind === undefined ||
      !/^[lfxdom]$/u.test(kind) ||
      path === undefined ||
      value === undefined ||
      pathLostBytes(path)
    ) {
      return undefined;
    }
    const entry = { path, kind, value };
    listed.push(entry);
    if (kind === 'f' || kind === 'x') {
      unhashed.push(entry);
    }
    index += 3;
  }
  if (unhashed.length > 0) {
    return undefined;
  }
  const entries = new Map<string, TrackedWorktreeEntry>();
  const listedCounts = new Map<string, number>();
  for (const entry of listed) {
    const earlier = entries.get(entry.path);
    if (earlier !== undefined && (earlier.kind !== entry.kind || earlier.value !== entry.value)) {
      return undefined;
    }
    entries.set(entry.path, entry);
    listedCounts.set(entry.path, (listedCounts.get(entry.path) ?? 0) + 1);
  }
  if (
    listedCounts.size !== indexCounts.size ||
    [...indexCounts].some(([path, count]) => listedCounts.get(path) !== count)
  ) {
    return undefined;
  }
  return [...entries.values()].filter(entry => !submodulePaths.has(entry.path));
}

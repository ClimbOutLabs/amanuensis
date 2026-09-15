import { parsePatch as jsdiffParsePatch } from 'diff';
import { posix, win32 } from 'node:path';
import { structuredEditReceivedSnippet, structuredEditRejection } from './structuredEditRejection';

const MAX_STRUCTURED_EDIT_PATHS = 512;
const MAX_STRUCTURED_EDIT_PATH_LENGTH = 1_024;
const MAX_STRUCTURED_PATCH_LENGTH = 512 * 1_024;

interface StructuredEditPathContext {
  repositoryRoot: string;
  cwd: string;
}

export type StructuredEditPathRequest = StructuredEditPathContext &
  (
    | { kind: 'apply_patch'; patch: string }
    | { kind: 'replace_text'; path: string }
    | { kind: 'write_file'; path: string }
  );

export type StructuredEditPathResolution =
  { status: 'valid'; paths: string[]; normalized_patch: string | undefined } | { status: 'invalid'; failure: string };

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function repositoryRelativeProviderPath(input: { repositoryRoot: string; target: string }): string | undefined {
  if (input.repositoryRoot.includes('\u0000') || input.target.includes('\u0000')) {
    return undefined;
  }
  const windowsStyle = /^[A-Za-z]:[\\/]/u.test(input.repositoryRoot) || input.repositoryRoot.includes('\\');
  const pathApi = windowsStyle ? win32 : posix;
  if (!pathApi.isAbsolute(input.repositoryRoot) || !pathApi.isAbsolute(input.target)) {
    return undefined;
  }
  const relativePath = pathApi.relative(pathApi.normalize(input.repositoryRoot), pathApi.normalize(input.target));
  if (pathApi.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${pathApi.sep}`)) {
    return undefined;
  }
  return relativePath.replace(/\\/gu, '/');
}

/** Compare a provider-reported Git root with the host-owned repository root. */
export function repositoryRootsMatch(input: { expected: string; actual: string }): boolean {
  return repositoryRelativeProviderPath({ repositoryRoot: input.expected, target: input.actual }) === '';
}

function isSafeRepositoryPath(path: string): boolean {
  return !(
    path.length === 0 ||
    path.length > MAX_STRUCTURED_EDIT_PATH_LENGTH ||
    containsControlCharacter(path) ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[a-z]:/iu.test(path) ||
    path.startsWith('//') ||
    path.split('/').some(part => part === '..' || part === '.' || part.length === 0)
  );
}

/**
 * Rewrite one structured edit target as cwd-relative. A path already relative is returned
 * unchanged. An absolute path is accepted only when it resolves inside the effective root
 * (`repositoryRoot`); it is then rewritten as the equivalent cwd-relative path so every caller
 * validates one shape, and downstream callers apply the same traversal rule they already apply
 * to a hand-written "../x" — an absolute path that resolves above cwd but still inside the root
 * is rejected there, not here.
 */
export function structuredEditCwdRelativePath(input: {
  repositoryRoot: string;
  cwd: string;
  path: string;
}): string | undefined {
  if (input.path.includes('\u0000')) {
    return undefined;
  }
  const windowsStyle = /^[A-Za-z]:[\\/]/u.test(input.repositoryRoot) || input.repositoryRoot.includes('\\');
  const pathApi = windowsStyle ? win32 : posix;
  if (!pathApi.isAbsolute(input.path)) {
    return input.path;
  }
  if (!pathApi.isAbsolute(input.repositoryRoot) || !pathApi.isAbsolute(input.cwd)) {
    return undefined;
  }
  const normalizedTarget = pathApi.normalize(input.path);
  if (
    repositoryRelativeProviderPath({ repositoryRoot: input.repositoryRoot, target: normalizedTarget }) === undefined
  ) {
    return undefined;
  }
  const cwdRelative = pathApi.relative(pathApi.normalize(input.cwd), normalizedTarget).replace(/\\/gu, '/');
  return cwdRelative.length === 0 ? '.' : cwdRelative;
}

/** Normalize one structured edit target against the host-owned repository root and effective cwd. */
export function repositoryRelativeStructuredEditPath(input: {
  repositoryRoot: string;
  cwd: string;
  path: string;
}): string | undefined {
  const path = structuredEditCwdRelativePath(input);
  if (path === undefined) {
    return undefined;
  }
  if (
    path.length > MAX_STRUCTURED_EDIT_PATH_LENGTH ||
    containsControlCharacter(path) ||
    path.includes('\\') ||
    path.split(/[\\/]/u).some(part => part === '..' || part === '.' || part.length === 0)
  ) {
    return undefined;
  }
  const windowsStyle = /^[A-Za-z]:[\\/]/u.test(input.repositoryRoot) || input.repositoryRoot.includes('\\');
  const pathApi = windowsStyle ? win32 : posix;
  if (
    repositoryRelativeProviderPath({
      repositoryRoot: input.repositoryRoot,
      target: input.cwd,
    }) === undefined
  ) {
    return undefined;
  }
  const repositoryPath = repositoryRelativeProviderPath({
    repositoryRoot: input.repositoryRoot,
    target: pathApi.resolve(input.cwd, path),
  });
  return repositoryPath !== undefined && isSafeRepositoryPath(repositoryPath) ? repositoryPath : undefined;
}

interface ParsedGitPathToken {
  value: string;
  remainder: string;
}

const gitPathEncoder = new TextEncoder();
const gitPathDecoder = new TextDecoder('utf-8', { fatal: true });
const gitPathSimpleEscapes: Readonly<Record<string, number>> = {
  '"': 0x22,
  '\\': 0x5c,
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
};

function bytesForGitPath(input: string): number[] | undefined {
  const bytes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== '\\') {
      const codePoint = input.codePointAt(index);
      if (codePoint === undefined) {
        return undefined;
      }
      const literal = String.fromCodePoint(codePoint);
      bytes.push(...gitPathEncoder.encode(literal));
      index += literal.length - 1;
      continue;
    }
    const escaped = input[index + 1];
    if (escaped === undefined) {
      return undefined;
    }
    const simpleByte = gitPathSimpleEscapes[escaped];
    if (simpleByte !== undefined) {
      bytes.push(simpleByte);
      index += 1;
      continue;
    }
    if (!/[0-7]/u.test(escaped)) {
      return undefined;
    }
    let octal = escaped;
    while (octal.length < 3) {
      const next = input[index + octal.length + 1];
      if (next === undefined || !/[0-7]/u.test(next)) {
        break;
      }
      octal += next;
    }
    const byte = Number.parseInt(octal, 8);
    if (byte > 0xff) {
      return undefined;
    }
    bytes.push(byte);
    index += octal.length;
  }
  return bytes;
}

/** Decode one token using Git's core.quotePath C-quoting rules, including octal UTF-8 bytes. */
function parseGitPathToken(input: string): ParsedGitPathToken | undefined {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('"')) {
    const match = /^(\S+)([\s\S]*)$/u.exec(trimmed);
    const value = match?.[1];
    const remainder = match?.[2];
    return value === undefined || remainder === undefined ? undefined : { value, remainder };
  }
  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== '"') {
      continue;
    }
    const bytes = bytesForGitPath(trimmed.slice(1, index));
    if (bytes === undefined) {
      return undefined;
    }
    try {
      return {
        value: gitPathDecoder.decode(Uint8Array.from(bytes)),
        remainder: trimmed.slice(index + 1),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseExactGitPath(input: string): string | undefined {
  const parsed = parseGitPathToken(input);
  return parsed?.remainder.trim().length === 0 ? parsed.value : undefined;
}

function splitDiffHeader(value: string): [string, string] | undefined {
  const first = parseGitPathToken(value);
  if (first === undefined) {
    return undefined;
  }
  const second = parseGitPathToken(first.remainder);
  return second?.remainder.trim().length === 0 ? [first.value, second.value] : undefined;
}

function normalizedDiffPath(input: { value: string }): string | undefined {
  if (containsControlCharacter(input.value) || input.value.includes('\\')) {
    return undefined;
  }
  return isSafeRepositoryPath(input.value) ? input.value : undefined;
}

function isAbsoluteStructuredEditPath(input: { repositoryRoot: string; path: string }): boolean {
  const windowsStyle = /^[A-Za-z]:[\\/]/u.test(input.repositoryRoot) || input.repositoryRoot.includes('\\');
  const pathApi = windowsStyle ? win32 : posix;
  return pathApi.isAbsolute(input.path);
}

interface DiffHeaderComponent {
  path: string;
  rewritten: boolean;
}

/**
 * Resolve one side of a `diff --git`, `---`, or `+++` header token. A relative token must
 * carry the expected `a/`/`b/` prefix, as always. An absolute token is accepted only when it
 * resolves inside the effective root, and is rewritten to the cwd-relative form so the
 * normalized patch handed to `git apply` only ever contains relative headers.
 */
function resolveDiffHeaderComponent(input: {
  value: string;
  prefix: 'a/' | 'b/';
  context: StructuredEditPathContext;
}): DiffHeaderComponent | undefined {
  if (containsControlCharacter(input.value) || input.value.includes('\\')) {
    return undefined;
  }
  if (input.value.startsWith(input.prefix)) {
    const path = input.value.slice(2);
    return isSafeRepositoryPath(path) ? { path, rewritten: false } : undefined;
  }
  if (!isAbsoluteStructuredEditPath({ repositoryRoot: input.context.repositoryRoot, path: input.value })) {
    return undefined;
  }
  const cwdRelative = structuredEditCwdRelativePath({
    repositoryRoot: input.context.repositoryRoot,
    cwd: input.context.cwd,
    path: input.value,
  });
  return cwdRelative !== undefined && isSafeRepositoryPath(cwdRelative)
    ? { path: cwdRelative, rewritten: true }
    : undefined;
}

type DiffMarkerPath = { path: null; remainder: string } | { path: string; rewritten: boolean; remainder: string };

interface PatchOperation {
  kind: 'rename' | 'copy';
  from: string | undefined;
  to: string | undefined;
}

interface StrictPatchSection {
  oldHeaderPath: string;
  newHeaderPath: string;
  oldMarker: DiffMarkerPath | undefined;
  newMarker: DiffMarkerPath | undefined;
  sawHunk: boolean;
  sawSimilarity: boolean;
  operation: PatchOperation | undefined;
  /**
   * Set when a `new file mode`/`deleted file mode` metadata line is seen. A section with no hunk
   * is otherwise rejected as incomplete, but a metadata-only section is exactly what Git emits for
   * creating or deleting a genuinely empty file (no content to add or remove), so this flag is
   * what lets `completedSectionPaths` accept that one case without a hunk.
   */
  metadataOnlyKind: 'new' | 'deleted' | undefined;
}

interface PatchHunk {
  headerIndex: number;
  oldStart: string;
  newStart: string;
  trailer: string;
  declaredOldCount: number;
  declaredNewCount: number;
  /** Raw body lines seen so far, in order — handed to jsdiff for the final recount/validation. */
  bodyLines: string[];
  /**
   * Running tally used only to decide, while still scanning, whether the hunk's declared counts
   * have been satisfied (so a boundary heuristic like `looksLikeUndeclaredSection` may fire, and
   * so a hunk that runs dry before satisfying its own declared header is rejected outright rather
   * than silently recounted down — see `recountHunk`). The authoritative recount and validation
   * of the body's content (line markers, "\ No newline" placement, the empty-side-collapses-to-0
   * convention) is jsdiff's job, once the hunk's full body is known.
   */
  observedOldCount: number;
  observedNewCount: number;
}

interface StructuredPatchAnalysis {
  /** Cwd-relative, slash-normalized effective old/new targets from every section. */
  targets: string[];
  /** The same patch with host-recounted hunk line totals and normalized newlines. */
  normalizedPatch: string;
}

function diffMarkerPath(input: {
  value: string;
  prefix: 'a/' | 'b/';
  context: StructuredEditPathContext;
}): DiffMarkerPath | undefined {
  const parsed = parseGitPathToken(input.value);
  if (parsed === undefined || (parsed.remainder.trim().length > 0 && !parsed.remainder.startsWith('\t'))) {
    return undefined;
  }
  if (parsed.value === '/dev/null') {
    return { path: null, remainder: parsed.remainder };
  }
  const component = resolveDiffHeaderComponent({ value: parsed.value, prefix: input.prefix, context: input.context });
  return component === undefined
    ? undefined
    : { path: component.path, rewritten: component.rewritten, remainder: parsed.remainder };
}

function metadataPath(line: string, prefix: string): string | undefined {
  const value = line.slice(prefix.length);
  const raw = value.startsWith('"') ? parseExactGitPath(value) : value.length > 0 ? value : undefined;
  return raw === undefined ? undefined : normalizedDiffPath({ value: raw });
}

function completedSectionPaths(section: StrictPatchSection): string[] | undefined {
  const operation = section.operation;
  if (operation !== undefined) {
    if (
      !section.sawSimilarity ||
      operation.from === undefined ||
      operation.to === undefined ||
      operation.from !== section.oldHeaderPath ||
      operation.to !== section.newHeaderPath ||
      operation.from === operation.to
    ) {
      return undefined;
    }
    if (!section.sawHunk && section.oldMarker === undefined && section.newMarker === undefined) {
      return [operation.from, operation.to];
    }
  } else if (section.oldHeaderPath !== section.newHeaderPath) {
    return undefined;
  }
  const oldMarker = section.oldMarker;
  const newMarker = section.newMarker;
  if (oldMarker === undefined || newMarker === undefined) {
    return undefined;
  }
  if (!section.sawHunk) {
    // No hunk: the only well-formed case is a metadata-only create or delete of a genuinely
    // empty file, which Git itself never emits a hunk for.
    if (
      section.metadataOnlyKind === 'new' &&
      oldMarker.path === null &&
      newMarker.path !== null &&
      newMarker.path === section.newHeaderPath
    ) {
      return [section.oldHeaderPath, section.newHeaderPath, newMarker.path];
    }
    if (
      section.metadataOnlyKind === 'deleted' &&
      newMarker.path === null &&
      oldMarker.path !== null &&
      oldMarker.path === section.oldHeaderPath
    ) {
      return [section.oldHeaderPath, section.newHeaderPath, oldMarker.path];
    }
    return undefined;
  }
  if (
    (oldMarker.path === null && newMarker.path === null) ||
    (oldMarker.path !== null && oldMarker.path !== section.oldHeaderPath) ||
    (newMarker.path !== null && newMarker.path !== section.newHeaderPath)
  ) {
    return undefined;
  }
  return [
    section.oldHeaderPath,
    section.newHeaderPath,
    ...(oldMarker.path === null ? [] : [oldMarker.path]),
    ...(newMarker.path === null ? [] : [newMarker.path]),
  ];
}

function setOperationPath(input: {
  section: StrictPatchSection;
  kind: 'rename' | 'copy';
  direction: 'from' | 'to';
  path: string;
}): boolean {
  const operation = input.section.operation;
  if (operation !== undefined && operation.kind !== input.kind) {
    return false;
  }
  const selected: PatchOperation = operation ?? { kind: input.kind, from: undefined, to: undefined };
  if (selected[input.direction] !== undefined) {
    return false;
  }
  selected[input.direction] = input.path;
  input.section.operation = selected;
  return true;
}

function parseHunkHeader(line: string, headerIndex: number): PatchHunk | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(line);
  const oldStart = match?.[1];
  const oldCountValue = match?.[2];
  const newStart = match?.[3];
  const newCountValue = match?.[4];
  const trailer = match?.[5];
  if (oldStart === undefined || newStart === undefined || trailer === undefined) {
    return undefined;
  }
  const declaredOldCount = oldCountValue === undefined ? 1 : Number(oldCountValue);
  const declaredNewCount = newCountValue === undefined ? 1 : Number(newCountValue);
  if (
    !Number.isSafeInteger(declaredOldCount) ||
    !Number.isSafeInteger(declaredNewCount) ||
    (declaredOldCount > 0 && oldStart === '0') ||
    (declaredNewCount > 0 && newStart === '0')
  ) {
    return undefined;
  }
  return {
    headerIndex,
    oldStart,
    newStart,
    trailer,
    declaredOldCount,
    declaredNewCount,
    bodyLines: [],
    observedOldCount: 0,
    observedNewCount: 0,
  };
}

function hunkDeclaredCountsSatisfied(hunk: PatchHunk): boolean {
  return hunk.observedOldCount >= hunk.declaredOldCount && hunk.observedNewCount >= hunk.declaredNewCount;
}

/**
 * Records one more raw line as belonging to the current hunk's body, and keeps the running
 * old/new tally `hunkDeclaredCountsSatisfied` reads. Never rejects a line itself — an
 * unrecognized marker, or a misplaced "\ No newline at end of file", surfaces once the full body
 * reaches jsdiff in `recountHunk`, the same way a malformed hunk header or path already does.
 */
function trackHunkBodyLine(hunk: PatchHunk, line: string): void {
  const marker = line[0];
  if (marker === ' ') {
    hunk.observedOldCount += 1;
    hunk.observedNewCount += 1;
  } else if (marker === '-') {
    hunk.observedOldCount += 1;
  } else if (marker === '+') {
    hunk.observedNewCount += 1;
  }
  hunk.bodyLines.push(line);
}

/**
 * Recounts and validates one hunk's body using jsdiff's own unified-diff hunk parser
 * (`diff`'s `parsePatch`), rather than a second, hand-rolled line-marker tally: builds a
 * minimal single-hunk diff around the hunk's collected body lines, with a declared header count
 * set to this module's own running tally (always >= the body's true count, by construction, so
 * jsdiff consumes the body exactly rather than stopping early or overrunning), and lets jsdiff
 * reject a malformed marker or a misplaced "\ No newline at end of file" line, and collapse a
 * genuinely empty side to `,0` the same way `git diff` itself would.
 *
 * A hunk that never reached its own declared header count before the body ran out is rejected
 * outright here (rather than silently recounted down to whatever was actually present) — the
 * declared count is untrusted for the *value* written into the normalized header, but a body
 * shorter than promised is still a sign of a truncated or otherwise malformed patch.
 */
function recountHunk(lines: string[], hunk: PatchHunk): boolean {
  if (
    hunk.bodyLines.length === 0 ||
    hunk.observedOldCount < hunk.declaredOldCount ||
    hunk.observedNewCount < hunk.declaredNewCount
  ) {
    return false;
  }
  const oldCount = Math.max(hunk.observedOldCount, 1);
  const newCount = Math.max(hunk.observedNewCount, 1);
  const synthetic = `--- a/x\n+++ b/x\n@@ -1,${String(oldCount)} +1,${String(newCount)} @@\n${hunk.bodyLines.join('\n')}`;
  let parsed: ReturnType<typeof jsdiffParsePatch>;
  try {
    parsed = jsdiffParsePatch(synthetic);
  } catch {
    return false;
  }
  const parsedHunks = parsed[0]?.hunks;
  if (parsedHunks?.length !== 1) {
    return false;
  }
  const recounted = parsedHunks[0];
  if (recounted === undefined || recounted.oldLines + recounted.newLines === 0) {
    return false;
  }
  lines[hunk.headerIndex] =
    `@@ -${hunk.oldStart},${String(recounted.oldLines)}` +
    ` +${hunk.newStart},${String(recounted.newLines)} @@${hunk.trailer}`;
  return true;
}

function looksLikeUndeclaredSection(input: { lines: readonly string[]; index: number; hunk: PatchHunk }): boolean {
  return (
    hunkDeclaredCountsSatisfied(input.hunk) &&
    input.lines[input.index]?.startsWith('--- ') === true &&
    input.lines[input.index + 1]?.startsWith('+++ ') === true &&
    input.lines[input.index + 2]?.startsWith('@@ ') === true
  );
}

/**
 * Single strict Git-patch parser for structured-edit preflight, plan scope,
 * and touched-path evidence. Unsupported or ambiguous input returns invalid.
 */
function analyzeStructuredPatch(
  patch: string,
  context: StructuredEditPathContext,
): StructuredPatchAnalysis | undefined {
  if (
    patch.length === 0 ||
    patch.length > MAX_STRUCTURED_PATCH_LENGTH ||
    patch.includes('\u0000') ||
    !patch.startsWith('diff --git ')
  ) {
    return undefined;
  }
  const lines = patch.replace(/\r\n/gu, '\n').split('\n');
  const paths: string[] = [];
  let section: StrictPatchSection | undefined;
  let hunk: PatchHunk | undefined;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      return undefined;
    }

    if (hunk !== undefined) {
      const trailingTerminator = line.length === 0 && index === lines.length - 1;
      if (
        trailingTerminator ||
        line.startsWith('@@ ') ||
        line.startsWith('diff --git ') ||
        looksLikeUndeclaredSection({ lines, index, hunk })
      ) {
        if (!recountHunk(lines, hunk)) {
          return undefined;
        }
        hunk = undefined;
        if (trailingTerminator) {
          index += 1;
        }
        continue;
      }
      trackHunkBodyLine(hunk, line);
      index += 1;
      continue;
    }

    if (line.startsWith('diff --git ')) {
      if (section !== undefined) {
        const completed = completedSectionPaths(section);
        if (completed === undefined) {
          return undefined;
        }
        paths.push(...completed);
      }
      const pair = splitDiffHeader(line.slice('diff --git '.length));
      if (pair === undefined) {
        return undefined;
      }
      const oldComponent = resolveDiffHeaderComponent({ value: pair[0], prefix: 'a/', context });
      const newComponent = resolveDiffHeaderComponent({ value: pair[1], prefix: 'b/', context });
      if (oldComponent === undefined || newComponent === undefined) {
        return undefined;
      }
      if (oldComponent.rewritten || newComponent.rewritten) {
        lines[index] = `diff --git a/${oldComponent.path} b/${newComponent.path}`;
      }
      section = {
        oldHeaderPath: oldComponent.path,
        newHeaderPath: newComponent.path,
        oldMarker: undefined,
        newMarker: undefined,
        sawHunk: false,
        sawSimilarity: false,
        operation: undefined,
        metadataOnlyKind: undefined,
      };
      index += 1;
      continue;
    }
    if (section === undefined) {
      if (line.trim().length > 0 || index !== lines.length - 1) {
        return undefined;
      }
      index += 1;
      continue;
    }
    if (
      line === 'GIT binary patch' ||
      line.startsWith('Binary files ') ||
      line.startsWith('literal ') ||
      line.startsWith('delta ') ||
      line.startsWith('diff ')
    ) {
      return undefined;
    }
    if (line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) {
      if (section.oldMarker !== undefined || section.sawHunk || section.sawSimilarity) {
        return undefined;
      }
      const percentage = /^(?:dis)?similarity index (\d{1,3})%$/u.exec(line)?.[1];
      if (percentage === undefined || Number(percentage) > 100) {
        return undefined;
      }
      section.sawSimilarity = true;
      index += 1;
      continue;
    }
    const operationMatch = /^(rename|copy) (from|to) /u.exec(line);
    if (operationMatch !== null) {
      const kind = operationMatch[1];
      const direction = operationMatch[2];
      if ((kind !== 'rename' && kind !== 'copy') || (direction !== 'from' && direction !== 'to')) {
        return undefined;
      }
      const path = metadataPath(line, `${kind} ${direction} `);
      if (
        path === undefined ||
        section.oldMarker !== undefined ||
        section.sawHunk ||
        !setOperationPath({ section, kind, direction, path })
      ) {
        return undefined;
      }
      index += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (section.oldMarker !== undefined || section.newMarker !== undefined || section.sawHunk) {
        return undefined;
      }
      const marker = diffMarkerPath({ value: line.slice('--- '.length), prefix: 'a/', context });
      if (marker === undefined) {
        return undefined;
      }
      if (marker.path !== null && marker.rewritten) {
        lines[index] = `--- a/${marker.path}${marker.remainder}`;
      }
      section.oldMarker = marker;
      index += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (section.oldMarker === undefined || section.newMarker !== undefined || section.sawHunk) {
        return undefined;
      }
      const marker = diffMarkerPath({ value: line.slice('+++ '.length), prefix: 'b/', context });
      if (marker === undefined) {
        return undefined;
      }
      if (marker.path !== null && marker.rewritten) {
        lines[index] = `+++ b/${marker.path}${marker.remainder}`;
      }
      section.newMarker = marker;
      index += 1;
      continue;
    }
    if (section.oldMarker !== undefined && section.newMarker === undefined) {
      return undefined;
    }
    if (line.startsWith('@@ ')) {
      if (section.oldMarker === undefined || section.newMarker === undefined) {
        return undefined;
      }
      hunk = parseHunkHeader(line, index);
      if (hunk === undefined) {
        return undefined;
      }
      section.sawHunk = true;
      index += 1;
      continue;
    }
    if (section.oldMarker === undefined) {
      const isNewFileMode = /^new file mode [0-7]{6}$/u.test(line);
      const isDeletedFileMode = /^deleted file mode [0-7]{6}$/u.test(line);
      const knownMetadata =
        /^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/iu.test(line) ||
        /^(?:old mode|new mode) [0-7]{6}$/u.test(line) ||
        isNewFileMode ||
        isDeletedFileMode;
      if (!knownMetadata) {
        if (line.length === 0 && index === lines.length - 1) {
          index += 1;
          continue;
        }
        return undefined;
      }
      if (isNewFileMode || isDeletedFileMode) {
        // A section may declare `new file mode` or `deleted file mode` at most once. A second
        // declaration (whether it repeats the same kind or contradicts it, e.g. both `new file
        // mode` and `deleted file mode` in one section) is malformed: reject it here rather than
        // silently letting the last declaration win and pass path extraction.
        if (section.metadataOnlyKind !== undefined) {
          return undefined;
        }
        section.metadataOnlyKind = isNewFileMode ? 'new' : 'deleted';
      }
      index += 1;
      continue;
    }
    if (line.length === 0 && index === lines.length - 1) {
      index += 1;
      continue;
    }
    return undefined;
  }
  if (hunk !== undefined && !recountHunk(lines, hunk)) {
    return undefined;
  }
  if (section === undefined) {
    return undefined;
  }
  const completed = completedSectionPaths(section);
  if (completed === undefined) {
    return undefined;
  }
  paths.push(...completed);
  return { targets: [...new Set(paths)], normalizedPatch: lines.join('\n') };
}

/**
 * Canonical host-owned structured-edit parser. It produces repository-root-relative
 * touched paths for T1 admission, T8 preflight, and T3 evidence from one validation pass.
 */
export function extractStructuredEditPaths(input: StructuredEditPathRequest): StructuredEditPathResolution {
  if (input.kind !== 'apply_patch') {
    const path = repositoryRelativeStructuredEditPath(input);
    return path === undefined
      ? {
          status: 'invalid',
          failure: structuredEditRejection({
            tool: input.kind,
            what: 'the target path',
            received: structuredEditReceivedSnippet(input.path),
            expected: 'a path relative to cwd, or an absolute path resolving inside the bound repository',
          }),
        }
      : { status: 'valid', paths: [path], normalized_patch: undefined };
  }
  const analysis = analyzeStructuredPatch(input.patch, { repositoryRoot: input.repositoryRoot, cwd: input.cwd });
  if (analysis === undefined) {
    return {
      status: 'invalid',
      failure: structuredEditRejection({
        tool: 'apply_patch',
        what: 'the patch',
        received: structuredEditReceivedSnippet(input.patch),
        expected: 'an unambiguous Git-format unified diff with complete supported text hunks',
      }),
    };
  }
  const repositoryPaths: string[] = [];
  for (const path of analysis.targets) {
    const repositoryPath = repositoryRelativeStructuredEditPath({
      repositoryRoot: input.repositoryRoot,
      cwd: input.cwd,
      path,
    });
    if (repositoryPath === undefined) {
      return {
        status: 'invalid',
        failure: structuredEditRejection({
          tool: 'apply_patch',
          what: 'a Git patch path',
          received: structuredEditReceivedSnippet(path),
          expected: 'a path relative to cwd, or an absolute path resolving inside the bound repository',
        }),
      };
    }
    repositoryPaths.push(repositoryPath);
  }
  const paths = [...new Set(repositoryPaths)];
  return paths.length === 0 || paths.length > MAX_STRUCTURED_EDIT_PATHS
    ? {
        status: 'invalid',
        failure: structuredEditRejection({
          tool: 'apply_patch',
          what: 'the number of touched paths',
          received: `${String(paths.length)} paths`,
          expected: `between 1 and ${String(MAX_STRUCTURED_EDIT_PATHS)} touched paths`,
        }),
      }
    : { status: 'valid', paths, normalized_patch: analysis.normalizedPatch };
}

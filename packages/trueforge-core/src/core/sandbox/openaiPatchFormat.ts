/**
 * Converts OpenAI's `apply_patch` envelope format (`*** Begin Patch` / `*** Update File: <path>`
 * / ... / `*** End Patch`) into a git-format unified diff, so it can flow through the existing
 * `extractStructuredEditPaths` / `git apply --recount --check` pipeline unchanged.
 *
 * gpt-oss (and other harmony-format models trained on OpenAI's Codex tool contract) emit patches
 * in this envelope even when the tool description asks for a git unified diff. Rather than
 * accept a second, weaker validation path, this module normalizes the envelope into the exact
 * same git-diff text a well-behaved model would have produced, so every existing precondition,
 * path-safety, and `git apply --check` safeguard still applies to the converted result.
 *
 * Envelope detection and parsing (turning the raw text into a sequence of add/delete/update file
 * operations) is done by the vendored parser in `./vendor/openaiApplyPatch.ts`, ported from
 * OpenAI's own `codex-rs/apply-patch` crate. This module only adds: recognizing an envelope-less
 * body (one that opens directly at a file-operation header, without `*** Begin Patch`/`*** End
 * Patch` — common from harmony-format models), and translating the parsed operations into a
 * git-format unified diff with real hunk offsets.
 *
 * Line-number offsets: the OpenAI format carries no hunk line numbers (only `@@` markers,
 * optionally followed by a human-readable anchor snippet such as a function signature). When the
 * current file content is available (`fileContents`), this module locates each hunk's old-side
 * text (context + removed lines) inside that content and computes the exact `@@ -start,count
 * +start,count @@` offsets — this is the path used once the host has read the target file inside
 * the sandbox. When no content is supplied (the pre-approval identity/preview pass, before any
 * sandbox is touched), every hunk gets a placeholder start of `1`; the diff is still internally
 * consistent (declared counts match the body), so it validates under this repository's own
 * strict structured-edit parser and is safe to show for path extraction and approval display, but
 * it is never the version handed to `git apply`.
 */

import { structuredEditReceivedSnippet, structuredEditRejection } from './structuredEditRejection';
import {
  ADD_FILE_MARKER,
  BEGIN_PATCH_MARKER,
  DELETE_FILE_MARKER,
  END_PATCH_MARKER,
  UPDATE_FILE_MARKER,
  parseApplyPatchEnvelope,
  type ApplyPatchAddHunk,
  type ApplyPatchDeleteHunk,
  type ApplyPatchHunk,
  type ApplyPatchUpdateHunk,
} from './vendor/openaiApplyPatch';

const FILE_OP_HEADER_RE = new RegExp(
  `^(?:${[UPDATE_FILE_MARKER, ADD_FILE_MARKER, DELETE_FILE_MARKER].map(marker => marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`,
  'u',
);

/** True when `line` opens an OpenAI apply_patch file operation, e.g. `*** Update File: a.ts`. */
function looksLikeFileOpHeader(line: string | undefined): boolean {
  return line !== undefined && FILE_OP_HEADER_RE.test(line.trim());
}

export type {
  ApplyPatchAddHunk as OpenAIPatchAddOp,
  ApplyPatchDeleteHunk as OpenAIPatchDeleteOp,
} from './vendor/openaiApplyPatch';
export type OpenAIPatchUpdateOp = ApplyPatchUpdateHunk;
export type OpenAIPatchOp = ApplyPatchHunk;

interface OpenAIPatchParseSuccess {
  status: 'parsed';
  ops: ApplyPatchHunk[];
}

interface OpenAIPatchParseFailure {
  status: 'invalid';
  reason: string;
}

export interface OpenAIPatchConversionFailure {
  status: 'invalid';
  reason: string;
}

export interface OpenAIPatchConversionSuccess {
  status: 'converted';
  /** The equivalent git-format unified diff. */
  gitDiff: string;
  /** Every path touched (old and new sides, for renames), as written in the OpenAI patch. */
  paths: string[];
  /**
   * Paths whose current content would let this converter compute exact hunk offsets instead of
   * the placeholder. Callers that can read the sandbox workspace should fetch these and pass them
   * back in `fileContents` for a second, exact-offset conversion pass before dispatching the diff
   * to `git apply`.
   */
  contentPaths: string[];
}

/**
 * Detects which apply_patch envelope a patch is written in, and rejects a patch mixing both.
 * Also recognizes an OpenAI-format body that omits its `*** Begin Patch` / `*** End Patch`
 * envelope, as long as it still opens with a file operation header (`*** Update File: `,
 * `*** Add File: `, or `*** Delete File: `); `parseOpenAIPatch` synthesizes the envelope back
 * around such a body before parsing continues.
 */
export function detectApplyPatchFormat(
  patchText: string,
): { status: 'git' } | { status: 'openai' } | { status: 'invalid'; reason: string } {
  const trimmed = patchText.trim();
  const firstLine = trimmed.split('\n')[0];
  const looksOpenAI = trimmed.startsWith(BEGIN_PATCH_MARKER) || looksLikeFileOpHeader(firstLine);
  const looksGit = trimmed.startsWith('diff --git ');
  if (looksOpenAI && looksGit) {
    return {
      status: 'invalid',
      reason: structuredEditRejection({
        tool: 'apply_patch',
        what: 'the patch dialect',
        received: 'a patch that starts with both the OpenAI Begin Patch marker and a git diff header',
        expected: 'either a plain Git unified diff or an OpenAI apply_patch envelope, never both',
      }),
    };
  }
  if (looksOpenAI) {
    if (/(^|\n)diff --git /u.test(patchText)) {
      return {
        status: 'invalid',
        reason: structuredEditRejection({
          tool: 'apply_patch',
          what: 'the patch dialect',
          received: 'an OpenAI-format patch that also embeds a git diff header',
          expected: 'either a plain Git unified diff or an OpenAI apply_patch envelope, never both',
        }),
      };
    }
    return { status: 'openai' };
  }
  return { status: 'git' };
}

function invalid(reason: string): OpenAIPatchParseFailure {
  return { status: 'invalid', reason };
}

/**
 * Parses the OpenAI apply_patch envelope into a sequence of per-file operations, via the vendored
 * parser (`./vendor/openaiApplyPatch.ts`). Accepts a body that omits the `*** Begin Patch` /
 * `*** End Patch` envelope entirely, as long as it opens directly with a file operation header;
 * the envelope is synthesized around it before parsing continues — the vendored parser itself
 * requires the explicit envelope (or its heredoc-wrapped form), same as upstream.
 */
export function parseOpenAIPatch(patchText: string): OpenAIPatchParseSuccess | OpenAIPatchParseFailure {
  let lines = patchText.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const hasBeginMarker = lines[0]?.trim() === BEGIN_PATCH_MARKER;
  if (!hasBeginMarker) {
    if (looksLikeFileOpHeader(lines[0])) {
      lines = [BEGIN_PATCH_MARKER, ...lines, END_PATCH_MARKER];
    } else {
      return invalid(
        structuredEditRejection({
          tool: 'apply_patch',
          what: 'the OpenAI-format envelope',
          received: structuredEditReceivedSnippet(lines[0] ?? ''),
          expected:
            '"*** Begin Patch" or a file operation header ("*** Update File:", "*** Add File:", or "*** Delete File:")',
        }),
      );
    }
  }
  const parsed = parseApplyPatchEnvelope(lines.join('\n'));
  if (parsed.status === 'error') {
    return invalid(
      structuredEditRejection({
        tool: 'apply_patch',
        what: 'the OpenAI-format envelope',
        received: structuredEditReceivedSnippet(
          parsed.lineNumber === undefined ? parsed.message : `line ${String(parsed.lineNumber)}: ${parsed.message}`,
        ),
        expected: 'a well-formed OpenAI apply_patch envelope',
      }),
    );
  }
  if (parsed.hunks.length === 0) {
    return invalid(
      structuredEditRejection({
        tool: 'apply_patch',
        what: 'the OpenAI-format envelope',
        received: 'an envelope with no file operations',
        expected: 'at least one "Update File", "Add File", or "Delete File" operation',
      }),
    );
  }
  return { status: 'parsed', ops: parsed.hunks };
}

function splitFileLines(content: string): string[] {
  if (content.length === 0) {
    // A genuinely empty file has zero lines, not one empty line — `''.split('\n')` would
    // otherwise return `['']`, and callers rely on `length === 0` to mean "no content".
    return [];
  }
  const normalized = content.replace(/\r\n/gu, '\n');
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

/** Finds every index at which `needle` occurs as a contiguous run inside `haystack`. */
function findAllSubsequences(haystack: readonly string[], needle: readonly string[]): number[] {
  if (needle.length === 0 || needle.length > haystack.length) {
    return [];
  }
  const matches: number[] = [];
  const limit = haystack.length - needle.length;
  for (let candidate = 0; candidate <= limit; candidate += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[candidate + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push(candidate);
    }
  }
  return matches;
}

/** Finds every index of a line exactly equal to `text` within the first `limit` lines. */
function findAllLinesBefore(haystack: readonly string[], text: string, limit: number): number[] {
  const matches: number[] = [];
  for (let index = 0; index < limit; index += 1) {
    if (haystack[index] === text) {
      matches.push(index);
    }
  }
  return matches;
}

/** Picks the single unambiguous candidate for a hunk's location, preferring one at or after `cursor`. */
function pickHunkCandidate(
  candidates: readonly number[],
  cursor: number,
  oldPath: string,
): { status: 'located'; matchIndex: number } | OpenAIPatchConversionFailure {
  const forward = candidates.filter(index => index >= cursor);
  const forwardMatch = forward[0];
  if (forward.length === 1 && forwardMatch !== undefined) {
    return { status: 'located', matchIndex: forwardMatch };
  }
  if (forward.length > 1) {
    return {
      status: 'invalid',
      reason: structuredEditRejection({
        tool: 'apply_patch',
        what: `the location of a hunk in "${oldPath}"`,
        received: `${String(forward.length)} equally-plausible matching locations`,
        expected: 'exactly one matching location',
        hint: 'Add a "@@ " anchor line naming its enclosing context to disambiguate.',
      }),
    };
  }
  // No candidate at or after the cursor: hunks are expected in file order, but fall back to the
  // whole file rather than fail outright if an earlier hunk's match left the cursor past this
  // hunk's real location. Still refuse to guess between more than one such candidate.
  const onlyMatch = candidates[0];
  if (candidates.length === 1 && onlyMatch !== undefined) {
    return { status: 'located', matchIndex: onlyMatch };
  }
  return {
    status: 'invalid',
    reason:
      candidates.length === 0
        ? structuredEditRejection({
            tool: 'apply_patch',
            what: `the context for a hunk in "${oldPath}"`,
            received: 'no matching location in the current file content',
            expected: 'old-side hunk text that matches the file as last read',
            hint: 'The file may have changed since the model read it; read it again and retry.',
          })
        : structuredEditRejection({
            tool: 'apply_patch',
            what: `the location of a hunk in "${oldPath}"`,
            received: `${String(candidates.length)} equally-plausible matching locations`,
            expected: 'exactly one matching location',
            hint: 'Add a "@@ " anchor line naming its enclosing context to disambiguate.',
          }),
  };
}

/**
 * Locates one hunk's old-side content inside `fileLines`, honoring OpenAI apply_patch semantics
 * the raw context/removed-lines search alone cannot: the `@@ <trailer>` anchor, when present,
 * narrows the search to locations it precedes — the only way to place a pure-insertion hunk
 * (empty old-side content) at all, and the way a repeated context block is disambiguated;
 * `*** End of File`, when present, constrains the match to end at the file's current last line.
 */
function locateHunk(input: {
  fileLines: readonly string[];
  oldSideTexts: readonly string[];
  trailer: string;
  endOfFile: boolean;
  cursor: number;
  oldPath: string;
}): { status: 'located'; matchIndex: number } | OpenAIPatchConversionFailure {
  const { fileLines, oldSideTexts, trailer, endOfFile, cursor, oldPath } = input;

  if (oldSideTexts.length === 0) {
    // Pure insertion: there is no old-side content to search for, so the position must come from
    // an explicit anchor instead.
    if (endOfFile) {
      return cursor <= fileLines.length
        ? { status: 'located', matchIndex: fileLines.length }
        : {
            status: 'invalid',
            reason: structuredEditRejection({
              tool: 'apply_patch',
              what: `the context for a hunk in "${oldPath}"`,
              received: 'an "End of File" hunk positioned past the current file length',
              expected: 'a cursor position at or before the current file length',
              hint: 'The file may have changed since the model read it; read it again and retry.',
            }),
          };
    }
    if (trailer.length === 0) {
      return {
        status: 'invalid',
        reason: structuredEditRejection({
          tool: 'apply_patch',
          what: `a hunk in "${oldPath}"`,
          received: 'a pure-insertion hunk with no surrounding context and no "@@ " anchor line',
          expected: 'either surrounding context lines or a "@@ " anchor line naming its position',
        }),
      };
    }
    const anchorMatches = findAllLinesBefore(fileLines, trailer, fileLines.length).map(index => index + 1);
    return pickHunkCandidate(anchorMatches, cursor, oldPath);
  }

  let candidates = findAllSubsequences(fileLines, oldSideTexts);
  if (endOfFile) {
    candidates = candidates.filter(index => index + oldSideTexts.length === fileLines.length);
  }
  if (trailer.length > 0) {
    // The anchor is a literal line copied from the file (typically an enclosing function or
    // class signature) that must appear somewhere before the hunk's own content; use it to
    // narrow — or, if it matches nothing, to reject rather than guess.
    candidates = candidates.filter(index => findAllLinesBefore(fileLines, trailer, index).length > 0);
  }
  return pickHunkCandidate(candidates, cursor, oldPath);
}

function buildAddSection(op: ApplyPatchAddHunk): string {
  const header = `diff --git a/${op.path} b/${op.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${op.path}\n`;
  if (op.lines.length === 0) {
    return header;
  }
  const hunkHeader = `@@ -0,0 +1,${String(op.lines.length)} @@\n`;
  const body = `${op.lines.map(line => `+${line}`).join('\n')}\n`;
  return header + hunkHeader + body;
}

function buildDeleteSection(op: ApplyPatchDeleteHunk, content: string | undefined): string {
  const header = `diff --git a/${op.path} b/${op.path}\ndeleted file mode 100644\n--- a/${op.path}\n+++ /dev/null\n`;
  if (content === undefined) {
    // No file content available yet (pre-approval placeholder pass): emit a single-line
    // placeholder hunk. It is internally consistent (and so still validates as a well-formed git
    // diff for path extraction), but is never the diff handed to `git apply` — the exact-offset
    // pass, run once the host has read the file, replaces it with real content (or, for a
    // genuinely empty file, with no hunk at all).
    return `${header}@@ -1 +0,0 @@\n-\n`;
  }
  const lines = splitFileLines(content);
  if (lines.length === 0) {
    // Known-empty file: nothing to remove, so Git itself emits no hunk for this deletion.
    return header;
  }
  const hunkHeader = `@@ -1,${String(lines.length)} +0,0 @@\n`;
  const body = `${lines.map(line => `-${line}`).join('\n')}\n`;
  return header + hunkHeader + body;
}

function buildUpdateSection(
  op: ApplyPatchUpdateHunk,
  content: string | undefined,
): { status: 'built'; text: string } | OpenAIPatchConversionFailure {
  const oldPath = op.path;
  const newPath = op.movePath ?? op.path;
  const isRename = op.movePath !== undefined && op.movePath !== op.path;
  let header = `diff --git a/${oldPath} b/${newPath}\n`;
  if (isRename) {
    header += `similarity index 100%\nrename from ${oldPath}\nrename to ${newPath}\n`;
  }
  header += `--- a/${oldPath}\n+++ b/${newPath}\n`;

  const fileLines = content === undefined ? undefined : splitFileLines(content);
  let cursor = 0;
  let cumulativeDelta = 0;
  const hunkTexts: string[] = [];
  for (const chunk of op.chunks) {
    const trailer = chunk.trailer ?? '';
    const oldSideTexts = chunk.bodyLines.filter(line => line.marker !== '+').map(line => line.text);
    const oldCount = oldSideTexts.length;
    const newCount = chunk.bodyLines.filter(line => line.marker !== '-').length;
    let oldStart: number;
    if (fileLines === undefined) {
      oldStart = 1;
    } else {
      const located = locateHunk({
        fileLines,
        oldSideTexts,
        trailer,
        endOfFile: chunk.endOfFile,
        cursor,
        oldPath,
      });
      if (located.status === 'invalid') {
        return located;
      }
      const matchIndex = located.matchIndex;
      cursor = matchIndex + oldCount;
      oldStart = oldCount === 0 ? matchIndex : matchIndex + 1;
    }
    const newStart = oldStart + cumulativeDelta;
    cumulativeDelta += newCount - oldCount;
    const trailerText = trailer.length > 0 ? ` ${trailer}` : '';
    const bodyText = chunk.bodyLines.map(line => `${line.marker}${line.text}`).join('\n');
    hunkTexts.push(
      `@@ -${String(oldStart)},${String(oldCount)} +${String(newStart)},${String(newCount)} @@${trailerText}\n${bodyText}\n`,
    );
  }
  return { status: 'built', text: header + hunkTexts.join('') };
}

/**
 * Converts a parsed-and-validated OpenAI `apply_patch` envelope into a git-format unified diff.
 * Pass `fileContents` (repository-relative path -> current file text) to compute exact hunk
 * offsets; omit it to get a placeholder-offset diff safe for path extraction and display only.
 */
export function convertOpenAIPatchToGitDiff(
  patchText: string,
  fileContents?: ReadonlyMap<string, string>,
): OpenAIPatchConversionSuccess | OpenAIPatchConversionFailure {
  const parsed = parseOpenAIPatch(patchText);
  if (parsed.status === 'invalid') {
    return parsed;
  }
  const sections: string[] = [];
  const paths: string[] = [];
  const contentPaths: string[] = [];
  for (const op of parsed.ops) {
    if (op.type === 'add') {
      paths.push(op.path);
      sections.push(buildAddSection(op));
      continue;
    }
    if (op.type === 'delete') {
      paths.push(op.path);
      contentPaths.push(op.path);
      sections.push(buildDeleteSection(op, fileContents?.get(op.path)));
      continue;
    }
    paths.push(op.path);
    if (op.movePath !== undefined) {
      paths.push(op.movePath);
    }
    contentPaths.push(op.path);
    const built = buildUpdateSection(op, fileContents?.get(op.path));
    if (built.status === 'invalid') {
      return built;
    }
    sections.push(built.text);
  }
  return {
    status: 'converted',
    gitDiff: sections.join(''),
    paths: [...new Set(paths)],
    contentPaths: [...new Set(contentPaths)],
  };
}

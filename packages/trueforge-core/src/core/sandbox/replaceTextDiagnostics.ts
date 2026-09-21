/**
 * Host-side matching and diagnosis for `replace_text`. The host never guesses: after the
 * deterministic BOM/fence/CRLF normalisation `toolArgumentNormalization.ts` already applies to
 * `old_text`, this module requires `old_text` to occur exactly once in the current file for the
 * edit to proceed, byte for byte, unchanged.
 *
 * A uniform line-number gutter (`"212 | "`, `"212:"`) is handled here, not in the normaliser:
 * `old_text` is tried verbatim first; the gutter-stripped form (`stripLineNumberGutters`) is
 * tried only if the verbatim text does not match uniquely, and never both silently. If the
 * verbatim text and the stripped form each match somewhere in the file — necessarily different
 * passages, since they are different byte sequences — the call is rejected as ambiguous rather
 * than guessing which one the model meant; the rejection names both. This is what keeps a file
 * that legitimately contains numbered content (a numbered list, code someone else numbered) from
 * having a match silently redirected to a different passage than the one actually named. More
 * than one exact occurrence of whichever single form matches is rejected as ambiguous too (with
 * the count and the matching lines); zero occurrences of both forms is rejected as not found.
 * Neither ambiguous nor not-found is ever applied.
 *
 * This module also builds the not-found diagnostic: it locates the passage nearest to `old_text`
 * purely to explain the miss — the file path, that passage's line range and text, and a compact
 * line-level diff between what was sent and what is actually there — so a retrying model has
 * something concrete to correct against in one step. Locating that passage is diagnosis only;
 * its text is never substituted for `old_text` or written anywhere.
 */

import { diffLines } from 'diff';
import { diff_match_patch as DiffMatchPatch } from 'diff-match-patch';
import { structuredEditReceivedSnippet, structuredEditRejection } from './structuredEditRejection';
import { stripLineNumberGutters } from './toolArgumentNormalization';

export type ReplaceTextMatchResult =
  | { status: 'exact_match'; matchedText: string }
  | { status: 'ambiguous'; rejection: string }
  | { status: 'no_match'; rejection: string };

const dmp = new DiffMatchPatch();
const MAX_NEAREST_PASSAGE_LINES = 12;
const MAX_DIFF_LINES = 24;
// Two nearest-passage candidates are reported as an equally-close tie when their edit-distance
// scores differ by no more than this many characters (or 5% of old_text's length, whichever is
// larger) — close enough that picking only one to show risks pointing at the wrong one.
const NEAREST_PASSAGE_TIE_MARGIN_FLOOR = 3;
// Maximum number of anchor occurrences ever handed to the expensive levenshtein pass. Candidates
// are ranked by a cheap, string-free lower bound on that exact score first (see
// `lowerBoundEditDistance`), so this is a hard safety cap for when many candidates tie on the
// bound, not the primary way candidates get narrowed — it prevents quadratic behavior when a
// large old_text or file has many repeated lines.
export const MAX_SCORED_CANDIDATES = 8;

/** Every index in `haystack` where `needle` occurs (overlap-tolerant forward scan). */
function allIndicesOf(haystack: string, needle: string): number[] {
  if (needle.length === 0) {
    return [];
  }
  const indices: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    indices.push(index);
    index = haystack.indexOf(needle, index + 1);
  }
  return indices;
}

/** 1-based line number containing byte offset `index` in `text`. */
function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function lineRangeLabel(passage: { startLine: number; endLine: number }): string {
  return passage.startLine === passage.endLine
    ? `line ${String(passage.startLine)}`
    : `lines ${String(passage.startLine)}-${String(passage.endLine)}`;
}

/**
 * Builds the ambiguous-match rejection. When `strippedText`/`strippedIndices` are given (the
 * gutter-stripped form was also tried and also matched somewhere), the rejection names both
 * candidates and their locations rather than picking one — see the module docstring.
 */
function ambiguousRejection(input: {
  path: string;
  oldText: string;
  fileContent: string;
  originalIndices: number[];
  strippedText?: string;
  strippedIndices?: number[];
}): string {
  const { path, oldText, fileContent, originalIndices } = input;
  const originalLines = originalIndices.map(index => lineNumberAt(fileContent, index));
  const strippedIndices = input.strippedIndices ?? [];

  let hint: string;
  if (input.strippedText !== undefined && originalIndices.length > 0 && strippedIndices.length > 0) {
    const strippedLines = strippedIndices.map(index => lineNumberAt(fileContent, index));
    hint =
      `old_text, taken literally, matches ${String(originalLines.length)} location(s) in ${path}, ` +
      `at lines ${originalLines.join(', ')}. old_text also reads as a uniform line-number gutter over ` +
      `different text; with that gutter stripped it separately matches ${String(strippedLines.length)} ` +
      `location(s), at lines ${strippedLines.join(', ')}. The host will not guess which you mean: send ` +
      `old_text exactly as it appears in ${path} (with or without the gutter), narrowed to a passage ` +
      'that occurs only once, or set replace_all: true.';
  } else if (input.strippedText !== undefined && strippedIndices.length > 1) {
    const strippedLines = strippedIndices.map(index => lineNumberAt(fileContent, index));
    hint = `old_text, with its line-number gutter stripped, matches ${String(strippedLines.length)} locations in ${path}, at lines ${strippedLines.join(', ')}.`;
  } else {
    hint = `old_text matches ${String(originalLines.length)} locations, at lines ${originalLines.join(', ')}.`;
  }

  return structuredEditRejection({
    tool: 'replace_text',
    what: 'the target text',
    received: structuredEditReceivedSnippet(oldText),
    expected: `a passage that occurs exactly once in ${path}, or replace_all: true`,
    hint,
  });
}

interface NearestPassage {
  startLine: number;
  endLine: number;
  text: string;
}

interface ScoredPassage extends NearestPassage {
  score: number;
}

/**
 * Picks the most distinctive line of `oldTextLines` to anchor the nearest-passage search on: the
 * line that occurs least often in `fileLines` (rarest — most likely to identify one real spot),
 * tie-broken by the longest line (more context to align on), tie-broken by the earliest line in
 * `oldTextLines` (stable). A line with zero occurrences in the file cannot anchor an exact-line
 * search and is skipped — `undefined` means no line of `old_text` occurs verbatim anywhere in the
 * file, and the caller falls back to a fuzzy, bitap-based search instead.
 */
function selectAnchorLine(
  oldTextLines: readonly string[],
  fileLines: readonly string[],
): { line: string; indexInOldText: number } | undefined {
  const occurrenceCounts = new Map<string, number>();
  for (const line of fileLines) {
    occurrenceCounts.set(line, (occurrenceCounts.get(line) ?? 0) + 1);
  }

  let best: { line: string; indexInOldText: number; occurrences: number } | undefined;
  for (const [index, line] of oldTextLines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    const occurrences = occurrenceCounts.get(line) ?? 0;
    if (occurrences === 0) {
      continue;
    }
    if (
      best === undefined ||
      occurrences < best.occurrences ||
      (occurrences === best.occurrences && line.length > best.line.length)
    ) {
      best = { line, indexInOldText: index, occurrences };
    }
  }
  return best === undefined ? undefined : { line: best.line, indexInOldText: best.indexInOldText };
}

/**
 * A lower bound on the character-level Levenshtein distance between `old_text` and a candidate
 * passage, computed on line arrays only — no strings are joined or diffed. This must never exceed
 * the exact score `scorePassages` (below) would compute for the same passage, since it is used to
 * skip exact scoring of candidates that provably cannot win.
 *
 * `scorePassages` computes `diff_levenshtein(diff_main(old_text, passage.text))` on the two texts
 * joined with `\n`. Because the newline characters occupy the same relative positions in both
 * joined strings (one per line boundary, in the same order), any edit script that turns one joined
 * string into the other still has to individually resolve each aligned pair of lines: a line that
 * differs in length needs at least `|len(a) - len(b)|` character insertions/deletions just to
 * reach the right length, and a line that differs at all (same length, different content) needs at
 * least one substitution. Summing that per-line minimum across every aligned line pair therefore
 * never overcounts the true distance — it is a lower bound, not an estimate. When the passage runs
 * out of file before `old_text` does (the anchor occurs too close to the end of the file), every
 * unmatched trailing line of `old_text` needs at least its own length in edits to be produced, so
 * those lengths are added too.
 */
function lowerBoundEditDistance(input: {
  fileLines: readonly string[];
  oldTextLines: readonly string[];
  /** 0-based index into `fileLines` where the candidate passage starts. */
  startLine: number;
}): number {
  const { fileLines, oldTextLines, startLine } = input;
  const availableLines = Math.max(0, fileLines.length - startLine);
  const alignedCount = Math.min(oldTextLines.length, availableLines);

  let bound = 0;
  for (let i = 0; i < alignedCount; i++) {
    const a = oldTextLines[i] ?? '';
    const b = fileLines[startLine + i] ?? '';
    bound += a === b ? 0 : Math.max(Math.abs(a.length - b.length), 1);
  }
  // Passage is shorter than old_text: the remaining old_text lines have no counterpart at all.
  for (let i = alignedCount; i < oldTextLines.length; i++) {
    bound += (oldTextLines[i] ?? '').length;
  }
  return bound;
}

interface BoundedCandidate {
  fileLineIndex: number;
  startLine: number;
  lowerBound: number;
}

/**
 * Every whole-passage candidate anchored at an occurrence of `anchor.line`, aligned so the anchor
 * line sits at the same relative offset within the candidate that it holds within `old_text`
 * itself — e.g. if the anchor is `old_text`'s second line, each candidate starts one line before
 * the anchor's occurrence in the file. Ranks candidates by `lowerBoundEditDistance` — a true lower
 * bound on the exact score `scorePassages` computes — ascending, so the closest-possible candidates
 * come first. `MAX_SCORED_CANDIDATES` is kept only as a hard safety cap on how many candidates ever
 * reach exact scoring: it protects against a file with many candidates tied on the bound. Because
 * the list is sorted by bound first, hitting the cap can only drop candidates whose bound is no
 * better than the ones kept, so the diagnostic may end up citing a suboptimal passage in that case
 * but never an arbitrary one — it never drops a candidate strictly closer than one it keeps.
 */
function buildCandidatePassages(input: {
  fileLines: readonly string[];
  oldTextLines: readonly string[];
  oldTextLineCount: number;
  anchor: { line: string; indexInOldText: number };
}): (NearestPassage & { lowerBound: number })[] {
  const { fileLines, oldTextLines, oldTextLineCount, anchor } = input;
  const wantedLineCount = Math.max(1, oldTextLineCount);

  // First pass: cheap, string-free lower bound for every anchor occurrence.
  const candidates: BoundedCandidate[] = [];
  for (const [fileLineIndex, line] of fileLines.entries()) {
    if (line !== anchor.line) {
      continue;
    }
    const startLine = fileLineIndex - anchor.indexInOldText;
    if (startLine < 0) {
      continue;
    }
    const lowerBound = lowerBoundEditDistance({ fileLines, oldTextLines, startLine });
    candidates.push({ fileLineIndex, startLine, lowerBound });
  }

  // Sort by lower bound ascending, then cap as a safety net (see docstring above).
  candidates.sort((a, b) => a.lowerBound - b.lowerBound);
  const topCandidates = candidates.slice(0, MAX_SCORED_CANDIDATES);

  // Second pass: materialize passages only for the kept candidates.
  const passages: (NearestPassage & { lowerBound: number })[] = [];
  for (const { startLine, lowerBound } of topCandidates) {
    const endExclusive = Math.min(fileLines.length, startLine + wantedLineCount);
    const passageLines = fileLines.slice(startLine, endExclusive);
    if (passageLines.length === 0) {
      continue;
    }
    passages.push({
      startLine: startLine + 1,
      endLine: startLine + passageLines.length,
      text: passageLines.join('\n'),
      lowerBound,
    });
  }
  return passages;
}

/**
 * Exact edit-distance score of each candidate against the full `oldText` — lower is closer.
 * `candidates` must already be sorted by `lowerBound` ascending (as `buildCandidatePassages`
 * returns them, and already capped to at most `MAX_SCORED_CANDIDATES`). Scores candidates in that
 * order and stops as soon as a candidate's lower bound is *strictly greater than* the best exact
 * distance found so far: the remaining candidates only have equal or larger bounds, so none of
 * them can beat that best score. A bound merely *equal* to the current best is still scored,
 * rather than skipped, because its exact score could tie the best — `findNearestPassage` needs
 * that tie to report an equally-close `alternate` candidate rather than silently picking one.
 * Since the candidate list is already capped small before this runs, scoring the occasional exact
 * tie costs nothing worth pruning for. Returns the scored candidates sorted by exact score
 * ascending.
 */
function scorePassages(
  oldText: string,
  candidates: readonly (NearestPassage & { lowerBound: number })[],
): ScoredPassage[] {
  const scored: ScoredPassage[] = [];
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate.lowerBound > bestScore) {
      break;
    }
    const score = dmp.diff_levenshtein(dmp.diff_main(oldText, candidate.text));
    scored.push({ startLine: candidate.startLine, endLine: candidate.endLine, text: candidate.text, score });
    if (score < bestScore) {
      bestScore = score;
    }
  }
  scored.sort((a, b) => a.score - b.score);
  return scored;
}

/**
 * Fuzzy fallback used only when no line of `old_text` occurs verbatim anywhere in the file (so
 * the exact-line-anchor search in `buildCandidatePassages` has nothing to anchor on): anchors on
 * every substring occurrence of `old_text`'s first line, tries diff-match-patch's bitap search
 * (`match_main`, clipped to its 32-character `Match_MaxBits` pattern limit — a hard limit of the
 * algorithm, not a tunable) from each anchor, and falls back to the anchor position itself (an
 * exact hit of the first line already) when `match_main` cannot score the whole pattern above its
 * threshold. With no anchor at all, tries one global `match_main` from the start of the file.
 * Returns `undefined` when nothing scores above threshold anywhere — genuinely nothing close.
 */
function findNearestPassageByFuzzyMatch(input: {
  fileContent: string;
  oldText: string;
  oldTextLines: readonly string[];
}): NearestPassage | undefined {
  const { fileContent, oldText, oldTextLines } = input;
  const firstLine = oldTextLines[0] ?? '';
  const wantedLineCount = Math.max(1, oldTextLines.length);

  dmp.Match_Threshold = 0.3;
  const pattern = oldText.length > dmp.Match_MaxBits ? oldText.slice(0, dmp.Match_MaxBits) : oldText;

  const anchors = allIndicesOf(fileContent, firstLine);
  let matchIndex = -1;
  for (const anchor of anchors) {
    const nudged = dmp.match_main(fileContent, pattern, anchor);
    if (nudged !== -1) {
      matchIndex = nudged;
      break;
    }
  }
  if (matchIndex === -1 && anchors.length > 0) {
    matchIndex = anchors[0] ?? -1;
  }
  if (matchIndex === -1) {
    const globalMatch = dmp.match_main(fileContent, pattern, 0);
    if (globalMatch !== -1) {
      matchIndex = globalMatch;
    }
  }
  if (matchIndex === -1) {
    return undefined;
  }

  const lines = fileContent.split('\n');
  const startLine = lineNumberAt(fileContent, matchIndex);
  const endLineExclusive = Math.min(lines.length, startLine - 1 + wantedLineCount);
  const passageLines = lines.slice(startLine - 1, endLineExclusive).slice(0, MAX_NEAREST_PASSAGE_LINES);
  if (passageLines.length === 0) {
    return undefined;
  }
  return {
    startLine,
    endLine: startLine + passageLines.length - 1,
    text: passageLines.join('\n'),
  };
}

/**
 * Locates the passage(s) in `fileContent` nearest to `oldText`, for the not-found diagnostic
 * only — never for application. Anchors the search on `old_text`'s most distinctive line (see
 * `selectAnchorLine`) rather than always its first line, compares each candidate's *complete*
 * passage against the complete `old_text` (not just the anchor line), and returns a second,
 * `alternate` candidate when two score within `NEAREST_PASSAGE_TIE_MARGIN_FLOOR` (or 5% of
 * `old_text`'s length) of each other — close enough that reporting only the single best guess
 * risks pointing at the wrong one. Falls back to a fuzzy, bitap-based single-candidate search
 * (`findNearestPassageByFuzzyMatch`) when no line of `old_text` occurs verbatim anywhere in the
 * file. Returns `undefined` when nothing scores close enough anywhere — genuinely nothing close.
 */
function findNearestPassage(input: {
  fileContent: string;
  oldText: string;
}): { primary: NearestPassage; alternate?: NearestPassage } | undefined {
  const { fileContent, oldText } = input;
  if (fileContent.length === 0) {
    return undefined;
  }
  const oldTextLines = oldText.split('\n');
  const fileLines = fileContent.split('\n');

  const anchor = selectAnchorLine(oldTextLines, fileLines);
  if (anchor !== undefined) {
    const candidates = buildCandidatePassages({
      fileLines,
      oldTextLines,
      oldTextLineCount: oldTextLines.length,
      anchor,
    });
    const scored = scorePassages(oldText, candidates);
    const best = scored[0];
    if (best !== undefined) {
      const cappedPrimary = capPassageLines(best);
      const margin = Math.max(NEAREST_PASSAGE_TIE_MARGIN_FLOOR, Math.round(oldText.length * 0.05));
      const runnerUp = scored[1];
      const alternate =
        runnerUp !== undefined && runnerUp.score - best.score <= margin && runnerUp.startLine !== best.startLine
          ? capPassageLines(runnerUp)
          : undefined;
      return alternate === undefined ? { primary: cappedPrimary } : { primary: cappedPrimary, alternate };
    }
  }

  const fallback = findNearestPassageByFuzzyMatch({ fileContent, oldText, oldTextLines });
  return fallback === undefined ? undefined : { primary: fallback };
}

/** Caps a passage's displayed text/line-range to `MAX_NEAREST_PASSAGE_LINES`, from its start. */
function capPassageLines(passage: NearestPassage): NearestPassage {
  const lines = passage.text.split('\n');
  if (lines.length <= MAX_NEAREST_PASSAGE_LINES) {
    return passage;
  }
  const capped = lines.slice(0, MAX_NEAREST_PASSAGE_LINES);
  return { startLine: passage.startLine, endLine: passage.startLine + capped.length - 1, text: capped.join('\n') };
}

/** Splits a `diffLines` chunk's value into its constituent lines, dropping the trailing empty entry a terminal newline produces. */
function chunkLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * A compact line-level diff between `sent` (old_text as received) and `passage` (the nearest
 * passage actually in the file), prefixed `-`/`+`/` ` like a unified diff body, capped to
 * `MAX_DIFF_LINES` so a large mismatch still produces a short, actionable diagnostic.
 */
function compactLineDiff(sent: string, passage: string): string {
  const out: string[] = [];
  outer: for (const change of diffLines(sent, passage)) {
    const prefix = change.added ? '+' : change.removed ? '-' : ' ';
    for (const line of chunkLines(change.value)) {
      if (out.length >= MAX_DIFF_LINES) {
        out.push('…');
        break outer;
      }
      out.push(`${prefix} ${line}`);
    }
  }
  return out.join('\n');
}

function notFoundRejection(input: { path: string; oldText: string; fileContent: string }): string {
  const { path, oldText, fileContent } = input;
  const nearest = findNearestPassage({ fileContent, oldText });
  if (nearest === undefined) {
    const firstLine = oldText.split('\n')[0] ?? '';
    return structuredEditRejection({
      tool: 'replace_text',
      what: 'the target text',
      received: structuredEditReceivedSnippet(oldText),
      expected: `an exact passage in ${path}`,
      hint:
        `No passage in ${path} scored close enough to old_text to suggest a correction. ` +
        `old_text's first line: ${structuredEditReceivedSnippet(firstLine)}. Re-read ${path} and copy ` +
        'old_text from its current contents.',
    });
  }

  const { primary, alternate } = nearest;
  const diff = compactLineDiff(oldText, primary.text);
  let hint =
    `Nearest passage in ${path}, ${lineRangeLabel(primary)}:\n${primary.text}\n\n` +
    `Diff (- sent, + ${path}):\n${diff}`;
  if (alternate !== undefined) {
    hint +=
      `\n\nAn equally close candidate exists at ${lineRangeLabel(alternate)} in ${path}:\n${alternate.text}\n\n` +
      'Check both before retrying — the diagnostic cannot tell which one old_text was meant to match.';
  }
  hint += '\n\nCopy old_text from the file exactly.';

  return structuredEditRejection({
    tool: 'replace_text',
    what: 'the target text',
    received: structuredEditReceivedSnippet(oldText),
    expected: `an exact passage in ${path}`,
    hint,
  });
}

/**
 * Matches one candidate reading of `old_text` (verbatim, or gutter-stripped) against
 * `fileContent`: exact and unique wins outright (or, with `replaceAll: true`, any number of exact
 * occurrences count as a bulk match). Returns the list of match indices either way so the caller
 * can combine verbatim and gutter-stripped results into one ambiguity decision.
 */
function exactIndicesFor(fileContent: string, text: string): number[] {
  return allIndicesOf(fileContent, text);
}

/**
 * Matches `old_text` against `fileContent`. `old_text` is tried verbatim first; only if that does
 * not match uniquely is the gutter-stripped form (`stripLineNumberGutters`) tried, and only when
 * the two forms actually differ. If both the verbatim text and the stripped form match somewhere
 * in the file, the call is rejected as ambiguous rather than silently preferring one — see the
 * module docstring. `replace_all: true` makes any nonzero occurrence count of the form that
 * matches a bulk match rather than an ambiguity; if *both* forms have occurrences under
 * `replace_all`, that is still ambiguous (which text should be bulk-replaced is exactly the thing
 * the host cannot guess). Zero occurrences of both forms is rejected as not found, with a
 * diagnostic locating the nearest passage. Never applies a fuzzy or substituted match.
 */
export function matchReplaceText(input: {
  fileContent: string;
  oldText: string;
  /**
   * When `true` (the tool's `replace_all` argument), more than one exact occurrence of the
   * matching form is the intended bulk-replace case, not ambiguity — the replacement script
   * replaces every exact occurrence of `matchedText`, so the host must not reject the request
   * before it ever reaches that script.
   */
  replaceAll?: boolean;
  /** The file's path, for the rejection message. Falls back to a generic description if omitted. */
  path?: string;
}): ReplaceTextMatchResult {
  const { fileContent, oldText, replaceAll = false, path } = input;
  const pathLabel = path ?? 'the file';

  const stripped = stripLineNumberGutters(oldText);
  const hasGutterCandidate = stripped !== oldText;

  const originalIndices = exactIndicesFor(fileContent, oldText);
  const strippedIndices = hasGutterCandidate ? exactIndicesFor(fileContent, stripped) : [];

  if (replaceAll) {
    if (originalIndices.length > 0 && strippedIndices.length > 0) {
      return {
        status: 'ambiguous',
        rejection: ambiguousRejection({
          path: pathLabel,
          oldText,
          fileContent,
          originalIndices,
          strippedText: stripped,
          strippedIndices,
        }),
      };
    }
    if (originalIndices.length > 0) {
      return { status: 'exact_match', matchedText: oldText };
    }
    if (strippedIndices.length > 0) {
      return {
        status: 'exact_match',
        matchedText: stripped,
      };
    }
  } else {
    if (originalIndices.length === 1 && strippedIndices.length === 0) {
      return { status: 'exact_match', matchedText: oldText };
    }
    if (originalIndices.length === 0 && strippedIndices.length === 1) {
      return {
        status: 'exact_match',
        matchedText: stripped,
      };
    }
    if (
      (originalIndices.length >= 1 && strippedIndices.length >= 1) ||
      originalIndices.length > 1 ||
      strippedIndices.length > 1
    ) {
      return {
        status: 'ambiguous',
        rejection: ambiguousRejection({
          path: pathLabel,
          oldText,
          fileContent,
          originalIndices,
          ...(hasGutterCandidate ? { strippedText: stripped, strippedIndices } : {}),
        }),
      };
    }
  }

  return { status: 'no_match', rejection: notFoundRejection({ path: pathLabel, oldText, fileContent }) };
}

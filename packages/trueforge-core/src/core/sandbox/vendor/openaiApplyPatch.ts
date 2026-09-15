/**
 * Vendored port of OpenAI's `apply_patch` envelope parser.
 *
 * Source: https://github.com/openai/codex, path `codex-rs/apply-patch/src/parser.rs` and
 * `codex-rs/apply-patch/src/streaming_parser.rs`.
 * Commit: e1eb98461cd42730e7b1a890c3100303d7091bc2
 * License: Apache-2.0 (see ./LICENSE in this directory).
 *
 * The upstream implementation is Rust and processes the patch text incrementally, one character
 * of a streamed delta at a time. This port operates on the full patch text at once (this
 * repository never streams `apply_patch` arguments) and represents an update hunk's body as one
 * ordered list of `{marker, text}` lines instead of the upstream `old_lines` / `new_lines` /
 * `context_line_indices` triple — an equivalent encoding for a parser whose only consumer needs
 * the lines in their original order (to emit a git-diff hunk body), not applied to a file
 * in-process. Every acceptance/rejection rule, marker string, and state transition below mirrors
 * the source line for line.
 *
 * Deliberately not ported: CRLF-per-line tolerance (`streaming_parser.rs` strips a trailing `\r`
 * off every line as it is fed in). This repository normalizes CRLF to LF once, for every
 * structured-edit text field, in `toolArgumentNormalization.ts`, before any patch text reaches
 * this parser — a second, duplicate CRLF tolerance layer here would just be dead code on this
 * repository's own call path.
 */

export const BEGIN_PATCH_MARKER = '*** Begin Patch';
export const END_PATCH_MARKER = '*** End Patch';
export const ADD_FILE_MARKER = '*** Add File: ';
export const DELETE_FILE_MARKER = '*** Delete File: ';
export const UPDATE_FILE_MARKER = '*** Update File: ';
export const MOVE_TO_MARKER = '*** Move to: ';
export const EOF_MARKER = '*** End of File';
export const CHANGE_CONTEXT_MARKER = '@@ ';
export const EMPTY_CHANGE_CONTEXT_MARKER = '@@';
const ENVIRONMENT_ID_MARKER = '*** Environment ID:';

export interface ApplyPatchBodyLine {
  marker: ' ' | '-' | '+';
  text: string;
}

export interface ApplyPatchUpdateChunk {
  /** The `@@ <trailer>` anchor text, if this chunk's header carried one. */
  trailer: string | undefined;
  bodyLines: ApplyPatchBodyLine[];
  endOfFile: boolean;
}

export interface ApplyPatchAddHunk {
  type: 'add';
  path: string;
  lines: string[];
}

export interface ApplyPatchDeleteHunk {
  type: 'delete';
  path: string;
}

export interface ApplyPatchUpdateHunk {
  type: 'update';
  path: string;
  movePath: string | undefined;
  chunks: ApplyPatchUpdateChunk[];
}

export type ApplyPatchHunk = ApplyPatchAddHunk | ApplyPatchDeleteHunk | ApplyPatchUpdateHunk;

export interface ApplyPatchParseSuccess {
  status: 'ok';
  hunks: ApplyPatchHunk[];
  environmentId: string | undefined;
}

export interface ApplyPatchParseFailure {
  status: 'error';
  message: string;
  lineNumber: number | undefined;
}

type BoundaryResult = { status: 'ok'; lines: readonly string[] } | { status: 'error'; message: string };

/** Port of `check_start_and_end_lines_strict`. */
function checkStartAndEndLinesStrict(
  firstLine: string | undefined,
  lastLine: string | undefined,
): { status: 'ok' } | { status: 'error'; message: string } {
  const first = firstLine === undefined ? undefined : firstLine.trim();
  const last = lastLine === undefined ? undefined : lastLine.trim();
  if (first !== undefined && last !== undefined && first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) {
    return { status: 'ok' };
  }
  if (first !== undefined && first !== BEGIN_PATCH_MARKER) {
    return { status: 'error', message: "The first line of the patch must be '*** Begin Patch'" };
  }
  return { status: 'error', message: "The last line of the patch must be '*** End Patch'" };
}

/** Port of `check_patch_boundaries_strict`. */
function checkPatchBoundariesStrict(lines: readonly string[]): BoundaryResult {
  const firstLine = lines.length === 0 ? undefined : lines[0];
  const lastLine = lines.length === 0 ? undefined : lines[lines.length - 1];
  const result = checkStartAndEndLinesStrict(firstLine, lastLine);
  return result.status === 'ok' ? { status: 'ok', lines } : result;
}

/**
 * Port of `check_patch_boundaries_lenient`: beyond the strict `*** Begin Patch` / `*** End Patch`
 * envelope, also accepts that envelope wrapped in a shell heredoc (`<<EOF` / `<<'EOF'` /
 * `<<"EOF"` ... `EOF`) — GPT-4.1's `local_shell` tool call formulates `apply_patch` arguments
 * this way, since `local_shell` invokes commands directly rather than through a shell that would
 * interpret the heredoc itself.
 */
function checkPatchBoundariesLenient(originalLines: readonly string[]): BoundaryResult {
  const strict = checkPatchBoundariesStrict(originalLines);
  if (strict.status === 'ok') {
    return strict;
  }
  if (originalLines.length === 0) {
    return strict;
  }
  const first = originalLines[0];
  const last = originalLines[originalLines.length - 1];
  const opensHeredoc = first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"';
  if (opensHeredoc && last !== undefined && last.endsWith('EOF') && originalLines.length >= 4) {
    const innerLines = originalLines.slice(1, originalLines.length - 1);
    return checkPatchBoundariesStrict(innerLines);
  }
  return strict;
}

interface ParserState {
  mode:
    | { kind: 'not_started' }
    | { kind: 'started_patch' }
    | { kind: 'add_file' }
    | { kind: 'delete_file' }
    | { kind: 'update_file'; hunkLineNumber: number }
    | { kind: 'ended_patch' };
  hunks: ApplyPatchHunk[];
  environmentId: string | undefined;
}

function fail(message: string, lineNumber: number | undefined): ApplyPatchParseFailure {
  return { status: 'error', message, lineNumber };
}

/** Port of `ensure_update_hunk_is_not_empty`. */
function ensureUpdateHunkIsNotEmpty(
  state: ParserState,
  line: string,
  currentLineNumber: number,
): ApplyPatchParseFailure | undefined {
  const lastHunk = state.hunks[state.hunks.length - 1];
  if (lastHunk?.type !== 'update') {
    return undefined;
  }
  if (lastHunk.chunks.length === 0 && state.mode.kind === 'update_file') {
    return fail(`Update file hunk for path '${lastHunk.path}' is empty`, state.mode.hunkLineNumber);
  }
  const lastChunk = lastHunk.chunks[lastHunk.chunks.length - 1];
  if (lastChunk?.bodyLines.length === 0) {
    if (line === END_PATCH_MARKER) {
      return fail('Update hunk does not contain any lines', currentLineNumber);
    }
    return fail(
      `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      currentLineNumber,
    );
  }
  return undefined;
}

type HeaderHandleResult = { handled: true } | { handled: false } | { handled: 'error'; error: ApplyPatchParseFailure };

/** Port of `handle_hunk_headers_and_end_patch`. */
function handleHunkHeadersAndEndPatch(
  state: ParserState,
  trimmed: string,
  currentLineNumber: number,
): HeaderHandleResult {
  if (state.mode.kind === 'started_patch' && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) {
    if (state.environmentId !== undefined) {
      return {
        handled: 'error',
        error: fail('apply_patch environment_id cannot be specified more than once', undefined),
      };
    }
    const environmentId = trimmed.slice(ENVIRONMENT_ID_MARKER.length).trim();
    if (environmentId.length === 0) {
      return { handled: 'error', error: fail('apply_patch environment_id cannot be empty', undefined) };
    }
    state.environmentId = environmentId;
    return { handled: true };
  }
  if (trimmed === END_PATCH_MARKER) {
    const error = ensureUpdateHunkIsNotEmpty(state, trimmed, currentLineNumber);
    if (error !== undefined) {
      return { handled: 'error', error };
    }
    state.mode = { kind: 'ended_patch' };
    return { handled: true };
  }
  if (trimmed.startsWith(ADD_FILE_MARKER)) {
    const error = ensureUpdateHunkIsNotEmpty(state, trimmed, currentLineNumber);
    if (error !== undefined) {
      return { handled: 'error', error };
    }
    state.hunks.push({ type: 'add', path: trimmed.slice(ADD_FILE_MARKER.length), lines: [] });
    state.mode = { kind: 'add_file' };
    return { handled: true };
  }
  if (trimmed.startsWith(DELETE_FILE_MARKER)) {
    const error = ensureUpdateHunkIsNotEmpty(state, trimmed, currentLineNumber);
    if (error !== undefined) {
      return { handled: 'error', error };
    }
    state.hunks.push({ type: 'delete', path: trimmed.slice(DELETE_FILE_MARKER.length) });
    state.mode = { kind: 'delete_file' };
    return { handled: true };
  }
  if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
    const error = ensureUpdateHunkIsNotEmpty(state, trimmed, currentLineNumber);
    if (error !== undefined) {
      return { handled: 'error', error };
    }
    state.hunks.push({
      type: 'update',
      path: trimmed.slice(UPDATE_FILE_MARKER.length),
      movePath: undefined,
      chunks: [],
    });
    state.mode = { kind: 'update_file', hunkLineNumber: currentLineNumber };
    return { handled: true };
  }
  return { handled: false };
}

const INVALID_HEADER_MESSAGE = (trimmed: string): string =>
  `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`;

/** Port of `StreamingPatchParser::process_line`, run once per line rather than incrementally. */
function processLine(state: ParserState, line: string, currentLineNumber: number): ApplyPatchParseFailure | undefined {
  const trimmed = line.trim();
  switch (state.mode.kind) {
    case 'not_started': {
      if (trimmed === BEGIN_PATCH_MARKER) {
        state.mode = { kind: 'started_patch' };
        return undefined;
      }
      return fail("The first line of the patch must be '*** Begin Patch'", undefined);
    }
    case 'started_patch': {
      const handled = handleHunkHeadersAndEndPatch(state, trimmed, currentLineNumber);
      if (handled.handled === true) {
        return undefined;
      }
      if (handled.handled === 'error') {
        return handled.error;
      }
      return fail(INVALID_HEADER_MESSAGE(trimmed), currentLineNumber);
    }
    case 'add_file': {
      const handled = handleHunkHeadersAndEndPatch(state, trimmed, currentLineNumber);
      if (handled.handled === true) {
        return undefined;
      }
      if (handled.handled === 'error') {
        return handled.error;
      }
      const lastHunk = state.hunks[state.hunks.length - 1];
      if (line.startsWith('+') && lastHunk?.type === 'add') {
        lastHunk.lines.push(line.slice(1));
        return undefined;
      }
      return fail(INVALID_HEADER_MESSAGE(trimmed), currentLineNumber);
    }
    case 'delete_file': {
      const handled = handleHunkHeadersAndEndPatch(state, trimmed, currentLineNumber);
      if (handled.handled === true) {
        return undefined;
      }
      if (handled.handled === 'error') {
        return handled.error;
      }
      return fail(INVALID_HEADER_MESSAGE(trimmed), currentLineNumber);
    }
    case 'update_file': {
      const hunkLineNumber = state.mode.hunkLineNumber;
      const updateLine = line.replace(/\s+$/u, '');
      const handled = handleHunkHeadersAndEndPatch(state, updateLine, currentLineNumber);
      if (handled.handled === true) {
        return undefined;
      }
      if (handled.handled === 'error') {
        return handled.error;
      }

      const lastHunk = state.hunks[state.hunks.length - 1];
      if (lastHunk?.type !== 'update') {
        return fail(
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
          currentLineNumber,
        );
      }
      const { chunks } = lastHunk;
      const lastChunk = chunks[chunks.length - 1];

      if (lastChunk?.endOfFile === true) {
        if (updateLine.length === 0) {
          return undefined;
        }
        if (updateLine !== EMPTY_CHANGE_CONTEXT_MARKER && !updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
          return fail(`Expected update hunk to start with a @@ context marker, got: '${line}'`, currentLineNumber);
        }
      }

      if (chunks.length === 0 && lastHunk.movePath === undefined && updateLine.startsWith(MOVE_TO_MARKER)) {
        lastHunk.movePath = updateLine.slice(MOVE_TO_MARKER.length);
        state.mode = { kind: 'update_file', hunkLineNumber };
        return undefined;
      }

      const looksLikeNewContextHeader =
        updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER);
      if (looksLikeNewContextHeader && lastChunk?.bodyLines.length === 0) {
        return fail(
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
          currentLineNumber,
        );
      }

      if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
        chunks.push({ trailer: undefined, bodyLines: [], endOfFile: false });
        state.mode = { kind: 'update_file', hunkLineNumber };
        return undefined;
      }

      if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
        chunks.push({ trailer: updateLine.slice(CHANGE_CONTEXT_MARKER.length), bodyLines: [], endOfFile: false });
        state.mode = { kind: 'update_file', hunkLineNumber };
        return undefined;
      }

      if (updateLine === EOF_MARKER) {
        if (lastChunk?.bodyLines.length === 0) {
          return fail('Update hunk does not contain any lines', currentLineNumber);
        }
        if (lastChunk !== undefined) {
          lastChunk.endOfFile = true;
        }
        state.mode = { kind: 'update_file', hunkLineNumber };
        return undefined;
      }

      if (line.length === 0) {
        const chunk = chunks.length === 0 ? pushDefaultChunk(chunks) : (lastChunk ?? pushDefaultChunk(chunks));
        chunk.bodyLines.push({ marker: ' ', text: '' });
        state.mode = { kind: 'update_file', hunkLineNumber };
        return undefined;
      }

      if (line.startsWith(' ')) {
        const chunk = chunks.length === 0 ? pushDefaultChunk(chunks) : (lastChunk ?? pushDefaultChunk(chunks));
        chunk.bodyLines.push({ marker: ' ', text: line.slice(1) });
        state.mode = { kind: 'update_file', hunkLineNumber };
        return undefined;
      }

      if (line.startsWith('+')) {
        const chunk = chunks.length === 0 ? pushDefaultChunk(chunks) : (lastChunk ?? pushDefaultChunk(chunks));
        chunk.bodyLines.push({ marker: '+', text: line.slice(1) });
        state.mode = { kind: 'update_file', hunkLineNumber };
        return undefined;
      }

      if (line.startsWith('-')) {
        const chunk = chunks.length === 0 ? pushDefaultChunk(chunks) : (lastChunk ?? pushDefaultChunk(chunks));
        chunk.bodyLines.push({ marker: '-', text: line.slice(1) });
        state.mode = { kind: 'update_file', hunkLineNumber };
        return undefined;
      }

      if (lastChunk !== undefined && lastChunk.bodyLines.length > 0) {
        // Left as an explicit non-null check (not `lastChunk?.bodyLines.length > 0`): an optional
        // chain here would make the whole comparison `undefined > 0`, which is `false` — the
        // same outcome for this branch, but only by coincidence of how `undefined` compares.
        return fail(`Expected update hunk to start with a @@ context marker, got: '${line}'`, currentLineNumber);
      }
      return fail(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        currentLineNumber,
      );
    }
    case 'ended_patch': {
      if (trimmed.length === 0) {
        return undefined;
      }
      return fail("The last line of the patch must be '*** End Patch'", undefined);
    }
    default:
      return undefined;
  }
}

function pushDefaultChunk(chunks: ApplyPatchUpdateChunk[]): ApplyPatchUpdateChunk {
  const chunk: ApplyPatchUpdateChunk = { trailer: undefined, bodyLines: [], endOfFile: false };
  chunks.push(chunk);
  return chunk;
}

/**
 * Parses one already-delimited OpenAI `apply_patch` envelope (a `*** Begin Patch` / `*** End
 * Patch` block, optionally wrapped in a shell heredoc) into its file operations. Port of
 * `parse_patch_text` with `ParseMode::Lenient` (the only mode this repository's caller — and
 * upstream's own default — uses).
 */
export function parseApplyPatchEnvelope(patchText: string): ApplyPatchParseSuccess | ApplyPatchParseFailure {
  const lines = patchText.trim().split('\n');
  const boundaries = checkPatchBoundariesLenient(lines);
  if (boundaries.status === 'error') {
    return fail(boundaries.message, undefined);
  }
  const state: ParserState = { mode: { kind: 'not_started' }, hunks: [], environmentId: undefined };
  let lineNumber = 0;
  for (const line of boundaries.lines) {
    lineNumber += 1;
    const error = processLine(state, line, lineNumber);
    if (error !== undefined) {
      return error;
    }
  }
  if (state.mode.kind !== 'ended_patch') {
    return fail("The last line of the patch must be '*** End Patch'", undefined);
  }
  return { status: 'ok', hunks: state.hunks, environmentId: state.environmentId };
}

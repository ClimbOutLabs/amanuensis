/**
 * Single inbound normalisation layer for structured-edit tool arguments (`apply_patch`,
 * `replace_text`, `write_file`). Every model-supplied argument for these tools passes through
 * `normalizeStructuredEditArguments` before validation, so a cosmetic shape difference between
 * models (a markdown fence, CRLF line endings, a line-number gutter, an absolute path, the
 * OpenAI patch dialect, a `<field>_lines` array in place of `<field>`) is repaired once, in one
 * place, rather than rejected once per model per shape. Only `patch` and
 * `old_text` are touched by the cosmetic rules; `new_text` and `content` are written to disk
 * verbatim and are never cosmetically rewritten (see the field-by-field note below
 * `normalizeStructuredEditArguments`). The line-array join described next is a different kind of
 * rule: it runs first, ahead of the cosmetic ones, and applies to `content` and `new_text` too.
 *
 * Every multi-line text field a structured-edit tool accepts (`content`, `patch`, `old_text`,
 * `new_text`) also accepts a sibling `<field>_lines` array, one array element per line, blank
 * lines as empty strings, because a model reliably produces one array element per line but
 * unreliably produces embedded `\n` inside a single JSON string value (observed live against
 * gpt-oss-120b: pretty-printed JSON between keys, but newlines inside a string value flattened to
 * spaces, and separators it tried instead, "<br/>", "%n", "|", fared no better). Zod resolves
 * each pair (see `resolveLineArrayField`, called from each field's `.transform()` in `Sandbox.ts`)
 * before the structured-edit handler ever sees the arguments; `LINE_ARRAY_FIELD_PAIRS` below and
 * `resolveLineArrayField` are exported so that resolution is the one place a `<field>_lines` array
 * turns into a string, whether a model supplies it directly (Zod's own validation path) or a
 * caller passes raw, pre-validation arguments through `normalizeStructuredEditArguments` (the
 * `toolCallInfo` approval-card path in `Sandbox.ts`, which never calls Zod at all; the approval
 * card must show the same joined text the eventual dispatch will act on).
 *
 * Pure and I/O-free: every rule here operates on the argument text and the caller-supplied
 * `cwd`/`repositoryRoot`, never touches the sandbox filesystem. The exact-offset read needed to
 * place an OpenAI-format hunk precisely stays in `Sandbox.ts`, which calls
 * `convertOpenAIPatchToGitDiff` a second time with real file content once the sandbox is
 * available; this module only produces the same placeholder-offset conversion available before
 * that read, which is enough for path extraction, approval identity, and display.
 */

import { posix, win32 } from 'node:path';
import { convertOpenAIPatchToGitDiff, detectApplyPatchFormat } from './openaiPatchFormat';
import { structuredEditCwdRelativePath } from './structuredEditPaths';

export type StructuredEditToolName = 'apply_patch' | 'replace_text' | 'write_file';

export interface NormalizeStructuredEditArgumentsInput<T extends Record<string, unknown> = Record<string, unknown>> {
  toolName: StructuredEditToolName;
  args: Readonly<T>;
  cwd: string;
  repositoryRoot: string;
  /**
   * Whether to detect and convert the OpenAI apply_patch dialect (default `true`). `Sandbox.ts`
   * passes `false` at actual dispatch time: `handleApplyPatch` runs its own two-pass dialect
   * conversion (`resolveApplyPatchGitDiff`) — a placeholder-offset pass for path extraction, then
   * an exact-offset pass once the sandbox is available to read real file content — and converting
   * the dialect here first would make that first pass see an already-converted Git diff and skip
   * the exact-offset pass entirely. Every other caller (the proposal-time `toolCallInfo` pass,
   * which never reads file content either way) wants the default.
   */
  applyPatchDialect?: boolean;
}

export interface NormalizeStructuredEditArgumentsResult<T extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * The argument object with every applicable normalisation applied. Same shape (keys and value
   * types) as the input `args`, with one narrow exception: when a `<field>_lines` array sibling
   * (see `LINE_ARRAY_FIELD_PAIRS`) was present and its `<field>` string counterpart was not, the
   * array key is replaced by the joined `<field>` string key. Every other rule only ever
   * overwrites a known text/path field's string value with another string; it never adds,
   * removes, or retypes any other field.
   */
  args: T;
  /** One entry per normalisation actually applied, in the order applied — for the approval card and logs. */
  notes: string[];
}

// `patch` is a parsed structure (a diff), not exact bytes, so it gets the full cosmetic-cleanup
// pass. `old_text` is only ever used to *locate* a passage — the exact matcher in
// `replaceTextDiagnostics.ts` requires it to occur exactly once in the real file bytes before
// dispatch, never guessing — so cosmetic drift there (BOM, a wrapping fence, CRLF) is safe to
// clean up too, ahead of that exact check. A uniform line-number gutter is a different kind of
// drift: whether it is a display artefact to discard or real file content can only be told by
// trying both readings against the file, so that decision stays out of this pure, I/O-free
// module and happens once, at match time, in `replaceTextDiagnostics.ts`. `new_text` and
// `content` are written to the file verbatim, with no matching step downstream to catch a
// cosmetic transformation that changed the model's intended bytes, so they are never touched
// here.
const PATCH_FIELD = 'patch';
const MATCHED_TEXT_FIELD = 'old_text';
const PATH_FIELDS = ['path', 'cwd'] as const;

/** One `<field>` / `<field>_lines` sibling pair a structured-edit tool accepts. */
export interface LineArrayFieldPair {
  /** The plain-string field name downstream code consumes (e.g. `"content"`). */
  readonly stringField: string;
  /** The sibling array-of-lines field name (e.g. `"content_lines"`). */
  readonly arrayField: string;
}

/**
 * The `<field>` / `<field>_lines` pairs each structured-edit tool accepts, in the order they are
 * resolved. `write_file` and `apply_patch` each take one pair; `replace_text` takes two
 * (`old_text`/`old_text_lines` and `new_text`/`new_text_lines`), resolved independently.
 */
export const LINE_ARRAY_FIELD_PAIRS: Readonly<Record<StructuredEditToolName, readonly LineArrayFieldPair[]>> = {
  write_file: [{ stringField: 'content', arrayField: 'content_lines' }],
  apply_patch: [{ stringField: PATCH_FIELD, arrayField: 'patch_lines' }],
  replace_text: [
    { stringField: MATCHED_TEXT_FIELD, arrayField: 'old_text_lines' },
    { stringField: 'new_text', arrayField: 'new_text_lines' },
  ],
};

export type ResolveLineArrayFieldResult =
  | { status: 'ok'; value: string }
  | { status: 'missing'; message: string }
  | { status: 'conflict'; message: string }
  | { status: 'too_short'; message: string }
  | { status: 'too_long'; message: string };

/**
 * Resolves one `<field>` / `<field>_lines` argument pair to the single string `<field>` every
 * downstream consumer (a structured-edit handler, `git apply --check`, the exact-match replace
 * script) expects. Exactly one of `stringValue`/`arrayValue` must be supplied; `arrayValue` is
 * joined with `"\n"`, one array element per line, blank lines as empty strings. `minLength`/
 * `maxLength` bound the *joined* value so the same limits apply regardless of which form a model
 * used; the array form has no length limit of its own to enforce independently.
 *
 * The one function both boundary crossings call: `Sandbox.ts`'s per-field Zod `.transform()`
 * (real dispatch, validated `<field>_lines` already known to be `string[]`) and
 * `normalizeStructuredEditArguments` below (the `toolCallInfo` approval-card pass, over raw,
 * pre-validation arguments); see the module docstring.
 */
export function resolveLineArrayField(input: {
  stringField: string;
  arrayField: string;
  stringValue: string | undefined;
  arrayValue: readonly string[] | undefined;
  minLength?: number;
  maxLength?: number;
}): ResolveLineArrayFieldResult {
  const hasString = input.stringValue !== undefined;
  const hasArray = input.arrayValue !== undefined;
  if (hasString && hasArray) {
    return {
      status: 'conflict',
      message: `provide exactly one of ${input.stringField} or ${input.arrayField}, not both`,
    };
  }
  if (!hasString && !hasArray) {
    return {
      status: 'missing',
      message:
        `${input.stringField} is required; provide it as a string, or as ${input.arrayField} ` +
        '(an array of lines, one element per line, blank lines as empty strings)',
    };
  }
  // Exactly one of `input.arrayValue`/`input.stringValue` is defined at this point (both-defined
  // and neither-defined already returned above), so narrowing directly on `arrayValue !==
  // undefined`, rather than on the separately-computed `hasArray` boolean, reaches a definite
  // `string` with no type assertion.
  const value = input.arrayValue !== undefined ? input.arrayValue.join('\n') : (input.stringValue ?? '');
  if (input.minLength !== undefined && value.length < input.minLength) {
    return { status: 'too_short', message: `${input.stringField} must not be empty` };
  }
  if (input.maxLength !== undefined && value.length > input.maxLength) {
    return {
      status: 'too_long',
      message: `${input.stringField} must be at most ${String(input.maxLength)} characters`,
    };
  }
  return { status: 'ok', value };
}

// Opening fence with an optional language tag on its own line, and a closing fence on its own
// line, wrapping the whole (already BOM/CRLF-normalized) field value.
const CODE_FENCE_RE = /^`{3,}[^\n]*\n([\s\S]*?)\n`{3,}\s*$/u;

/** Strips a leading UTF-8 BOM, if present. */
function stripBom(value: string): string {
  return value.length > 0 && value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** Normalizes CRLF line endings to LF. Does not touch a lone CR. */
function normalizeCrlf(value: string): string {
  return value.replace(/\r\n/gu, '\n');
}

/** Strips one surrounding markdown code fence (with or without a language tag), if present. */
function stripSurroundingCodeFence(value: string): string {
  const match = CODE_FENCE_RE.exec(value);
  return match === null ? value : (match[1] ?? '');
}

// A leading line number followed by a colon or pipe (optionally padded with spaces/tabs) —
// "212 | ", "212:", "212: ", "212|" — the gutter shape editors and models render when they quote
// a file "with line numbers". Deliberately requires the `:`/`|` delimiter rather than accepting
// bare digits-then-space: `old_text` is otherwise free-form code, and a line that legitimately
// starts with a number followed only by whitespace (e.g. `3600 * 24`) must never be mistaken for
// a line-number gutter and have its leading digits silently deleted.
const LINE_NUMBER_GUTTER_RE = /^\d+[ \t]*[:|][ \t]*/u;
// Same shape, but capturing the number and the delimiter character so a candidate can be scored
// for internal consistency (see `stripLineNumberGutters`) before anything is stripped.
const LINE_NUMBER_GUTTER_CAPTURE_RE = /^(\d+)[ \t]*([:|])[ \t]*/u;

interface ParsedGutterLine {
  lineNumber: number;
  delimiter: string;
}

function parseGutterLine(line: string): ParsedGutterLine | undefined {
  const match = LINE_NUMBER_GUTTER_CAPTURE_RE.exec(line);
  if (match === null) {
    return undefined;
  }
  const lineNumber = Number(match[1] ?? '');
  const delimiter = match[2] ?? '';
  return Number.isFinite(lineNumber) ? { lineNumber, delimiter } : undefined;
}

/**
 * Strips a leading line-number gutter from every line of `value`, but only when the whole value
 * is unambiguously a uniformly-numbered quote:
 *
 * - every line (a lone trailing newline aside — see below) carries a `LINE_NUMBER_GUTTER_RE`
 *   prefix at all, so a single ungutted line means this is not a numbered quote and nothing is
 *   stripped (a partial strip would silently delete real leading characters from the lines it
 *   left alone believing they had no gutter);
 * - every line uses the *same* delimiter character (all `:` or all `|`) — real numbered code
 *   (a numbered list, line-numbered output from an unrelated tool) mixing delimiters is not a
 *   gutter this normaliser produced anywhere, so treating it as one risks stripping real content;
 * - the numbers are strictly increasing by exactly one from line to line — the shape an editor or
 *   model actually renders for "quote of consecutive lines with line numbers" — so a file that
 *   happens to contain `1: foo` and `2: bar` as its own two *separate, non-adjacent* lines (not a
 *   contiguous numbered quote) does not get misread as a gutter and silently redirect the match to
 *   wherever `foo`/`bar` also occur unguttered (see `replaceTextDiagnostics.ts`, which now tries
 *   `old_text` verbatim before ever trying this stripped form, precisely to keep that
 *   misclassification from silently substituting the wrong passage).
 *
 * A single trailing newline is preserved and excluded from both checks: splitting a
 * newline-terminated value on `\n` produces a final empty-string element that can never carry a
 * gutter, and requiring it to would leave every terminal-newline quote unstripped.
 */
export function stripLineNumberGutters(value: string): string {
  const hadTrailingNewline = value.endsWith('\n');
  const body = hadTrailingNewline ? value.slice(0, -1) : value;
  if (body.length === 0) {
    return value;
  }
  const lines = body.split('\n');
  const parsed = lines.map(parseGutterLine);
  if (parsed.some(entry => entry === undefined)) {
    return value;
  }
  const gutters = parsed as ParsedGutterLine[];
  const delimiter = gutters[0]?.delimiter;
  if (!gutters.every(entry => entry.delimiter === delimiter)) {
    return value;
  }
  let previousLineNumber = gutters[0]?.lineNumber;
  for (const gutter of gutters.slice(1)) {
    if (previousLineNumber === undefined || gutter.lineNumber !== previousLineNumber + 1) {
      return value;
    }
    previousLineNumber = gutter.lineNumber;
  }
  const stripped = lines.map(line => line.replace(LINE_NUMBER_GUTTER_RE, '')).join('\n');
  return hadTrailingNewline ? `${stripped}\n` : stripped;
}

/**
 * Trims leading and trailing blank (whitespace-only) lines, preserving interior blank lines and
 * a single trailing newline byte when the input had one — a well-formed patch already ends in
 * exactly one trailing newline, and callers pass this text on to byte-for-byte comparisons and
 * `git apply`, so that shape must survive untouched, not be collapsed away as "just another
 * blank line".
 */
function trimBlankLines(value: string): string {
  const hadTrailingNewline = value.endsWith('\n');
  const lines = value.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim().length === 0) {
    start += 1;
  }
  while (end > start && (lines[end - 1] ?? '').trim().length === 0) {
    end -= 1;
  }
  const trimmed = lines.slice(start, end).join('\n');
  return hadTrailingNewline && trimmed.length > 0 ? `${trimmed}\n` : trimmed;
}

interface FieldNormalization {
  value: string;
  notes: string[];
}

/**
 * Applies BOM/fence/CRLF normalisation common to every text field, without patch-only blank-line
 * trimming. `old_text` is deliberately *not* given a line-number-gutter strip here: whether a
 * uniform `"212 | "`/`"212:"` prefix is a display gutter to discard or legitimate file content
 * (numbered code, a numbered list) can only be told apart by trying both readings against the
 * real file, which this module — pure and I/O-free by design (see the module docstring) — cannot
 * do. That decision, and the exact match it depends on, happens once, together, at match time in
 * `replaceTextDiagnostics.ts`: the raw value is tried first, and the gutter-stripped form
 * (`stripLineNumberGutters`, exported from this module) only afterward, never both silently.
 */
function normalizeTextField(field: string, raw: string): FieldNormalization {
  const notes: string[] = [];
  let value = raw;

  const withoutBom = stripBom(value);
  if (withoutBom !== value) {
    notes.push(`stripped a leading byte-order mark from ${field}`);
    value = withoutBom;
  }

  const withoutFence = stripSurroundingCodeFence(value);
  if (withoutFence !== value) {
    notes.push(`stripped a surrounding markdown code fence from ${field}`);
    value = withoutFence;
  }

  const withCrlfNormalized = normalizeCrlf(value);
  if (withCrlfNormalized !== value) {
    notes.push(`normalized CRLF line endings to LF in ${field}`);
    value = withCrlfNormalized;
  }

  return { value, notes };
}

/**
 * Normalizes one path-shaped field: BOM strip, then cwd-relativization. Deliberately does not
 * rewrite Unicode punctuation (a Unicode hyphen or no-break space) to its ASCII look-alike: this
 * module is pure and I/O-free (see the module docstring), so it has no way to tell a genuine
 * Unicode filename from a model typo for an ASCII one apart — silently substituting would risk
 * retargeting a `write_file`/`replace_text` call from the file the model named to a different
 * one. That kind of typo repair needs filesystem awareness (does the exact path already exist?)
 * and belongs, if added, in a later stage that can check.
 */
function normalizePathField(input: {
  field: string;
  raw: string;
  cwd: string;
  repositoryRoot: string;
}): FieldNormalization {
  const notes: string[] = [];
  let value = stripBom(input.raw);
  if (value !== input.raw) {
    notes.push(`stripped a leading byte-order mark from ${input.field}`);
  }

  const windowsStyle = /^[A-Za-z]:[\\/]/u.test(input.repositoryRoot) || input.repositoryRoot.includes('\\');
  const pathApi = windowsStyle ? win32 : posix;
  if (pathApi.isAbsolute(value)) {
    const relative = structuredEditCwdRelativePath({
      repositoryRoot: input.repositoryRoot,
      cwd: input.cwd,
      path: value,
    });
    if (relative !== undefined && relative !== value) {
      notes.push(`rewrote absolute path in ${input.field} as cwd-relative ("${relative}")`);
      value = relative;
    }
  }

  return { value, notes };
}

/**
 * Detects and converts the OpenAI `apply_patch` envelope dialect (including an envelope-less
 * body that opens directly at a file-operation header) to a Git-format unified diff, using
 * placeholder hunk offsets. A patch already in Git-diff form passes through unchanged. Invalid
 * input is returned unchanged; the existing `extractStructuredEditPaths` / `git apply --check`
 * pipeline produces the actual rejection for it, through the same rejection contract.
 */
function normalizePatchDialect(patch: string): FieldNormalization {
  const format = detectApplyPatchFormat(patch);
  if (format.status !== 'openai') {
    return { value: patch, notes: [] };
  }
  const converted = convertOpenAIPatchToGitDiff(patch);
  if (converted.status !== 'converted') {
    return { value: patch, notes: [] };
  }
  return { value: converted.gitDiff, notes: ['converted OpenAI apply_patch envelope to a Git-format unified diff'] };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

/**
 * Runtime type guard confirming `candidate` has exactly the keys `original` has, each holding a
 * value of the same JS type — the invariant `normalizeStructuredEditArguments` actually
 * maintains (it only ever overwrites an existing string field's value with another string; it
 * never adds, removes, or retypes a key), with one allowed substitution per `toolName`'s
 * `LINE_ARRAY_FIELD_PAIRS`: an `original` key that was only a `<field>_lines` array (no
 * `<field>` string alongside it) may become a `<field>` string key in `candidate` instead: the
 * line-array join `normalizeStructuredEditArguments` applies below. Used in place of an unchecked
 * `as T` assertion: the compiler only narrows `candidate` to `T` once this has verified the
 * runtime shape actually matches (modulo that one substitution), so a future edit that broke the
 * invariant would fail loudly instead of silently handing a mistyped object to a caller that
 * trusts `T`'s shape.
 */
function hasSameShape<T extends Record<string, unknown>>(
  candidate: Record<string, unknown>,
  original: T,
  toolName: StructuredEditToolName,
): candidate is T {
  const originalKeys = new Set(Object.keys(original));
  const candidateKeys = new Set(Object.keys(candidate));
  const pairs = LINE_ARRAY_FIELD_PAIRS[toolName];

  // A key `original` had but `candidate` lacks is allowed only when it is a pair's `arrayField`,
  // that pair's `stringField` was not itself already in `original` (so joining was the only way
  // to produce it), and `candidate` actually carries that `stringField` as a string, i.e. the
  // join really happened, rather than merely being eligible to.
  for (const key of originalKeys) {
    if (candidateKeys.has(key)) {
      if (typeof candidate[key] !== typeof original[key]) {
        return false;
      }
      continue;
    }
    const pair = pairs.find(candidatePair => candidatePair.arrayField === key);
    const joined =
      pair !== undefined && !originalKeys.has(pair.stringField) && typeof candidate[pair.stringField] === 'string';
    if (!joined) {
      return false;
    }
  }

  // Symmetrically, a key `candidate` has but `original` lacks is allowed only as that same kind
  // of join's `stringField` result.
  for (const key of candidateKeys) {
    if (originalKeys.has(key)) {
      continue;
    }
    const pair = pairs.find(candidatePair => candidatePair.stringField === key);
    const validSubstitution =
      pair !== undefined && originalKeys.has(pair.arrayField) && !originalKeys.has(pair.stringField);
    if (!validSubstitution) {
      return false;
    }
  }
  return true;
}

/**
 * Applies BOM/fence/blank-line/CRLF normalisation to `patch`. Blank-line trimming runs both
 * before and after fence stripping: the fence-detection regex is anchored to the start and end
 * of the (BOM-stripped) value, so a fence preceded or followed by blank-line padding — a common
 * shape when a model wraps a fenced patch in its own surrounding whitespace — would not be
 * recognized if trimming ran only once, after the fence check.
 */
function normalizePatchField(raw: string): FieldNormalization {
  const notes: string[] = [];
  let value = raw;

  const withoutBom = stripBom(value);
  if (withoutBom !== value) {
    notes.push('stripped a leading byte-order mark from patch');
    value = withoutBom;
  }

  const prePadTrimmed = trimBlankLines(value);
  if (prePadTrimmed !== value) {
    notes.push('trimmed leading/trailing blank lines from patch');
    value = prePadTrimmed;
  }

  const withoutFence = stripSurroundingCodeFence(value);
  if (withoutFence !== value) {
    notes.push('stripped a surrounding markdown code fence from patch');
    value = withoutFence;
    const postFenceTrimmed = trimBlankLines(value);
    if (postFenceTrimmed !== value) {
      notes.push('trimmed leading/trailing blank lines from patch');
      value = postFenceTrimmed;
    }
  }

  const withCrlfNormalized = normalizeCrlf(value);
  if (withCrlfNormalized !== value) {
    notes.push('normalized CRLF line endings to LF in patch');
    value = withCrlfNormalized;
  }

  return { value, notes };
}

/**
 * Normalizes one structured-edit tool call's arguments. Rules are applied in this order, all pure
 * and unit-tested in isolation:
 *
 * 1. For each of this tool's `LINE_ARRAY_FIELD_PAIRS`, join a `<field>_lines` array sibling into
 *    the `<field>` string (when the array was supplied and the string was not); see
 *    `resolveLineArrayField` and the module docstring. Every later rule below then sees only the
 *    joined string, exactly as if the model had supplied `<field>` directly.
 * 2. Strip a leading BOM from `patch`, `old_text`, and every path field.
 * 3. Trim leading/trailing blank lines from `patch`, strip one surrounding markdown code fence
 *    from `patch`, then trim blank lines again (so padding around a fence does not hide it), then
 *    normalize CRLF to LF in `patch`. `old_text` gets the same BOM/fence/CRLF cleanup, minus
 *    blank-line trimming (its whitespace is meaningful, and it is only ever used to *locate* a
 *    passage — the exact matcher requires it to occur exactly once in the real file bytes before
 *    dispatch, never guessing). `new_text` and `content` are written to disk verbatim with no
 *    matching step to catch a cosmetic rewrite, so neither gets that cosmetic cleanup.
 * 4. Rewrite an absolute `path`/`cwd` inside the effective root as cwd-relative.
 * 5. Detect and convert the OpenAI `apply_patch` patch dialect (`patch` field only).
 *
 * A uniform line-number gutter (`"212 | "`, `"212:"`) is *not* stripped from `old_text` here —
 * see `stripLineNumberGutters` (exported from this module) and `replaceTextDiagnostics.ts`,
 * which applies it only after `old_text` verbatim has already been tried against the file and
 * failed to match uniquely.
 */
export function normalizeStructuredEditArguments<T extends Record<string, unknown>>(
  input: NormalizeStructuredEditArgumentsInput<T>,
): NormalizeStructuredEditArgumentsResult<T> {
  const args: Record<string, unknown> = { ...input.args };
  const notes: string[] = [];

  for (const pair of LINE_ARRAY_FIELD_PAIRS[input.toolName]) {
    const rawString = args[pair.stringField];
    const rawArray = args[pair.arrayField];
    if (isString(rawString) || !isStringArray(rawArray)) {
      // Either the string form was already supplied (nothing to join), both/neither form was
      // supplied (a conflict or a missing field, left as-is; the real rejection for that shape
      // comes from the Zod schema at actual dispatch, via the same `resolveLineArrayField`), or
      // `rawArray` was present but not an array of strings (also left for schema validation to
      // reject with a precise type error).
      continue;
    }
    const resolved = resolveLineArrayField({
      stringField: pair.stringField,
      arrayField: pair.arrayField,
      stringValue: undefined,
      arrayValue: rawArray,
    });
    if (resolved.status === 'ok') {
      args[pair.stringField] = resolved.value;
      // `pair.arrayField` is a dynamically-computed key, so `Reflect.deleteProperty` is used in
      // place of the `delete` operator here (the operator only accepts a statically-known key).
      Reflect.deleteProperty(args, pair.arrayField);
      notes.push(`joined ${pair.arrayField} into ${pair.stringField}`);
    }
  }

  const rawPatch = args[PATCH_FIELD];
  if (isString(rawPatch)) {
    const { value, notes: fieldNotes } = normalizePatchField(rawPatch);
    if (fieldNotes.length > 0) {
      args[PATCH_FIELD] = value;
      notes.push(...fieldNotes);
    }
  }

  const rawOldText = args[MATCHED_TEXT_FIELD];
  if (isString(rawOldText)) {
    const { value, notes: fieldNotes } = normalizeTextField(MATCHED_TEXT_FIELD, rawOldText);
    if (fieldNotes.length > 0) {
      args[MATCHED_TEXT_FIELD] = value;
      notes.push(...fieldNotes);
    }
  }

  for (const field of PATH_FIELDS) {
    const raw = args[field];
    if (!isString(raw) || field === 'cwd') {
      // cwd itself is the resolution base, not a target to rewrite; only `path` is normalized
      // against it. (cwd stays listed for documentation of what "path fields" means.)
      continue;
    }
    const { value, notes: fieldNotes } = normalizePathField({
      field,
      raw,
      cwd: input.cwd,
      repositoryRoot: input.repositoryRoot,
    });
    if (fieldNotes.length > 0) {
      args[field] = value;
      notes.push(...fieldNotes);
    }
  }

  if (input.toolName === 'apply_patch' && input.applyPatchDialect !== false) {
    const patchForDialectCheck = args[PATCH_FIELD];
    if (isString(patchForDialectCheck)) {
      const { value, notes: dialectNotes } = normalizePatchDialect(patchForDialectCheck);
      if (dialectNotes.length > 0) {
        args[PATCH_FIELD] = value;
        notes.push(...dialectNotes);
      }
    }
  }

  // `args` was built by spreading `input.args` (type `T`) and only ever overwriting a known
  // field's string value with another string, or joining a `<field>_lines` array sibling into
  // its `<field>` string (see `NormalizeStructuredEditArgumentsResult`'s `args` doc); never any
  // other add, remove, or retype of a key, so it still has T's shape (up to that one allowed
  // substitution). That invariant is checked at runtime by `hasSameShape` rather than merely
  // asserted: this is the one place T is narrowed, and every caller (including `Sandbox.ts`) gets
  // a properly typed `T` back with no cast of its own.
  if (!hasSameShape(args, input.args, input.toolName)) {
    throw new Error(
      'normalizeStructuredEditArguments: normalized argument object diverged in shape from its input; ' +
        'this indicates a bug in a normalization rule adding, removing, or retyping a field.',
    );
  }
  return { args, notes };
}

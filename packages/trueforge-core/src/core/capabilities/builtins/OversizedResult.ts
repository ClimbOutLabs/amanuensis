/**
 * Bounded generic summarizer for oversized tool results.
 *
 * This module is deliberately dumb: it parses, walks, and accounts for a large
 * JSON result under strict bounds, and either produces a complete structured
 * summary or admits defeat (returns undefined) so the caller can take the
 * conservative panic path. It never severs a JSON value mid-object, never
 * guesses at totals, and never invents a continuation call.
 *
 * Fetch semantics (which tool re-fetches what, with which id parameter) live
 * in EmailFetchSemantics.ts and are passed in; this module only renders them.
 */

export interface OversizedResultSummaryBase {
  /** Byte length of the original content. */
  total_bytes: number;
  /**
   * Source-reported total item count. Null means the total is unknown:
   * the source did not report one. Never guessed.
   */
  total_count: number | null;
  /** Items actually present in the parsed content. */
  items_seen: number;
  /** Items fully emitted in this summary (complete values only). */
  items_extracted: number;
  /** total_count - items_extracted, or null when the total is unknown. */
  unseen_count: number | null;
  /**
   * Items withheld by output screening. Screening withholds whole results
   * (replacing the message content), never individual items, so this is 0 by
   * construction here: screened-out content can never be counted as seen.
   */
  screened_out: number;
  /** True when anything was left out of this summary. */
  truncated: boolean;
  /** Prose accounting of what was and was not seen (F5: structured + prose). */
  unseen_statement: string;
  /**
   * The exact valid continuation call, supplied by the caller from the
   * fetch-semantics registry. Null when no re-fetch path exists; the caller
   * must tripwire-log that case.
   */
  next: string | null;
  /**
   * Envelope fields merged into the rendered payload (e.g. the email
   * metadata-first honesty note). Core accounting fields always win over
   * envelope keys on render.
   */
  envelope: Record<string, unknown> | undefined;
}

export type OversizedResultSummary =
  | (OversizedResultSummaryBase & {
      result_kind: 'collection';
      /** Collection items, each a complete JSON value. */
      items: unknown[];
    })
  | (OversizedResultSummaryBase & {
      result_kind: 'text';
      chars_total: number;
      chars_shown: number;
      text_excerpt: string;
    });

/** Parse ceiling: results tripping the large-output guard are ~24KB+; 1 MiB of JSON parses fast and cannot OOM the turn. */
export const OVERSIZED_RESULT_PARSE_MAX_BYTES = 1_048_576;
/** Bounded-walk budgets: exceeding any of them fails closed to the panic path. */
const MAX_WALK_DEPTH = 50;
const MAX_WALK_KEYS = 20_000;
const MAX_WALK_ITEMS = 20_000;
/** Summary emission budgets. Exported so fetch-semantics can avoid promising a token-jump that would skip unshown items. */
export const MAX_SUMMARY_ITEMS = 50;
const MAX_SUMMARY_BYTES = 20_000;
/**
 * Bounded text excerpt budget (4,000 chars). Shared by the JSON single-email
 * path, the email text fallback, and the generic text fallback — one budget,
 * one name, no drift.
 */
export const SINGLE_BODY_EXCERPT_CHARS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface WalkFrame {
  value: unknown;
  depth: number;
  /** Top-level field name when depth === 1, for collection detection. */
  field: string | undefined;
}

/**
 * Bounded walk of a parsed JSON value. Finds the item collection to
 * summarize (the preferred field's array, else the largest top-level array,
 * else the root itself when it is an array). A walk that exceeds its budgets
 * reports 'budget_exceeded' distinctly from 'absent': the caller must fail
 * closed on the former, never silently downgrade a hostile blob to a text
 * excerpt.
 */
type CollectionSearch =
  | { status: 'found'; field: string | undefined; items: unknown[] }
  | { status: 'absent' }
  | { status: 'budget_exceeded' };

function walkForCollection(root: unknown, preferredField: string | undefined): CollectionSearch {
  let keys = 0;
  let values = 0;
  let preferred: unknown[] | undefined;
  let largest: { field: string | undefined; items: unknown[] } | undefined;
  let rootArray: unknown[] | undefined;

  const stack: WalkFrame[] = [{ value: root, depth: 0, field: undefined }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }
    values += 1;
    if (values > MAX_WALK_ITEMS || frame.depth > MAX_WALK_DEPTH) {
      return { status: 'budget_exceeded' };
    }
    const { value, depth, field } = frame;
    if (Array.isArray(value)) {
      if (depth === 0) {
        rootArray = value;
      } else if (depth === 1 && field !== undefined) {
        if (preferredField !== undefined && field === preferredField && preferred === undefined) {
          preferred = value;
        }
        if (largest === undefined || value.length > largest.items.length) {
          largest = { field, items: value };
        }
      }
      // Efficiency: collection detection only inspects depth 0 (root array)
      // and depth 1 (arrays in root object fields). Do not descend into item
      // contents (depth >= 2) — they cannot be collections we care about, and
      // expanding them burns the walk budget on data that never influences
      // the outcome.
      if (depth < 2) {
        for (let index = value.length - 1; index >= 0; index--) {
          stack.push({ value: value[index], depth: depth + 1, field: undefined });
        }
      }
    } else if (isRecord(value)) {
      // Same: do not expand records at depth >= 2.
      if (depth < 2) {
        for (const [key, entry] of Object.entries(value)) {
          keys += 1;
          if (keys > MAX_WALK_KEYS) {
            return { status: 'budget_exceeded' };
          }
          stack.push({ value: entry, depth: depth + 1, field: depth === 0 ? key : undefined });
        }
      }
    }
  }

  if (preferred !== undefined) {
    return { status: 'found', field: preferredField, items: preferred };
  }
  if (largest !== undefined) {
    return { status: 'found', field: largest.field, items: largest.items };
  }
  if (rootArray !== undefined) {
    return { status: 'found', field: undefined, items: rootArray };
  }
  return { status: 'absent' };
}

/** Clean text excerpt: cut at the last newline before the cap, never mid-line. */
export function cleanExcerpt(text: string, maxChars: number): { excerpt: string; shown: number } {
  if (text.length <= maxChars) {
    return { excerpt: text, shown: text.length };
  }
  let cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  if (lastNewline > maxChars / 2) {
    cut = cut.slice(0, lastNewline);
  }
  return { excerpt: cut, shown: cut.length };
}

/**
 * True when the content's first non-whitespace character opens a JSON object
 * or array. Allocation-free: a regex scan, not a trimStart() copy.
 */
export function looksLikeJsonObjectOrArray(content: string): boolean {
  const idx = content.search(/\S/);
  return idx !== -1 && (content[idx] === '{' || content[idx] === '[');
}

/**
 * Heuristic: is this content human-readable text (not binary or hostile)?
 * Rejects content with NUL bytes or a high proportion of control characters.
 * Used to gate the generic text fallback — the panic path remains for blobs
 * that fail this check.
 */
export function isTextLike(content: string): boolean {
  if (content.includes('\0')) {
    return false;
  }
  // Sample the first 4k chars; count control chars (excluding common whitespace).
  const sample = content.slice(0, 4000);
  let controls = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controls++;
    }
  }
  // More than 5% control chars suggests binary, not text.
  return controls / Math.max(1, sample.length) < 0.05;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Shared builder for bounded text excerpts. Both the email text fallback
 * (EmailFetchSemantics) and the generic text fallback (below) use this, so
 * guard ordering, budgets, and the honesty contract stay in one place.
 *
 * Guards, in order: whitespace-only -> JSON-shape probe
 * (looksLikeJsonObjectOrArray, the single owner of that check) -> isTextLike
 * (when requireTextLike) -> 1 MiB char-length ceiling (cheap, before any O(n)
 * work) -> UTF-8 encode -> 1 MiB byte ceiling -> clean excerpt. Returns
 * undefined for JSON-looking, empty, over-ceiling, or (when requireTextLike)
 * non-text content.
 */
export function buildBoundedTextSummary(input: {
  content: string;
  /** Prefix for the unseen_statement, e.g. "The full result" or "The full text result from X". */
  statementPrefix: string;
  /** Tool-specific re-fetch guidance appended to the statement. */
  guidance: string;
  totalCount: number | null;
  itemsSeen: number;
  /** When true, reject content that fails the isTextLike heuristic. */
  requireTextLike: boolean;
}): OversizedResultSummary | undefined {
  const { content, statementPrefix, guidance, totalCount, itemsSeen, requireTextLike } = input;
  // Whitespace-only has no excerpt worth emitting; JSON objects/arrays belong
  // to the JSON summarizer — looksLikeJsonObjectOrArray is the single owner
  // of that shape check. Both scans stop at the first non-whitespace char.
  if (content.search(/\S/) === -1 || looksLikeJsonObjectOrArray(content)) {
    return undefined;
  }
  // Cheap ceiling before any O(n) work: 1 MiB char-length rejects huge ASCII
  // without an encode; the byte check below catches multibyte edge cases.
  if (content.length > OVERSIZED_RESULT_PARSE_MAX_BYTES) {
    return undefined;
  }
  if (requireTextLike && !isTextLike(content)) {
    return undefined;
  }
  const totalBytes = new TextEncoder().encode(content).length;
  if (totalBytes > OVERSIZED_RESULT_PARSE_MAX_BYTES) {
    return undefined;
  }
  const { excerpt: shownText, shown } = cleanExcerpt(content, SINGLE_BODY_EXCERPT_CHARS);
  return {
    result_kind: 'text',
    total_bytes: totalBytes,
    total_count: totalCount,
    items_seen: itemsSeen,
    items_extracted: 0,
    unseen_count: null,
    screened_out: 0,
    truncated: shown < content.length,
    unseen_statement:
      `${statementPrefix} (${content.length.toLocaleString('en-US')} characters) exceeded the output threshold. ` +
      `Showing the first ${shown.toLocaleString('en-US')} characters; the rest was not seen. ` +
      guidance,
    next: null,
    chars_total: content.length,
    chars_shown: shown,
    text_excerpt: shownText,
    envelope: undefined,
  };
}

/**
 * Bounded text fallback for non-email tools whose result is human-readable
 * text, not JSON. Without this, any MCP server returning text without
 * structuredContent hits the panic path ("the model has not seen this
 * result") and the model retries in a loop — the same failure class as the
 * Gmail incident, for any server.
 *
 * Gated by isTextLike: binary/hostile blobs still fail closed to panic.
 * Guidance is generic (re-run narrower/smaller); server-specific guidance
 * belongs in the tool's own semantics module.
 */
export function summarizeGenericTextResult(input: {
  content: string;
  toolName: string | undefined;
}): OversizedResultSummary | undefined {
  const { content, toolName } = input;
  const toolLabel = toolName !== undefined ? ` from ${toolName}` : '';
  return buildBoundedTextSummary({
    content,
    statementPrefix: `The full text result${toolLabel}`,
    guidance: 'If you need more, re-run the tool with narrower parameters or a smaller page size.',
    totalCount: null,
    itemsSeen: 0,
    requireTextLike: true,
  });
}

/**
 * Summarizes an oversized JSON tool result under strict bounds. Returns
 * undefined when the content cannot be fully accounted for (over the parse
 * ceiling, unparseable, or walk budgets exceeded): the caller must then take
 * the conservative panic path, never a partial guess.
 */
export function summarizeOversizedResult(input: {
  content: string;
  /** Preferred envelope field holding the item array (from fetch semantics). */
  collectionField: string | undefined;
  /** Source-reported total item count; null/undefined means total unknown. */
  totalCount: number | null | undefined;
  /**
   * Rendered form of the total for the prose statement (e.g. "~1,200 items
   * (server estimate)" when the source total is approximate). Defaults to the
   * exact "<n> items" rendering.
   */
  totalDisplay: string | undefined;
  /** Exact valid continuation call, or null when none exists. */
  next: string | null | undefined;
  /**
   * Byte length of the original tool result for reporting, when the caller
   * summarized a transformed projection (e.g. body-stripped email metadata)
   * rather than the raw content. Defaults to the UTF-8 length of `content`.
   * The parse ceiling always applies to `content` itself, never this value.
   */
  totalBytes: number | undefined;
}): OversizedResultSummary | undefined {
  const { content } = input;
  // True UTF-8 byte length, measured once and reused for the ceiling and the
  // reported total: string length is UTF-16 code units, not bytes.
  const contentBytes = new TextEncoder().encode(content).length;
  if (contentBytes > OVERSIZED_RESULT_PARSE_MAX_BYTES) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  const next = input.next ?? null;
  // Reported size: the caller's original byte count when it summarized a
  // projection, else the bytes of the content actually parsed.
  const totalBytes = input.totalBytes ?? contentBytes;
  const sourceTotal =
    typeof input.totalCount === 'number' && Number.isFinite(input.totalCount) && input.totalCount >= 0
      ? Math.floor(input.totalCount)
      : null;

  const collection = walkForCollection(parsed, input.collectionField);
  if (collection.status === 'budget_exceeded') {
    // The walk could not account for the content under its budgets: fail
    // closed to the panic path rather than downgrading a hostile blob to a
    // text excerpt that pretends the content was summarized.
    return undefined;
  }
  if (collection.status === 'absent') {
    // Not a collection: emit a bounded text excerpt of the whole content.
    const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    const { excerpt, shown } = cleanExcerpt(text, SINGLE_BODY_EXCERPT_CHARS);
    const truncated = shown < text.length;
    return {
      result_kind: 'text',
      total_bytes: totalBytes,
      total_count: sourceTotal,
      items_seen: 0,
      items_extracted: 0,
      unseen_count: null,
      screened_out: 0,
      truncated,
      unseen_statement:
        `Showing ${formatCount(shown)} of ${formatCount(text.length)} characters; ` +
        `${formatCount(text.length - shown)} characters were not shown and were not seen.`,
      next,
      chars_total: text.length,
      chars_shown: shown,
      text_excerpt: excerpt,
      envelope: undefined,
    };
  }

  const itemsSeen = collection.items.length;
  const totalCount = sourceTotal ?? itemsSeen;
  // Emit complete items only: serialize each whole, drop from the end while
  // the summary exceeds its byte budget. Never sever a value mid-object.
  const emitted: unknown[] = [];
  let emittedBytes = 0;
  for (const item of collection.items) {
    if (emitted.length >= MAX_SUMMARY_ITEMS) {
      break;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(item);
    } catch {
      break;
    }
    if (emittedBytes + serialized.length > MAX_SUMMARY_BYTES) {
      break;
    }
    emitted.push(item);
    emittedBytes += serialized.length;
  }
  const itemsExtracted = emitted.length;
  const unseenCount = sourceTotal === null ? null : Math.max(0, totalCount - itemsExtracted);
  const truncated = itemsExtracted < itemsSeen || (sourceTotal !== null && itemsExtracted < totalCount);
  const totalDisplay = input.totalDisplay ?? `${formatCount(totalCount)} items`;

  const unseen_statement =
    sourceTotal === null
      ? `Total unknown: the source reported no total. Showing ${formatCount(itemsExtracted)} of ` +
        `${formatCount(itemsSeen)} parsed items; ` +
        `${formatCount(itemsSeen - itemsExtracted)} parsed items were not shown and were not seen.`
      : `${formatCount(itemsExtracted)} of ${totalDisplay} shown; ` +
        `${formatCount(totalCount - itemsExtracted)} items were not shown and were not seen. ` +
        `Total: ${totalDisplay} in ${formatCount(totalBytes)} bytes.`;

  return {
    result_kind: 'collection',
    total_bytes: totalBytes,
    total_count: sourceTotal,
    items_seen: itemsSeen,
    items_extracted: itemsExtracted,
    unseen_count: unseenCount,
    screened_out: 0,
    truncated,
    unseen_statement,
    next,
    items: emitted,
    envelope: undefined,
  };
}

/**
 * Renders a summary to the structured JSON the model receives. `next` is
 * always actionable text: null becomes an explicit dead-end statement.
 */
export function renderOversizedResultSummary(summary: OversizedResultSummary): string {
  const payload: Record<string, unknown> = {
    note: 'The Agent has not seen the full tool result. Only what is shown below was seen. Do not present anything else as if it came from this result.',
    ...(summary.envelope ?? {}),
    result_kind: summary.result_kind,
    total_bytes: summary.total_bytes,
    total_count: summary.total_count,
    items_seen: summary.items_seen,
    items_extracted: summary.items_extracted,
    unseen_count: summary.unseen_count,
    screened_out: summary.screened_out,
    truncated: summary.truncated,
    unseen_statement: summary.unseen_statement,
    next:
      summary.next ??
      'No re-fetch path is available for this result. Tell the user the result was too large to use and answer only from what is shown above, saying so.',
  };
  if (summary.result_kind === 'collection') {
    payload['items'] = summary.items;
  } else {
    payload['chars_total'] = summary.chars_total;
    payload['chars_shown'] = summary.chars_shown;
    payload['text_excerpt'] = summary.text_excerpt;
  }
  return JSON.stringify(payload);
}

/**
 * Non-sensitive diagnostic for the tripwire/panic logs: tool name, content
 * length, and a hash of a short prefix (shape probe, not content). The log
 * carries the digest only, never attacker-controlled text.
 */
export function oversizedResultFingerprint(input: { toolName: string; content: string }): string {
  const prefix = input.content.slice(0, 64);
  let hash = 0x811c9dc5;
  for (let index = 0; index < prefix.length; index++) {
    hash ^= prefix.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${input.toolName}:len=${String(input.content.length)}:prefix=${(hash >>> 0).toString(16)}`;
}

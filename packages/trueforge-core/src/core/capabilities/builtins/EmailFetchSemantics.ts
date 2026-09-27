/**
 * Static fetch-semantics table for known email integrations.
 *
 * Shape heuristics may influence how a result is displayed, but re-fetch
 * semantics — which tool fetches what, with which id parameter, and how a
 * collection paginates — come only from this table, keyed by the tool's
 * original name (never inferred from attacker-controlled result content).
 * Entries without a serverId match any server; a server-qualified entry wins
 * over the unqualified one when both match. Unqualified matching is
 * deliberate, not a shortcut: server ids are user-configured and carry no
 * stable fingerprint of the integration, so qualification would be theater.
 * A same-named tool on another server is safe by construction — the shape
 * check (envelope fields, id coverage) fails closed to the generic summary
 * when the result does not fit, and continuations only name tools from this
 * same table. Qualify an entry by server only if a second integration ever
 * collides on a tool name with a compatible shape but different mechanics.
 *
 * Current entries cover the Gmail MCP server (@george43g/gmail-mcp).
 */
import {
  buildBoundedTextSummary,
  MAX_SUMMARY_ITEMS,
  OVERSIZED_RESULT_PARSE_MAX_BYTES,
  SINGLE_BODY_EXCERPT_CHARS,
  summarizeOversizedResult,
  type OversizedResultSummary,
} from './OversizedResult';

export interface EmailPaginationSemantics {
  /** Parameter bounding the page size on a re-run. */
  maxResultsParam: string;
  /** Parameter carrying the continuation token on a re-run. */
  pageTokenParam: string;
  /** Result field holding the next-page token. */
  nextTokenField: string;
}

/**
 * Same-tool narrowing: re-running the same tool with this param set to this
 * value yields a smaller result (e.g. get_thread with format=metadata returns
 * headers without bodies). The id is echoed back from the given root field.
 */
export interface EmailNarrowingSemantics {
  param: string;
  value: string;
  idEchoField: string;
  idParam: string;
}

export interface EmailFetchSemantics {
  /** Server qualifier; undefined matches any server. */
  serverId: string | undefined;
  /** Original tool name this entry describes. */
  toolName: string;
  /** Item field carrying the re-fetchable id. Every item must have it. */
  idField: string;
  /** Envelope fields holding the item array, in preference order. */
  envelopeFields: readonly string[];
  /** Result fields that may report the total, in preference order. */
  totalFields: readonly string[];
  /**
   * True when the total fields are server-side estimates rather than exact
   * counts (Gmail's resultSizeEstimate); the rendered total is then marked
   * approximate instead of stated as fact.
   */
  totalApproximate: boolean;
  /** Tool that fetches one full item. */
  fetchTool: string;
  /** Parameter the fetch tool takes for the id. */
  fetchIdParam: string;
  /** Native pagination affordance, when the tool pages. */
  pagination: EmailPaginationSemantics | undefined;
  /** Same-tool narrowing affordance, when re-running smaller is valid. */
  narrowing: EmailNarrowingSemantics | undefined;
  /** Nested item check: each item's nestedField array entries must carry nestedIdField. */
  nestedField: string | undefined;
  nestedIdField: string | undefined;
  /** Single-item tools (read_email): no collection, no intra-item paging. */
  singleItem: boolean | undefined;
}

const GMAIL_PAGINATION: EmailPaginationSemantics = {
  maxResultsParam: 'maxResults',
  pageTokenParam: 'pageToken',
  nextTokenField: 'nextPageToken',
};

const EMAIL_FETCH_SEMANTICS: readonly EmailFetchSemantics[] = [
  {
    toolName: 'search_emails',
    serverId: undefined,
    idField: 'id',
    envelopeFields: ['results'],
    totalFields: ['resultSizeEstimate', 'total_available', 'resultCount'],
    totalApproximate: true,
    fetchTool: 'read_email',
    fetchIdParam: 'messageId',
    pagination: GMAIL_PAGINATION,
    narrowing: undefined,
    nestedField: undefined,
    nestedIdField: undefined,
    singleItem: undefined,
  },
  {
    toolName: 'list_inbox_threads',
    serverId: undefined,
    idField: 'threadId',
    envelopeFields: ['threads'],
    totalFields: ['resultSizeEstimate', 'total_available', 'resultCount'],
    totalApproximate: true,
    fetchTool: 'get_thread',
    fetchIdParam: 'threadId',
    pagination: GMAIL_PAGINATION,
    narrowing: undefined,
    nestedField: undefined,
    nestedIdField: undefined,
    singleItem: undefined,
  },
  {
    // get_thread fully enumerates the thread (no pagination): an oversized
    // thread is re-fetched with format=metadata (headers, no bodies), and
    // individual messages come from read_email.
    toolName: 'get_thread',
    serverId: undefined,
    idField: 'messageId',
    envelopeFields: ['messages'],
    totalFields: ['total_available', 'messageCount'],
    totalApproximate: false,
    fetchTool: 'read_email',
    fetchIdParam: 'messageId',
    pagination: undefined,
    narrowing: { param: 'format', value: 'metadata', idEchoField: 'threadId', idParam: 'threadId' },
    nestedField: undefined,
    nestedIdField: undefined,
    singleItem: undefined,
  },
  {
    // get_inbox_with_threads has no pageToken: threads are a union of bare
    // summaries and expanded threads carrying messages[]. Oversized results
    // narrow via expandThreads=false, and any full message is an exact
    // read_email call away using a nested message id.
    toolName: 'get_inbox_with_threads',
    serverId: undefined,
    idField: 'threadId',
    envelopeFields: ['threads'],
    totalFields: ['total_available', 'resultCount'],
    totalApproximate: false,
    fetchTool: 'read_email',
    fetchIdParam: 'messageId',
    pagination: undefined,
    narrowing: undefined,
    nestedField: 'messages',
    nestedIdField: 'messageId',
    singleItem: undefined,
  },
  {
    toolName: 'read_email',
    serverId: undefined,
    idField: 'messageId',
    envelopeFields: [],
    totalFields: [],
    totalApproximate: false,
    fetchTool: 'read_email',
    fetchIdParam: 'messageId',
    pagination: undefined,
    narrowing: undefined,
    nestedField: undefined,
    nestedIdField: undefined,
    singleItem: true,
  },
];

/** Looks up fetch semantics by original tool name, preferring a server-qualified entry. */
export function emailFetchSemanticsFor(input: {
  toolName: string;
  serverId: string | undefined;
}): EmailFetchSemantics | undefined {
  const candidates = EMAIL_FETCH_SEMANTICS.filter(entry => entry.toolName === input.toolName);
  if (candidates.length === 0) {
    return undefined;
  }
  if (input.serverId !== undefined) {
    const qualified = candidates.find(entry => entry.serverId === input.serverId);
    if (qualified !== undefined) {
      return qualified;
    }
  }
  return candidates.find(entry => entry.serverId === undefined);
}

/**
 * First-step guidance for the generic panic path, driven by the registry:
 * how the agent narrows or re-fetches instead of re-running the same call.
 */
export function emailFetchGuidance(semantics: EmailFetchSemantics): string {
  if (semantics.singleItem === true) {
    return (
      `Re-running ${semantics.toolName} returns the same oversized body; it has no intra-body paging. ` +
      'Tell the user the email is too large to read in full and ask which part they need.'
    );
  }
  if (semantics.pagination !== undefined) {
    const pagination = semantics.pagination;
    return (
      `Re-run with a small ${pagination.maxResultsParam} (e.g. 10) and pass the ` +
      `${pagination.nextTokenField} from the previous result as ${pagination.pageTokenParam} to fetch ` +
      `the next page. Do not raise ${pagination.maxResultsParam} to pull everything at once.`
    );
  }
  if (semantics.narrowing !== undefined) {
    const narrowing = semantics.narrowing;
    return (
      `Re-run ${semantics.toolName} with ${narrowing.param}="${narrowing.value}" for a smaller result ` +
      `without bodies, or fetch individual messages with ${semantics.fetchTool}(${semantics.fetchIdParam}).`
    );
  }
  // Nested collections (get_inbox_with_threads) have no pageToken: the
  // expansion is what blew the budget, so the re-run narrows the expansion.
  return (
    `Re-run ${semantics.toolName} with a small maxResults and expandThreads=false for thread ` +
    `summaries without bodies (this tool has no pageToken), or fetch any full message with ` +
    `${semantics.fetchTool}(${semantics.fetchIdParam} set to a message id from a thread's ${semantics.nestedField ?? 'messages'}).`
  );
}

/**
 * Guidance for the text fallback. The human-readable text shapes carry no
 * page tokens and no message IDs (verified against @george43g/gmail-mcp
 * 2.0.0: nextPageToken lives only in structuredContent; the thread
 * transcript never emits messageIds), so the JSON-shape guidance would
 * instruct impossible maneuvers. Text-mode moves are: smaller pages,
 * narrower queries, and metadata-only re-runs.
 */
export function emailFetchTextGuidance(semantics: EmailFetchSemantics): string {
  if (semantics.singleItem === true) {
    // Same as JSON: read_email has no intra-body paging in either shape.
    return emailFetchGuidance(semantics);
  }
  if (semantics.pagination !== undefined) {
    const pagination = semantics.pagination;
    return (
      `This text result carries no page token. Re-run ${semantics.toolName} with a small ` +
      `${pagination.maxResultsParam} (e.g. 10) and narrow the search query to find specific emails. ` +
      `Do not raise ${pagination.maxResultsParam} to pull everything at once.`
    );
  }
  if (semantics.narrowing !== undefined) {
    const narrowing = semantics.narrowing;
    return (
      `Re-run ${semantics.toolName} with ${narrowing.param}="${narrowing.value}" for headers without ` +
      `bodies. The text transcript contains no message IDs, so individual-message ` +
      `fetching requires an ID from elsewhere.`
    );
  }
  // Nested collections: same as JSON shape (no pageToken in either).
  return emailFetchGuidance(semantics);
}

// ---------------------------------------------------------------------------
// Metadata-first email summarization.
// ---------------------------------------------------------------------------

const BODY_FIELD_NAMES: ReadonlySet<string> = new Set(['body', 'bodytext', 'bodyhtml']);
const MAX_HEADER_CHARS = 200;
const MAX_KEY_CHARS = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Strips ASCII control characters without a control-char regex (lint-clean). */
export function stripControlCharacters(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      continue;
    }
    out += char;
  }
  return out;
}

function sanitizeHeader(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const stripped = stripControlCharacters(value);
  return stripped.length > MAX_HEADER_CHARS ? `${stripped.slice(0, MAX_HEADER_CHARS)}…` : stripped;
}

function sanitizeKey(key: string): string {
  const stripped = stripControlCharacters(key);
  return stripped.length > MAX_KEY_CHARS ? stripped.slice(0, MAX_KEY_CHARS) : stripped;
}

// Recursively sanitizes a metadata value: strips control characters, truncates
// long strings, and drops body-bearing fields (they are what blew the budget).
function sanitizeMetadata(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeHeader(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeMetadata(item));
  }
  if (isRecord(value)) {
    return sanitizeRecord(value);
  }
  return value;
}

/** Record-typed wrapper so callers with an already-narrowed entry need no cast. */
function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [rawKey, entry] of Object.entries(value)) {
    if (BODY_FIELD_NAMES.has(rawKey.toLowerCase())) {
      continue;
    }
    // Keys are untrusted too: strip control characters and bound their length
    // so a hostile key cannot bloat the summary.
    cleaned[sanitizeKey(rawKey)] = sanitizeMetadata(entry);
  }
  return cleaned;
}

function firstNumberField(root: Record<string, unknown>, fields: readonly string[]): number | null {
  for (const field of fields) {
    const value = root[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return null;
}

function nonEmptyStringField(root: Record<string, unknown>, field: string): string | undefined {
  const value = root[field];
  return isNonEmptyString(value) ? value : undefined;
}

/**
 * Exact valid continuation call for a recognized email result, naming a
 * real id taken from the result. Prefers native pagination with the actual
 * token, then same-tool narrowing, then an exact fetch call with an example
 * id. Null only for single-item results with no intra-item paging.
 */
function continuationFor(input: {
  semantics: EmailFetchSemantics;
  root: Record<string, unknown>;
  firstId: string | undefined;
  firstNestedId: string | undefined;
  /** Number of items in this page. When it exceeds the summary emission cap,
   * the token-jump would orphan the unshown middle — restart from the start
   * with a small page instead. */
  itemCount: number;
}): string | null {
  const { semantics, root, firstId, firstNestedId, itemCount } = input;
  if (semantics.singleItem === true) {
    return null;
  }
  const pagination = semantics.pagination;
  if (pagination !== undefined) {
    // If this page holds more items than the summary can show, the server
    // token would resume after the whole page — orphaning the unshown middle.
    // Restart pagination from the beginning with a small page size instead;
    // re-covering the shown prefix is harmless, skipping the middle is not.
    if (itemCount > MAX_SUMMARY_ITEMS) {
      return (
        `This page held ${String(itemCount)} items but only the first ${String(MAX_SUMMARY_ITEMS)} ` +
        `could be shown. Re-run ${semantics.toolName} with ${pagination.maxResultsParam}=10 ` +
        `(no ${pagination.pageTokenParam}) to page through from the start in small pages. ` +
        `Do not use the next-page token from this result — it would skip the unshown items.`
      );
    }
    const token = nonEmptyStringField(root, pagination.nextTokenField);
    if (token !== undefined) {
      const safeToken = stripControlCharacters(token).slice(0, 256);
      return (
        `Re-run ${semantics.toolName} with ${pagination.maxResultsParam}=10 and ` +
        `${pagination.pageTokenParam}="${safeToken}" to fetch the next page.`
      );
    }
  }
  const narrowing = semantics.narrowing;
  if (narrowing !== undefined) {
    const id = nonEmptyStringField(root, narrowing.idEchoField);
    if (id !== undefined) {
      return (
        `Re-run ${semantics.toolName}(${narrowing.idParam}="${id}", ` +
        `${narrowing.param}="${narrowing.value}") for headers without bodies; ` +
        `fetch any full message with ${semantics.fetchTool}(${semantics.fetchIdParam}).`
      );
    }
  }
  const exampleId = firstNestedId ?? firstId;
  if (exampleId !== undefined) {
    return `Fetch any full message with ${semantics.fetchTool}(${semantics.fetchIdParam}="${exampleId}").`;
  }
  return null;
}

/**
 * Metadata-first summary for an oversized email-tool result. The sanitized
 * (body-stripped) result is handed to the generic bounded summarizer, so all
 * accounting stays in one canonical shape. Returns undefined when the tool is
 * out of scope, the content does not parse, or id coverage is incomplete —
 * the caller then falls back to the generic summary or the panic path, and
 * logs a fingerprint instead of discarding data silently.
 */
export function summarizeEmailResult(input: {
  content: string;
  semantics: EmailFetchSemantics;
}): OversizedResultSummary | undefined {
  const { content, semantics } = input;
  // UTF-8 bytes, like the generic path: string length is UTF-16 code units.
  const totalBytes = new TextEncoder().encode(content).length;
  if (totalBytes > OVERSIZED_RESULT_PARSE_MAX_BYTES) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  // Any transform bug (e.g. RangeError from deeply nested hostile input in the
  // sanitizer) fails closed to the generic path, never into a crashed turn.
  try {
    if (semantics.singleItem === true) {
      return summarizeSingleEmail({ root: parsed, semantics, totalBytes });
    }
    return summarizeEmailCollection({ root: parsed, semantics, totalBytes });
  } catch {
    return undefined;
  }
}

/**
 * Bounded text fallback for a recognized email tool whose result is not
 * JSON-parseable. The Gmail MCP server renders human-readable text (not
 * JSON) for read_email, search_emails, and get_thread; when the
 * protocol-level structuredContent field is absent, that text is the whole
 * result, and both JSON summarizers fail on it — without this fallback the
 * caller takes the panic path and the model sees nothing, then retries the
 * same call in a loop.
 *
 * Note: list_inbox_threads and get_inbox_with_threads render their text as
 * JSON.stringify output (leading `{`), so they are handled by the JSON path,
 * not this fallback. This fallback fires only for the three tools with
 * genuinely human-readable text shapes.
 *
 * Uses the same 4,000-char excerpt budget as the JSON single-email path.
 * Returns undefined when the content looks like JSON (leading `{` or `[`):
 * the generic JSON summarizer owns that case, and malformed JSON fails
 * closed to the panic path rather than a guessed excerpt. Also returns
 * undefined for empty content and for content over the 1 MiB module input
 * ceiling. Never throws.
 */
export function summarizeEmailTextResult(input: {
  content: string;
  semantics: EmailFetchSemantics;
}): OversizedResultSummary | undefined {
  const { content, semantics } = input;
  // Email servers are trusted to produce human-readable text (verified
  // against @george43g/gmail-mcp), so no isTextLike gate — the shared
  // builder enforces the JSON-shape, empty, and ceiling guards.
  return buildBoundedTextSummary({
    content,
    statementPrefix: 'The full result',
    guidance: emailFetchTextGuidance(semantics),
    totalCount: semantics.singleItem === true ? 1 : null,
    itemsSeen: semantics.singleItem === true ? 1 : 0,
    requireTextLike: false,
  });
}

function summarizeSingleEmail(input: {
  root: Record<string, unknown>;
  semantics: EmailFetchSemantics;
  totalBytes: number;
}): OversizedResultSummary | undefined {
  const { root, semantics, totalBytes } = input;
  const messageId = root[semantics.idField];
  if (!isNonEmptyString(messageId)) {
    return undefined;
  }
  const body = root['bodyText'] ?? root['body'];
  const bodyText = typeof body === 'string' ? body : '';
  const excerpt = bodyText.slice(0, SINGLE_BODY_EXCERPT_CHARS);
  const cleanCut = excerpt.length < bodyText.length ? excerpt.slice(0, Math.max(0, excerpt.lastIndexOf('\n'))) : excerpt;
  const shown = cleanCut.length > 0 ? cleanCut.length : excerpt.length;
  return {
    result_kind: 'text',
    total_bytes: totalBytes,
    total_count: 1,
    items_seen: 1,
    items_extracted: 0,
    unseen_count: 1,
    screened_out: 0,
    truncated: true,
    unseen_statement:
      `The full body (${bodyText.length.toLocaleString('en-US')} characters) exceeded the output threshold. ` +
      `Showing the first ${shown.toLocaleString('en-US')} characters; the rest was not seen. ` +
      `${semantics.toolName} has no intra-body paging, so the remainder is not fetchable.`,
    next: null,
    chars_total: bodyText.length,
    chars_shown: shown,
    text_excerpt: cleanCut.length > 0 ? cleanCut : excerpt,
    envelope: {
      host_transform: 'email_metadata_first',
      source_tool: semantics.toolName,
      seen: 'metadata_and_body_excerpt',
      honesty_note:
        `The Agent has seen the metadata below and the first ${String(shown)} characters of the ` +
        `message body (${String(bodyText.length)} total). The rest of the body was stripped by the host ` +
        'and was not seen. Do not present unseen body content as if it came from this result.',
      message_id: sanitizeHeader(messageId),
      subject: sanitizeHeader(root['subject']),
      from: sanitizeHeader(root['from']),
      date: sanitizeHeader(root['date']),
    },
  };
}

function summarizeEmailCollection(input: {
  root: Record<string, unknown>;
  semantics: EmailFetchSemantics;
  totalBytes: number;
}): OversizedResultSummary | undefined {
  const { root, semantics, totalBytes } = input;
  let items: unknown[] | undefined;
  for (const field of semantics.envelopeFields) {
    const candidate = root[field];
    if (Array.isArray(candidate)) {
      items = candidate;
      break;
    }
  }
  if (items === undefined) {
    return undefined;
  }
  const sanitized: Record<string, unknown>[] = [];
  let firstId: string | undefined;
  let firstNestedId: string | undefined;
  for (const entry of items) {
    // An item without a usable re-fetch id cannot be re-fetched; fail closed.
    if (!isRecord(entry)) {
      return undefined;
    }
    const rawId = entry[semantics.idField];
    if (!isNonEmptyString(rawId)) {
      return undefined;
    }
    firstId ??= rawId;
    if (semantics.nestedField !== undefined && semantics.nestedIdField !== undefined) {
      const nested = entry[semantics.nestedField];
      if (nested !== undefined) {
        if (!Array.isArray(nested)) {
          return undefined;
        }
        for (const child of nested) {
          if (!isRecord(child)) {
            return undefined;
          }
          const rawChildId = child[semantics.nestedIdField];
          if (!isNonEmptyString(rawChildId)) {
            return undefined;
          }
          firstNestedId ??= rawChildId;
        }
      }
    }
    sanitized.push(sanitizeRecord(entry));
  }

  // The total is whatever the source reported: an estimate stays marked
  // approximate, and a missing total is "total unknown", never items.length.
  const reportedTotal = firstNumberField(root, semantics.totalFields);
  const totalDisplay =
    reportedTotal !== null && semantics.totalApproximate
      ? `~${reportedTotal.toLocaleString('en-US')} items (server estimate)`
      : undefined;
  const next = continuationFor({ semantics, root, firstId, firstNestedId, itemCount: sanitized.length });

  // The sanitized collection goes through the generic bounded summarizer so
  // byte/item budgets and the canonical summary shape stay in one place.
  // Sanitized metadata is strictly smaller than the input, so re-serializing
  // cannot breach the parse ceiling the input already satisfied. The reported
  // byte count stays the original result's: the model must know how much was
  // stripped, not just how much metadata survived.
  const summary = summarizeOversizedResult({
    content: JSON.stringify({ items: sanitized }),
    collectionField: 'items',
    totalCount: reportedTotal ?? undefined,
    totalDisplay,
    next,
    totalBytes,
  });
  if (summary === undefined) {
    return undefined;
  }
  return {
    ...summary,
    envelope: {
      host_transform: 'email_metadata_first',
      source_tool: semantics.toolName,
      seen: 'metadata_only',
      honesty_note:
        'The Agent has seen only the metadata below (ids, headers, counts). Message bodies were ' +
        'stripped by the host and were not seen. Do not present body content as if it came from this result.',
    },
  };
}

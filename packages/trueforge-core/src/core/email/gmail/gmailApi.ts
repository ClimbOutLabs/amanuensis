/** Gmail's REST API, called directly with the user's own login. No adapter process, no container. */
import { z } from 'zod';
import type { GoogleAccessTokens } from '../../google/GoogleAccessTokens';
import { fetchGoogle } from '../../google/oauth';
import {
  AttachmentBodySchema,
  DraftListSchema,
  DraftSchema,
  GmailMessageSchema,
  GmailThreadSchema,
  ThreadListSchema,
  type GmailDraft,
  type GmailMessage,
  type GmailThread,
} from './gmailWire';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Detail calls in flight at once when a list needs one per row. Gmail rate-limits per user, so this stays low. */
const DETAIL_CONCURRENCY = 4;

/** Most times a request is tried when Gmail says it is busy. */
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const MAX_RETRY_WAIT_MS = 10_000;

/** Gmail refused or failed a request. The message is safe to show; it never carries mail content. */
export class GmailApiError extends Error {
  readonly status: number;
  /** True when the request may have taken effect: a server error or a lost connection after it went out. */
  readonly outcomeUnknown: boolean;

  constructor(input: { status: number; message: string; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'GmailApiError';
    this.status = input.status;
    this.outcomeUnknown = input.status >= 500;
  }
}

const ErrorBodySchema = z.object({
  error: z.object({
    status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/** Why Google refused a request, from the reason it names in the error body. */
function reasonOf(body: unknown): string {
  const parsed = ErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    return '';
  }
  const { errors, details } = parsed.data.error;
  return errors?.[0]?.reason ?? details?.[0]?.reason ?? '';
}

const BUSY_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'backendError']);
const API_OFF_REASONS = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);

const BUSY_MESSAGE = 'Gmail is busy right now. Try again in a minute.';
const TOO_LARGE_MESSAGE =
  'Gmail sent back more than Aman will read at once. Ask for fewer results, or read one message.';

/** Largest Gmail response read into memory; bigger ones are refused unread. Ordinary mail is far smaller. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** A 25 MB file arrives base64-encoded, about a third larger. */
const MAX_ATTACHMENT_RESPONSE_BYTES = 40 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * The JSON body of a response, read without ever holding more than the limit: a Content-Length over it is
 * refused unread, and a body that has none (or lies) is counted as it streams in.
 */
async function readJsonCapped(input: {
  response: Response;
  maxBytes: number;
}): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const declared = Number(input.response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > input.maxBytes) {
    await input.response.body?.cancel();
    return { ok: false };
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = input.response.body?.getReader();
  if (reader === undefined) {
    return { ok: true, value: undefined };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > input.maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: true, value: undefined };
  }
}

function describeFailure(input: { status: number; reason: string }): string {
  if (input.status === 429 || BUSY_REASONS.has(input.reason)) {
    return BUSY_MESSAGE;
  }
  if (API_OFF_REASONS.has(input.reason)) {
    return "The Gmail API isn't turned on in your Google project. Open Settings, Connectors, Google, follow step 2, then try again.";
  }
  if (SCOPE_REASONS.has(input.reason)) {
    return "Google hasn't given Aman permission for that. Open Settings, Connectors, Google, choose Reconnect and allow every box.";
  }
  switch (input.status) {
    case 400:
      return 'Gmail did not accept that request.';
    case 403:
      return "Google didn't allow that. Open Settings, Connectors, Google and check what is turned on.";
    case 404:
      return 'Gmail has no such message, thread or draft.';
    default:
      return input.status >= 500
        ? BUSY_MESSAGE
        : `Gmail could not be reached (HTTP ${String(input.status)}). Try again in a minute.`;
  }
}

const RATE_LIMIT_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded']);

/**
 * Whether trying a request again is safe. A request that creates or sends is never repeated after a failure
 * that may have happened after Gmail acted (a server error, a timeout); only a refusal for going too fast,
 * which Gmail answers before doing anything, is retried.
 */
function isRetryable(input: { status: number; reason: string; method: GmailRequest['method'] }): boolean {
  if (input.method === 'POST') {
    return input.status === 429 || RATE_LIMIT_REASONS.has(input.reason);
  }
  return input.status === 429 || input.status >= 500 || BUSY_REASONS.has(input.reason);
}

function retryDelayMs(input: { response: Response; attempt: number }): number {
  const seconds = Number(input.response.headers.get('retry-after'));
  const asked = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : BACKOFF_BASE_MS * 2 ** input.attempt;
  return Math.min(asked, MAX_RETRY_WAIT_MS);
}

type Query = Record<string, string | number | string[] | undefined>;

interface GmailRequest {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  query: Query | undefined;
  body: unknown;
  /** Said when the outcome is unknown (no answer, or a server error) for a request that creates or sends. */
  unknownOutcome?: string;
  /** Largest response read; the default fits any thread or list. */
  maxResponseBytes?: number;
}

/** A malformed response, even one nested deep enough to overflow the parser, is a failure and not a crash. */
function safeParse<T>(input: { schema: z.ZodType<T>; value: unknown }) {
  try {
    return input.schema.safeParse(input.value);
  } catch (error) {
    return { success: false as const, error };
  }
}

interface ThreadList {
  threadIds: string[];
  nextPageToken: string | undefined;
  resultSizeEstimate: number;
}

interface DraftList {
  draftIds: string[];
  nextPageToken: string | undefined;
}

export class GmailApi {
  readonly #tokens: GoogleAccessTokens;
  readonly #fetchImpl: typeof fetch;

  readonly #sleep: (ms: number) => Promise<void>;

  constructor(input: {
    tokens: GoogleAccessTokens;
    fetchImpl: typeof fetch | undefined;
    /** Replaceable so tests do not wait. */
    sleep: ((ms: number) => Promise<void>) | undefined;
  }) {
    this.#tokens = input.tokens;
    this.#fetchImpl = input.fetchImpl ?? fetch;
    this.#sleep = input.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async #send(input: GmailRequest): Promise<unknown> {
    const url = new URL(`${GMAIL_BASE}${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, item);
        }
      } else if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const access = await this.#tokens.get();
      let response: Response;
      try {
        response = await fetchGoogle({
          fetchImpl: this.#fetchImpl,
          url: url.toString(),
          init: {
            method: input.method,
            headers: {
              Authorization: `Bearer ${access.access_token}`,
              ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          },
        });
      } catch (error) {
        throw new GmailApiError({ status: 503, message: input.unknownOutcome ?? BUSY_MESSAGE, cause: error });
      }
      if (response.status === 401 && !refreshed) {
        // A cached token Google no longer honors: refresh once. A refresh Google refuses flips needs-reconnect.
        refreshed = true;
        this.#tokens.invalidate();
        continue;
      }
      if (response.ok) {
        let read: Awaited<ReturnType<typeof readJsonCapped>>;
        try {
          read = await readJsonCapped({ response, maxBytes: input.maxResponseBytes ?? MAX_RESPONSE_BYTES });
        } catch (error) {
          throw new GmailApiError({ status: 503, message: input.unknownOutcome ?? BUSY_MESSAGE, cause: error });
        }
        if (!read.ok) {
          throw new GmailApiError({ status: 502, message: input.unknownOutcome ?? TOO_LARGE_MESSAGE });
        }
        return read.value;
      }
      const errorBody = await readJsonCapped({ response, maxBytes: MAX_ERROR_BODY_BYTES }).catch(() => undefined);
      const reason = reasonOf(errorBody?.ok === true ? errorBody.value : undefined);
      const failure = { status: response.status, reason, method: input.method };
      if (attempt + 1 < MAX_ATTEMPTS && isRetryable(failure)) {
        await this.#sleep(retryDelayMs({ response, attempt }));
        continue;
      }
      throw new GmailApiError({
        status: response.status,
        message:
          input.unknownOutcome !== undefined && response.status >= 500
            ? input.unknownOutcome
            : describeFailure({ status: response.status, reason }),
      });
    }
  }

  async #parsed<T>(schema: z.ZodType<T>, request: GmailRequest): Promise<T> {
    const body = safeParse({ schema, value: await this.#send(request) });
    if (!body.success) {
      throw new GmailApiError({
        status: 502,
        message: request.unknownOutcome ?? 'Gmail returned a response Aman could not read.',
        cause: body.error,
      });
    }
    return body.data;
  }

  async listThreads(input: { query: string; maxResults: number; pageToken: string | undefined }): Promise<ThreadList> {
    const list = await this.#parsed(ThreadListSchema, {
      body: undefined,
      method: 'GET',
      path: '/threads',
      query: { q: input.query, maxResults: input.maxResults, pageToken: input.pageToken },
    });
    return {
      threadIds: (list.threads ?? []).map(thread => thread.id),
      nextPageToken: list.nextPageToken,
      resultSizeEstimate: list.resultSizeEstimate ?? (list.threads ?? []).length,
    };
  }

  /** Headers only, enough for a list row: sender, subject, date, labels. */
  async getThreadSummary(threadId: string): Promise<GmailThread> {
    return await this.#parsed(GmailThreadSchema, {
      body: undefined,
      method: 'GET',
      path: `/threads/${encodeURIComponent(threadId)}`,
      query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] },
    });
  }

  async getThread(input: { threadId: string; format: 'full' | 'metadata' }): Promise<GmailThread> {
    return await this.#parsed(GmailThreadSchema, {
      body: undefined,
      method: 'GET',
      path: `/threads/${encodeURIComponent(input.threadId)}`,
      query: { format: input.format },
    });
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    return await this.#parsed(GmailMessageSchema, {
      body: undefined,
      method: 'GET',
      path: `/messages/${encodeURIComponent(messageId)}`,
      query: { format: 'full' },
    });
  }

  /** The attachment's bytes, decoded. */
  async getAttachment(input: { messageId: string; attachmentId: string }): Promise<Buffer> {
    const body = await this.#parsed(AttachmentBodySchema, {
      query: undefined,
      body: undefined,
      method: 'GET',
      path: `/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
      maxResponseBytes: MAX_ATTACHMENT_RESPONSE_BYTES,
    });
    return Buffer.from((body.data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  async listDrafts(input: { maxResults: number; pageToken: string | undefined }): Promise<DraftList> {
    const list = await this.#parsed(DraftListSchema, {
      body: undefined,
      method: 'GET',
      path: '/drafts',
      query: { maxResults: input.maxResults, pageToken: input.pageToken },
    });
    return { draftIds: (list.drafts ?? []).map(draft => draft.id), nextPageToken: list.nextPageToken };
  }

  async getDraft(draftId: string): Promise<GmailDraft> {
    return await this.#parsed(DraftSchema, {
      body: undefined,
      method: 'GET',
      path: `/drafts/${encodeURIComponent(draftId)}`,
      query: { format: 'full' },
    });
  }

  async createDraft(input: { raw: string; threadId: string | undefined }): Promise<GmailDraft> {
    return await this.#parsed(DraftSchema, {
      query: undefined,
      method: 'POST',
      path: '/drafts',
      body: { message: { raw: input.raw, ...(input.threadId === undefined ? {} : { threadId: input.threadId }) } },
      unknownOutcome: 'The draft may have been saved. Check your Drafts folder before trying again.',
    });
  }

  async updateDraft(input: { draftId: string; raw: string; threadId: string | undefined }): Promise<GmailDraft> {
    return await this.#parsed(DraftSchema, {
      query: undefined,
      method: 'PUT',
      path: `/drafts/${encodeURIComponent(input.draftId)}`,
      body: {
        id: input.draftId,
        message: { raw: input.raw, ...(input.threadId === undefined ? {} : { threadId: input.threadId }) },
      },
    });
  }

  async sendDraft(draftId: string): Promise<GmailMessage> {
    return await this.#parsed(GmailMessageSchema, {
      query: undefined,
      method: 'POST',
      path: '/drafts/send',
      body: { id: draftId },
      unknownOutcome: 'The send may have gone through. Check your Sent folder before trying again.',
    });
  }
}

/** How long a list call may spend fetching its rows before it returns what it has. */
export const LIST_DEADLINE_MS = 60_000;

/**
 * Runs the work for each item with a few in flight at once, keeping the order. An item Gmail no longer has
 * (a thread deleted while the list was read) is left out instead of failing the whole list; any other
 * failure still fails it. Once the deadline passes it stops waiting and returns the rows it has, saying how
 * many items it never reached.
 */
export async function mapSkippingMissing<T, R>(input: {
  items: readonly T[];
  work: (item: T) => Promise<R>;
  deadlineMs: number;
}): Promise<{ results: R[]; notReached: number }> {
  const results: R[] = [];
  const startedAt = Date.now();
  for (let start = 0; start < input.items.length; start += DETAIL_CONCURRENCY) {
    const remaining = input.deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      return { results, notReached: input.items.length - start };
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, remaining);
    });
    const batch = Promise.all(
      input.items.slice(start, start + DETAIL_CONCURRENCY).map(async item => {
        try {
          return { found: true as const, value: await input.work(item) };
        } catch (error) {
          if (error instanceof GmailApiError && error.status === 404) {
            return { found: false as const };
          }
          throw error;
        }
      }),
    );
    const outcome = await Promise.race([batch, timedOut]).finally(() => {
      clearTimeout(timer);
    });
    if (outcome === 'timeout') {
      // The requests still in flight finish or fail on their own; their results are not used.
      batch.catch(() => undefined);
      return { results, notReached: input.items.length - start };
    }
    for (const entry of outcome) {
      if (entry.found) {
        results.push(entry.value);
      }
    }
  }
  return { results, notReached: 0 };
}

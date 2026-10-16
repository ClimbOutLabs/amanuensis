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

  constructor(input: { status: number; message: string; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'GmailApiError';
    this.status = input.status;
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

function isRetryable(input: { status: number; reason: string }): boolean {
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
}

export interface ThreadList {
  threadIds: string[];
  nextPageToken: string | undefined;
  resultSizeEstimate: number;
}

export interface DraftList {
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
        throw new GmailApiError({ status: 503, message: BUSY_MESSAGE, cause: error });
      }
      if (response.status === 401 && !refreshed) {
        // A cached token Google no longer honors: refresh once. A refresh Google refuses flips needs-reconnect.
        refreshed = true;
        this.#tokens.invalidate();
        continue;
      }
      if (response.ok) {
        return await response.json().catch(() => undefined);
      }
      const reason = reasonOf(await response.json().catch(() => undefined));
      if (attempt + 1 < MAX_ATTEMPTS && isRetryable({ status: response.status, reason })) {
        await this.#sleep(retryDelayMs({ response, attempt }));
        continue;
      }
      throw new GmailApiError({
        status: response.status,
        message: describeFailure({ status: response.status, reason }),
      });
    }
  }

  async #parsed<T>(schema: z.ZodType<T>, request: GmailRequest): Promise<T> {
    const body = schema.safeParse(await this.#send(request));
    if (!body.success) {
      throw new GmailApiError({
        status: 502,
        message: 'Gmail returned a response Aman could not read.',
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
    });
  }
}

/**
 * Runs the work for each item with a few in flight at once, keeping the order. An item Gmail no longer has
 * (a thread deleted while the list was read) is left out instead of failing the whole list; any other
 * failure still fails it.
 */
export async function mapSkippingMissing<T, R>(input: {
  items: readonly T[];
  work: (item: T) => Promise<R>;
}): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < input.items.length; start += DETAIL_CONCURRENCY) {
    const batch = await Promise.all(
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
    for (const entry of batch) {
      if (entry.found) {
        results.push(entry.value);
      }
    }
  }
  return results;
}

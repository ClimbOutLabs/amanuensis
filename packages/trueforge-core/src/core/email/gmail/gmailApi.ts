/** Gmail's REST API, called directly with the user's own login. No adapter process, no container. */
import { z } from 'zod';
import type { GoogleAccessTokens } from '../../google/GoogleAccessTokens';
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

/** Detail calls in flight at once when a list needs one per row. */
const DETAIL_CONCURRENCY = 8;

/** Gmail refused or failed a request. The message is safe to show; it never carries mail content. */
export class GmailApiError extends Error {
  readonly status: number;

  constructor(input: { status: number; message: string; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'GmailApiError';
    this.status = input.status;
  }
}

function describeStatus(status: number): string {
  switch (status) {
    case 400:
      return 'Gmail did not accept that request.';
    case 403:
      return 'Google has not allowed Aman to do that. Open Settings, Connectors, Google and check what is turned on.';
    case 404:
      return 'Gmail has no such message, thread or draft.';
    case 429:
      return 'Gmail is rate limiting requests. Try again in a minute.';
    default:
      return `Gmail could not be reached (HTTP ${String(status)}).`;
  }
}

type Query = Record<string, string | number | string[] | undefined>;

interface GmailRequest {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  query?: Query | undefined;
  body?: unknown;
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

  constructor(input: { tokens: GoogleAccessTokens; fetchImpl?: typeof fetch | undefined }) {
    this.#tokens = input.tokens;
    this.#fetchImpl = input.fetchImpl ?? fetch;
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
    for (let attempt = 0; ; attempt += 1) {
      const access = await this.#tokens.get();
      const response = await this.#fetchImpl(url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${access.access_token}`,
          ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      if (response.status === 401 && attempt === 0) {
        // A cached token Google no longer honors: refresh once. A refresh Google refuses flips needs-reconnect.
        this.#tokens.invalidate();
        continue;
      }
      if (!response.ok) {
        throw new GmailApiError({ status: response.status, message: describeStatus(response.status) });
      }
      return await response.json().catch(() => undefined);
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
      method: 'GET',
      path: `/threads/${encodeURIComponent(threadId)}`,
      query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] },
    });
  }

  async getThread(input: { threadId: string; format: 'full' | 'metadata' }): Promise<GmailThread> {
    return await this.#parsed(GmailThreadSchema, {
      method: 'GET',
      path: `/threads/${encodeURIComponent(input.threadId)}`,
      query: { format: input.format },
    });
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    return await this.#parsed(GmailMessageSchema, {
      method: 'GET',
      path: `/messages/${encodeURIComponent(messageId)}`,
      query: { format: 'full' },
    });
  }

  /** The attachment's bytes, decoded. */
  async getAttachment(input: { messageId: string; attachmentId: string }): Promise<Buffer> {
    const body = await this.#parsed(AttachmentBodySchema, {
      method: 'GET',
      path: `/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
    });
    return Buffer.from((body.data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  async listDrafts(input: { maxResults: number; pageToken: string | undefined }): Promise<DraftList> {
    const list = await this.#parsed(DraftListSchema, {
      method: 'GET',
      path: '/drafts',
      query: { maxResults: input.maxResults, pageToken: input.pageToken },
    });
    return { draftIds: (list.drafts ?? []).map(draft => draft.id), nextPageToken: list.nextPageToken };
  }

  async getDraft(draftId: string): Promise<GmailDraft> {
    return await this.#parsed(DraftSchema, {
      method: 'GET',
      path: `/drafts/${encodeURIComponent(draftId)}`,
      query: { format: 'full' },
    });
  }

  async createDraft(input: { raw: string; threadId: string | undefined }): Promise<GmailDraft> {
    return await this.#parsed(DraftSchema, {
      method: 'POST',
      path: '/drafts',
      body: { message: { raw: input.raw, ...(input.threadId === undefined ? {} : { threadId: input.threadId }) } },
    });
  }

  async updateDraft(input: { draftId: string; raw: string; threadId: string | undefined }): Promise<GmailDraft> {
    return await this.#parsed(DraftSchema, {
      method: 'PUT',
      path: `/drafts/${encodeURIComponent(input.draftId)}`,
      body: {
        id: input.draftId,
        message: { raw: input.raw, ...(input.threadId === undefined ? {} : { threadId: input.threadId }) },
      },
    });
  }

  async sendDraft(draftId: string): Promise<GmailMessage> {
    return await this.#parsed(GmailMessageSchema, { method: 'POST', path: '/drafts/send', body: { id: draftId } });
  }
}

/** Runs the work for each item with a few in flight at once, keeping the order of the items. */
export async function mapWithConcurrency<T, R>(input: {
  items: readonly T[];
  work: (item: T) => Promise<R>;
}): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < input.items.length; start += DETAIL_CONCURRENCY) {
    results.push(...(await Promise.all(input.items.slice(start, start + DETAIL_CONCURRENCY).map(input.work))));
  }
  return results;
}

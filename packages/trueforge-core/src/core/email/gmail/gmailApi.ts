/** Gmail's REST API, called directly with the user's own login. No adapter process, no container. */
import type { GoogleAccessTokens } from '../../google/GoogleAccessTokens';
import { GoogleApiError } from '../../google/errors';
import { GoogleRestClient, type GoogleRestProduct } from '../../google/restClient';
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

/** Detail calls in flight at once when a list needs one per row. Gmail rate-limits per user, so this stays low. */
const DETAIL_CONCURRENCY = 4;

/** A 25 MB file arrives base64-encoded, about a third larger. */
const MAX_ATTACHMENT_RESPONSE_BYTES = 40 * 1024 * 1024;

const GMAIL: GoogleRestProduct = {
  name: 'Gmail',
  baseUrl: 'https://gmail.googleapis.com/gmail/v1/users/me',
  apiOffMessage:
    "The Gmail API isn't turned on in your Google project. Open Settings, Connectors, Google, follow step 2, then try again.",
  scopeMessage:
    "Google hasn't given Aman permission for that. Open Settings, Connectors, Google, choose Reconnect and allow every box.",
  notFoundMessage: 'Gmail has no such message, thread or draft.',
  tooLargeMessage: 'Gmail sent back more than Aman will read at once. Ask for fewer results, or read one message.',
};

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
  readonly #rest: GoogleRestClient;

  constructor(input: {
    tokens: GoogleAccessTokens;
    fetchImpl: typeof fetch | undefined;
    /** Replaceable so tests do not wait. */
    sleep: ((ms: number) => Promise<void>) | undefined;
  }) {
    this.#rest = new GoogleRestClient({
      product: GMAIL,
      tokens: input.tokens,
      fetchImpl: input.fetchImpl,
      sleep: input.sleep,
    });
  }

  async listThreads(input: { query: string; maxResults: number; pageToken: string | undefined }): Promise<ThreadList> {
    const list = await this.#rest.parsed(ThreadListSchema, {
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
    return await this.#rest.parsed(GmailThreadSchema, {
      body: undefined,
      method: 'GET',
      path: `/threads/${encodeURIComponent(threadId)}`,
      query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] },
    });
  }

  async getThread(input: { threadId: string; format: 'full' | 'metadata' }): Promise<GmailThread> {
    return await this.#rest.parsed(GmailThreadSchema, {
      body: undefined,
      method: 'GET',
      path: `/threads/${encodeURIComponent(input.threadId)}`,
      query: { format: input.format },
    });
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    return await this.#rest.parsed(GmailMessageSchema, {
      body: undefined,
      method: 'GET',
      path: `/messages/${encodeURIComponent(messageId)}`,
      query: { format: 'full' },
    });
  }

  /** The attachment's bytes, decoded. */
  async getAttachment(input: { messageId: string; attachmentId: string }): Promise<Buffer> {
    const body = await this.#rest.parsed(AttachmentBodySchema, {
      query: undefined,
      body: undefined,
      method: 'GET',
      path: `/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
      maxResponseBytes: MAX_ATTACHMENT_RESPONSE_BYTES,
    });
    return Buffer.from((body.data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  async listDrafts(input: { maxResults: number; pageToken: string | undefined }): Promise<DraftList> {
    const list = await this.#rest.parsed(DraftListSchema, {
      body: undefined,
      method: 'GET',
      path: '/drafts',
      query: { maxResults: input.maxResults, pageToken: input.pageToken },
    });
    return { draftIds: (list.drafts ?? []).map(draft => draft.id), nextPageToken: list.nextPageToken };
  }

  async getDraft(draftId: string): Promise<GmailDraft> {
    return await this.#rest.parsed(DraftSchema, {
      body: undefined,
      method: 'GET',
      path: `/drafts/${encodeURIComponent(draftId)}`,
      query: { format: 'full' },
    });
  }

  async createDraft(input: { raw: string; threadId: string | undefined }): Promise<GmailDraft> {
    return await this.#rest.parsed(DraftSchema, {
      query: undefined,
      method: 'POST',
      path: '/drafts',
      body: { message: { raw: input.raw, ...(input.threadId === undefined ? {} : { threadId: input.threadId }) } },
      unknownOutcome: 'The draft may have been saved. Check your Drafts folder before trying again.',
    });
  }

  async updateDraft(input: { draftId: string; raw: string; threadId: string | undefined }): Promise<GmailDraft> {
    return await this.#rest.parsed(DraftSchema, {
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
    return await this.#rest.parsed(GmailMessageSchema, {
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
          if (error instanceof GoogleApiError && error.status === 404) {
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

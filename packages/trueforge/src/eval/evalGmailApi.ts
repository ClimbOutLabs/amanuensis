/**
 * The Gmail calls answered from the eval inbox fixture. Nothing here reaches the network: drafts live in
 * memory and sending is refused, so an eval run can never send mail.
 */
import type { GmailApiPort } from '@truefoundry/trueforge-core/core/email/gmail/gmailApi';
import type { GmailDraft, GmailMessage, GmailThread } from '@truefoundry/trueforge-core/core/email/gmail/gmailWire';

import { EvalFixtureError } from './evalFixtureError';
import type { InboxFixture } from './fixtures';

function notFound(): EvalFixtureError {
  return new EvalFixtureError('Gmail has no such message, thread or draft.');
}

interface StoredDraft {
  id: string;
  threadId: string;
  raw: string;
}

function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function fromBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Headers from a raw RFC 822 draft: the lines before the first blank line, folded lines joined. */
function parseRawHeaders(raw: string): { headers: { name: string; value: string }[]; body: string } {
  const [headerBlock = '', ...bodyParts] = fromBase64Url(raw).split(/\r?\n\r?\n/);
  const headers: { name: string; value: string }[] = [];
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && headers.length > 0) {
      const last = headers[headers.length - 1];
      if (last !== undefined) {
        last.value = `${last.value} ${line.trim()}`;
      }
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
    }
  }
  return { headers, body: bodyParts.join('\n\n') };
}

export class EvalGmailApi implements GmailApiPort {
  readonly #threads: GmailThread[];
  readonly #drafts = new Map<string, StoredDraft>();
  #draftCounter = 0;

  constructor(input: { inbox: InboxFixture }) {
    this.#threads = input.inbox.threads.map(thread => ({
      id: thread.id,
      messages: thread.messages.map((message, index) => {
        const messageId = `${thread.id}-message-${String(index + 1)}`;
        const headers = [
          { name: 'From', value: message.from },
          ...(message.to === undefined ? [] : [{ name: 'To', value: message.to }]),
          { name: 'Subject', value: message.subject ?? thread.subject },
          { name: 'Date', value: message.sent },
        ];
        return {
          id: messageId,
          threadId: thread.id,
          labelIds: ['INBOX'],
          snippet: message.body.slice(0, 120),
          payload: {
            mimeType: 'text/plain',
            headers,
            body: { size: Buffer.byteLength(message.body, 'utf8'), data: toBase64Url(message.body) },
          },
        };
      }),
    }));
  }

  /** Each query term not written as a `key:value` operator must appear in the thread. An empty query matches all. */
  listThreads(input: { query: string; maxResults: number; pageToken: string | undefined }) {
    const terms = input.query
      .toLowerCase()
      .split(/\s+/)
      .filter(term => term !== '' && !term.includes(':'));
    const matches = this.#threads.filter(thread => {
      const text = JSON.stringify(thread).toLowerCase();
      return terms.every(term => text.includes(term));
    });
    const threadIds = matches.slice(0, input.maxResults).map(thread => thread.id);
    return Promise.resolve({ threadIds, nextPageToken: undefined, resultSizeEstimate: matches.length });
  }

  getThreadSummary(threadId: string): Promise<GmailThread> {
    return this.#metadataThread(threadId);
  }

  getThreadReplyHeaders(threadId: string): Promise<GmailThread> {
    return this.#metadataThread(threadId);
  }

  getThread(input: { threadId: string; format: 'full' | 'metadata' }): Promise<GmailThread> {
    return input.format === 'metadata' ? this.#metadataThread(input.threadId) : this.#fullThread(input.threadId);
  }

  getMessage(messageId: string): Promise<GmailMessage> {
    for (const thread of this.#threads) {
      const message = thread.messages?.find(item => item.id === messageId);
      if (message !== undefined) {
        return Promise.resolve(message);
      }
    }
    return Promise.reject(notFound());
  }

  getAttachment(): Promise<Buffer> {
    return Promise.reject(new EvalFixtureError('The eval inbox has no attachments.'));
  }

  listDrafts(input: { maxResults: number; pageToken: string | undefined }) {
    const draftIds = [...this.#drafts.keys()].slice(0, input.maxResults);
    return Promise.resolve({ draftIds, nextPageToken: undefined });
  }

  getDraft(draftId: string): Promise<GmailDraft> {
    const draft = this.#drafts.get(draftId);
    if (draft === undefined) {
      return Promise.reject(notFound());
    }
    return Promise.resolve(this.#draftView(draft));
  }

  createDraft(input: { raw: string; threadId: string | undefined }): Promise<GmailDraft> {
    this.#draftCounter += 1;
    const id = `draft-eval-${String(this.#draftCounter)}`;
    const draft: StoredDraft = { id, threadId: input.threadId ?? `thread-eval-${id}`, raw: input.raw };
    this.#drafts.set(id, draft);
    return Promise.resolve(this.#draftView(draft));
  }

  updateDraft(input: { draftId: string; raw: string; threadId: string | undefined }): Promise<GmailDraft> {
    const existing = this.#drafts.get(input.draftId);
    if (existing === undefined) {
      return Promise.reject(notFound());
    }
    const draft: StoredDraft = { id: existing.id, threadId: input.threadId ?? existing.threadId, raw: input.raw };
    this.#drafts.set(draft.id, draft);
    return Promise.resolve(this.#draftView(draft));
  }

  sendDraft(draftId: string): Promise<GmailMessage> {
    return Promise.reject(
      new EvalFixtureError(`Eval instances do not send mail. Draft ${draftId} was kept, not sent.`),
    );
  }

  #findThread(threadId: string): GmailThread | undefined {
    return this.#threads.find(item => item.id === threadId);
  }

  #fullThread(threadId: string): Promise<GmailThread> {
    const thread = this.#findThread(threadId);
    return thread === undefined ? Promise.reject(notFound()) : Promise.resolve(thread);
  }

  /** What Gmail returns for a metadata read: headers only, no message text. */
  #metadataThread(threadId: string): Promise<GmailThread> {
    const thread = this.#findThread(threadId);
    if (thread === undefined) {
      return Promise.reject(notFound());
    }
    return Promise.resolve({
      id: thread.id,
      messages: (thread.messages ?? []).map(message => ({
        ...message,
        snippet: undefined,
        payload: { mimeType: message.payload?.mimeType, headers: message.payload?.headers, body: undefined },
      })),
    });
  }

  #draftView(draft: StoredDraft): GmailDraft {
    const { headers, body } = parseRawHeaders(draft.raw);
    return {
      id: draft.id,
      message: {
        id: `${draft.id}-message`,
        threadId: draft.threadId,
        labelIds: ['DRAFT'],
        payload: {
          mimeType: 'text/plain',
          headers,
          body: { size: Buffer.byteLength(body, 'utf8'), data: toBase64Url(body) },
        },
      },
    };
  }
}

import type { GmailMessage, GmailThread } from '../../../../src/core/email/gmail/gmailWire';

export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function message(input: {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  html?: string;
  labelIds?: string[];
  /** `id` is Gmail's attachmentId; `partId` defaults to the part's position; `inlineData` makes Gmail return the bytes in the part. */
  attachments?: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    partId?: string;
    inlineData?: string;
  }[];
  extraHeaders?: { name: string; value: string }[];
  internalDate?: string;
}): GmailMessage {
  return {
    id: input.id,
    threadId: input.threadId ?? `t-${input.id}`,
    labelIds: input.labelIds ?? ['INBOX'],
    snippet: input.body ?? '',
    internalDate: input.internalDate ?? '1760000000000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: input.from ?? 'Grace <grace@example.com>' },
        { name: 'To', value: input.to ?? 'ada@example.com' },
        { name: 'Subject', value: input.subject ?? 'Lease' },
        { name: 'Date', value: 'Wed, 15 Oct 2026 10:00:00 +0000' },
        ...(input.extraHeaders ?? []),
      ],
      parts: [
        ...(input.body === undefined ? [] : [{ mimeType: 'text/plain', body: { data: b64url(input.body) } }]),
        ...(input.html === undefined ? [] : [{ mimeType: 'text/html', body: { data: b64url(input.html) } }]),
        ...(input.attachments ?? []).map((file, index) => ({
          partId: file.partId ?? String(index + 2),
          mimeType: file.mimeType,
          filename: file.filename,
          body:
            file.inlineData === undefined
              ? { attachmentId: file.id, size: file.size }
              : { data: b64url(file.inlineData), size: file.size },
        })),
      ],
    },
  };
}

/** A draft shaped the way Aman saves one: a single text/plain part with its headers on the message. */
export function plainDraft(input: {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body: string;
  extraHeaders?: { name: string; value: string }[];
}): GmailMessage {
  const optional = (name: string, value: string | undefined) => (value === undefined ? [] : [{ name, value }]);
  return {
    id: input.id,
    threadId: input.threadId ?? `t-${input.id}`,
    labelIds: ['DRAFT'],
    snippet: input.body.slice(0, 80),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: input.from ?? 'Ada <ada@example.com>' },
        { name: 'To', value: input.to ?? 'Grace <grace@example.com>, lin@example.com' },
        ...optional('Cc', input.cc),
        ...optional('Bcc', input.bcc),
        { name: 'Subject', value: input.subject ?? 'Lease' },
        { name: 'Content-Type', value: 'text/plain; charset="UTF-8"' },
        ...(input.extraHeaders ?? []),
      ],
      body: { data: b64url(input.body), size: input.body.length },
    },
  };
}

export function thread(id: string, messages: GmailMessage[]): GmailThread {
  return { id, messages };
}

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
  attachments?: { id: string; filename: string; mimeType: string; size: number }[];
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
        ...(input.attachments ?? []).map(file => ({
          mimeType: file.mimeType,
          filename: file.filename,
          body: { attachmentId: file.id, size: file.size },
        })),
      ],
    },
  };
}

export function thread(id: string, messages: GmailMessage[]): GmailThread {
  return { id, messages };
}

import { assessDraft } from '../../../../src/core/email/gmail/draftAssessment';
import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import { b64url, message, plainDraft } from './fixtures';

const ACCOUNT = 'ada@example.com';
const MAX_SENDABLE_BODY_CHARS = 20_000;

const forSend = (mail: GmailMessage) => assessDraft({ message: mail, account: ACCOUNT, forSend: true });
const forEdit = (mail: GmailMessage) => assessDraft({ message: mail, account: ACCOUNT, forSend: false });

function reasonOf(result: ReturnType<typeof assessDraft>): string {
  return result.ok ? '' : result.reason;
}

describe('assessDraft', () => {
  it('describes everything a send delivers', () => {
    const result = forSend(
      plainDraft({
        id: 'd1',
        threadId: 't9',
        from: 'Ada Lovelace <ada@example.com>',
        to: 'Grace <grace@example.com>, lin@example.com',
        cc: 'sam@example.com',
        bcc: 'audit@example.com',
        subject: 'Lease',
        body: 'Thursday works.',
        extraHeaders: [
          { name: 'In-Reply-To', value: '<a@mail.example.com>' },
          { name: 'References', value: '<a@mail.example.com>' },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      draft: {
        to: [
          { name: 'Grace', address: 'grace@example.com' },
          { name: '', address: 'lin@example.com' },
        ],
        cc: [{ name: '', address: 'sam@example.com' }],
        bcc: [{ name: '', address: 'audit@example.com' }],
        subject: 'Lease',
        body: 'Thursday works.',
        threadId: 't9',
        inReplyTo: '<a@mail.example.com>',
        references: '<a@mail.example.com>',
        fromName: 'Ada Lovelace',
      },
    });
  });

  it('refuses a draft with an attachment, however it is named', () => {
    const withFile = message({
      id: 'd1',
      body: 'x',
      attachments: [{ id: 'a1', filename: 'lease.pdf', mimeType: 'application/pdf', size: 1 }],
    });
    expect(reasonOf(forSend(withFile))).toContain('attachments');
    expect(reasonOf(forEdit(withFile))).toContain('attachments');
  });

  it('refuses a draft that has an HTML version, since a send would not carry it', () => {
    expect(reasonOf(forSend(message({ id: 'd1', body: 'x', html: '<b>x</b>' })))).toContain('formatting');
  });

  it.each(['Reply-To', 'Sender', 'Disposition-Notification-To', 'X-Anything', 'Return-Path'])(
    'refuses a %s header, which could change who gets the message',
    name => {
      const mail = plainDraft({ id: 'd1', body: 'x', extraHeaders: [{ name, value: 'mallory@example.com' }] });
      expect(reasonOf(forSend(mail))).toContain('headers');
    },
  );

  it('refuses a header that appears twice', () => {
    const mail = plainDraft({ id: 'd1', body: 'x', extraHeaders: [{ name: 'Subject', value: 'Again' }] });
    expect(forSend(mail).ok).toBe(false);
  });

  it('refuses a draft from another address than the connected account', () => {
    const result = forSend(plainDraft({ id: 'd1', body: 'x', from: 'Mallory <mallory@example.com>' }));
    expect(reasonOf(result)).toContain('different address');
  });

  it('refuses a display name that only looks like the account address', () => {
    const result = forSend(plainDraft({ id: 'd1', body: 'x', from: '"ada@example.com" <mallory@example.com>' }));
    expect(result.ok).toBe(false);
  });

  it.each(['<a@mail.example.com> <b@mail.example.com>=?utf-8?q?x?=', 'not an id', '<a b@x.y>'])(
    'refuses a reply header that is not a list of ids: %j',
    value => {
      const mail = plainDraft({ id: 'd1', body: 'x', extraHeaders: [{ name: 'In-Reply-To', value }] });
      expect(reasonOf(forSend(mail))).toContain('header');
    },
  );

  it('refuses a draft with no recipients for a send, but lets one be edited', () => {
    const mail = { ...plainDraft({ id: 'd1', body: 'x' }) };
    const noRecipients: GmailMessage = {
      ...mail,
      payload: {
        ...mail.payload,
        headers: (mail.payload?.headers ?? []).filter(header => header.name !== 'To'),
      },
    };
    expect(reasonOf(forSend(noRecipients))).toBe('The draft has no recipients.');
    expect(forEdit(noRecipients).ok).toBe(true);
  });

  it('refuses a body too long to be shown in full, for a send only', () => {
    const long = plainDraft({ id: 'd1', body: 'x'.repeat(MAX_SENDABLE_BODY_CHARS + 1) });
    expect(reasonOf(forSend(long))).toContain('too long');
    expect(forEdit(long).ok).toBe(true);
  });

  it('refuses text that has characters nobody can see', () => {
    expect(reasonOf(forSend(plainDraft({ id: 'd1', body: `Hello​there` })))).toContain('do not show');
    expect(reasonOf(forSend(plainDraft({ id: 'd1', body: 'x', subject: 'Lease\u{E0041}' })))).toContain('do not show');
  });

  it('refuses a text encoding it cannot read for certain', () => {
    const mail = plainDraft({
      id: 'd1',
      body: 'x',
      extraHeaders: [],
    });
    const utf7: GmailMessage = {
      ...mail,
      payload: {
        ...mail.payload,
        headers: (mail.payload?.headers ?? []).map(header =>
          header.name === 'Content-Type' ? { ...header, value: 'text/plain; charset=utf-7' } : header,
        ),
        body: { data: b64url('+AGE-') },
      },
    };
    expect(reasonOf(forSend(utf7))).toContain('encoding');
  });

  it('keeps the exact body, including its line breaks, for the hash to cover', () => {
    const result = forSend(plainDraft({ id: 'd1', body: 'Line one.\n\nLine two.' }));
    expect(result.ok && result.draft.body).toBe('Line one.\n\nLine two.');
  });

  it('refuses blank space at the edges that the card would not show', () => {
    expect(reasonOf(forSend(plainDraft({ id: 'd1', body: '  indented' })))).toContain('blank space');
    expect(reasonOf(forSend(plainDraft({ id: 'd1', body: 'x', subject: ' Lease' })))).toContain('blank space');
  });
});

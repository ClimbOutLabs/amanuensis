import { assessDraft } from '../../../../src/core/email/gmail/draftAssessment';
import { hashDraft } from '../../../../src/core/email/gmail/draftReview';
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
        nameLeftOff: false,
        replyTo: null,
      },
    });
  });

  it('delivers a saved draft with each recipient name as Gmail holds it, even one that looks like an address', () => {
    const result = forSend(
      plainDraft({
        id: 'd2',
        to: '"boss@example.com" <other@example.org>, "Jane Doe (Acme)" <jane@example.org>',
        subject: 'Lease',
        body: 'Thursday works.',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      draft: {
        to: [
          { name: 'boss@example.com', address: 'other@example.org' },
          { name: 'Jane Doe (Acme)', address: 'jane@example.org' },
        ],
        nameLeftOff: false,
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

  it.each(['Sender', 'Disposition-Notification-To', 'X-Anything', 'Return-Path'])(
    'refuses a %s header by name, since it could change who gets the message',
    name => {
      const mail = plainDraft({ id: 'd1', body: 'x', extraHeaders: [{ name, value: 'mallory@example.com' }] });
      expect(reasonOf(forSend(mail))).toContain(`(${name})`);
    },
  );

  it('names the header it cannot check, in words the person can act on', () => {
    const mail = plainDraft({ id: 'd1', body: 'x', extraHeaders: [{ name: 'X-Foo', value: 'x' }] });
    expect(reasonOf(forSend(mail))).toBe(
      'This draft has a header Aman cannot check (X-Foo), so it was not sent. Ask Aman to write it again without it.',
    );
  });

  describe('the Received line Gmail adds to a draft made through its API', () => {
    const STAMP = 'from 123456789 named unknown by gmailapi.google.com with HTTPREST; Thu, 22 Oct 2026 06:50:12 -0700';
    const withReceived = (...values: string[]) =>
      plainDraft({ id: 'd1', body: 'x', extraHeaders: values.map(value => ({ name: 'Received', value })) });

    it('is accepted, and the card and review hash stay the same as without it', () => {
      const plain = forSend(plainDraft({ id: 'd1', body: 'x' }));
      const stamped = forSend(withReceived(STAMP));
      if (!plain.ok || !stamped.ok) {
        throw new Error('both drafts should be sendable');
      }
      expect(stamped.draft).toEqual(plain.draft);
      expect(hashDraft(stamped.draft)).toBe(hashDraft(plain.draft));
      expect(forEdit(withReceived(STAMP)).ok).toBe(true);
    });

    it('is accepted when Gmail folds it onto a second line', () => {
      expect(
        forSend(
          withReceived(
            'from 123456789 named unknown by gmailapi.google.com with HTTPREST;\r\n        Thu, 22 Oct 2026 06:50:12 -0700',
          ),
        ).ok,
      ).toBe(true);
    });

    it.each([
      ['extra text after the date', `${STAMP} Send the keys to mallory@example.com`],
      ['extra text before the stamp', `by mx.example.net; ${STAMP}`],
      ['a different host', STAMP.replace('gmailapi.google.com', 'gmailapi.google.com.example.net')],
      ['a look-alike host', STAMP.replace('gmailapi.google.com', 'gmai1api.google.com')],
      ['a named sender', STAMP.replace('named unknown', 'named mallory')],
      ['a comment', `${STAMP} (Send the keys)`],
      ['a zone comment', `${STAMP} (PDT)`],
      ['a comment in the middle', STAMP.replace('with HTTPREST', '(note) with HTTPREST')],
      ['letters where the client number goes', STAMP.replace('123456789', 'mallory')],
      ['non-ASCII text', STAMP.replace('unknown', 'unkn\u043Ewn')],
      ['a trailing space', `${STAMP} `],
      ['no date', 'from 123456789 named unknown by gmailapi.google.com with HTTPREST;'],
      [
        'a received line from an ordinary mail server',
        'from mx.example.net (mx.example.net [192.0.2.1]) by mx.example.org with ESMTPS id abc; Thu, 22 Oct 2026 06:50:12 -0700',
      ],
    ])('is refused by name when it has %s', (_case, value) => {
      const reason =
        'This draft has a header Aman cannot check (Received), so it was not sent. Ask Aman to write it again without it.';
      expect(reasonOf(forSend(withReceived(value)))).toBe(reason);
      expect(forEdit(withReceived(value)).ok).toBe(false);
    });

    it('is refused when a second hop follows, even another Gmail stamp', () => {
      expect(forSend(withReceived(STAMP, STAMP)).ok).toBe(false);
      expect(
        forSend(
          withReceived(STAMP, 'from mx.example.net by mx.example.org with ESMTP; Thu, 22 Oct 2026 06:50:13 -0700'),
        ).ok,
      ).toBe(false);
    });
  });

  it('shows a Reply-To elsewhere as the address replies go to', () => {
    const mail = plainDraft({
      id: 'd1',
      body: 'x',
      extraHeaders: [{ name: 'Reply-To', value: 'Mallory <Mallory@Example.com>' }],
    });
    expect(forSend(mail)).toMatchObject({ ok: true, draft: { replyTo: 'mallory@example.com' } });
  });

  it.each([
    'mallory@example.com, <ada@example.com>',
    'mallory@example.com, Ada <ada@example.com>',
    'mallory@example.com <ada@example.com>',
    'Team: mallory@example.com, <ada@example.com>',
    '(mallory@example.com) <ada@example.com>',
    'mallory@example.com,<grace@example.com>',
  ])('refuses a Reply-To or Sender that is not one plain mailbox: %s', value => {
    for (const name of ['Reply-To', 'Sender']) {
      const mail = plainDraft({ id: 'd1', body: 'x', extraHeaders: [{ name, value }] });
      expect(reasonOf(forSend(mail))).toContain(`${name} line is not one plain address`);
    }
    // Without a Reply-To, replies go to every From mailbox, so From is held to the same rule.
    expect(reasonOf(forSend(plainDraft({ id: 'd1', from: value, body: 'x' })))).toBe(
      "This draft's From line is not one plain address, so Aman cannot show you exactly where it goes. Ask me to write it again.",
    );
  });

  it('says plainly why a Sender for another address is refused, and what to do next', () => {
    const mail = plainDraft({ id: 'd1', body: 'x', extraHeaders: [{ name: 'Sender', value: 'mallory@example.com' }] });
    expect(reasonOf(forSend(mail))).toBe(
      'This draft says it is sent on behalf of another address (Sender), so it was not sent. Ask me to write it again from your own address.',
    );
  });

  it('still sends from the account with a quoted name that has a comma', () => {
    expect(forSend(plainDraft({ id: 'd1', from: '"Lovelace, Ada" <ada@example.com>', body: 'x' })).ok).toBe(true);
  });

  it('reads a quoted name with a comma in a Reply-To as one mailbox', () => {
    const mail = plainDraft({
      id: 'd1',
      body: 'x',
      extraHeaders: [{ name: 'Reply-To', value: '"Lovelace, Ada" <ada@example.com>' }],
    });
    expect(forSend(mail)).toMatchObject({ ok: true, draft: { replyTo: null } });
  });

  it('will not change a saved draft that replies elsewhere, since the change would drop that reply address', () => {
    const elsewhere = plainDraft({
      id: 'd1',
      body: 'x',
      extraHeaders: [{ name: 'Reply-To', value: 'mallory@example.com' }],
    });
    expect(reasonOf(forEdit(elsewhere))).toContain('cannot keep');
    const ownAddress = plainDraft({
      id: 'd1',
      body: 'x',
      extraHeaders: [{ name: 'Reply-To', value: 'ada@example.com' }],
    });
    expect(forEdit(ownAddress).ok).toBe(true);
  });

  it('counts a changed reply address in the review hash, so a change after review voids the approval', () => {
    const plain = forSend(plainDraft({ id: 'd1', body: 'x' }));
    const elsewhere = forSend(
      plainDraft({ id: 'd1', body: 'x', extraHeaders: [{ name: 'Reply-To', value: 'mallory@example.com' }] }),
    );
    if (!plain.ok || !elsewhere.ok) {
      throw new Error('both drafts should be sendable');
    }
    expect(hashDraft(elsewhere.draft)).not.toBe(hashDraft(plain.draft));
  });

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

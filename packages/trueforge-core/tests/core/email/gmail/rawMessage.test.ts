import type { GmailMessage, MessagePart } from '../../../../src/core/email/gmail/gmailWire';
import { headerOf, readMessage } from '../../../../src/core/email/gmail/message';
import { buildRawMessage } from '../../../../src/core/email/gmail/rawMessage';

/** Parses what we built the way a mail reader would: headers, then a base64 UTF-8 body. */
function parse(raw: string): GmailMessage {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const [head = '', ...rest] = text.split('\r\n\r\n');
  const unfolded = head.replace(/\r\n /g, '');
  const headers = unfolded.split('\r\n').map(line => {
    const index = line.indexOf(':');
    return { name: line.slice(0, index), value: line.slice(index + 1).trim() };
  });
  const body = Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8');
  const payload: MessagePart = {
    mimeType: 'text/plain',
    headers,
    body: { data: Buffer.from(body, 'utf8').toString('base64url') },
  };
  return { id: 'd1', threadId: 't1', payload };
}

const BASE = { to: ['grace@example.com'], subject: 'Lease', body: 'Thursday works.' };

describe('buildRawMessage', () => {
  it('writes the recipients, subject and a UTF-8 body', () => {
    const message = parse(buildRawMessage({ content: BASE, reply: undefined }));
    expect(headerOf({ message, name: 'To' })).toBe('grace@example.com');
    expect(headerOf({ message, name: 'Subject' })).toBe('Lease');
    expect(headerOf({ message, name: 'Content-Type' })).toBe('text/plain; charset=UTF-8');
    expect(readMessage(message).body).toBe('Thursday works.');
  });

  it('carries cc and bcc', () => {
    const raw = Buffer.from(
      buildRawMessage({
        content: { ...BASE, cc: ['a@example.com', 'b@example.com'], bcc: ['c@example.com'] },
        reply: undefined,
      }),
      'base64url',
    ).toString();
    expect(raw).toContain('Cc: a@example.com, b@example.com\r\n');
    expect(raw).toContain('Bcc: c@example.com\r\n');
  });

  it.each([
    ['Japanese', '来週の打ち合わせの件につきまして、資料を共有いたします。よろしくお願いいたします'],
    ['Portuguese', 'Contrato — revisão final, até quinta-feira'],
    ['Russian', 'Договор получен, спасибо'],
    ['Arabic', 'مرحبا، استلمت العقد'],
    ['Hebrew', 'שלום, קיבלתי את החוזה'],
  ])('round-trips a %s subject and body without loss', (_name, text) => {
    const raw = buildRawMessage({ content: { ...BASE, subject: text, body: text.repeat(200) }, reply: undefined });
    const message = parse(raw);
    expect(headerOf({ message, name: 'Subject' })).toBe(text);
    expect(readMessage(message).body).toBe(text.repeat(200));
    expect(Buffer.from(raw, 'base64url').toString()).not.toMatch(/[^ -~\r\n]/);
  });

  it('keeps every line within 998 characters', () => {
    const raw = Buffer.from(
      buildRawMessage({ content: { ...BASE, body: 'x'.repeat(50_000) }, reply: undefined }),
      'base64url',
    ).toString();
    for (const line of raw.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });

  it('threads a reply with the original identifiers', () => {
    const message = parse(
      buildRawMessage({
        content: BASE,
        reply: { messageIdHeader: '<orig@mail.example.com>', referencesHeader: '<first@mail.example.com>' },
      }),
    );
    expect(headerOf({ message, name: 'In-Reply-To' })).toBe('<orig@mail.example.com>');
    expect(headerOf({ message, name: 'References' })).toBe('<first@mail.example.com> <orig@mail.example.com>');
  });

  it('lists each reference once when the original is already named in them', () => {
    const message = parse(
      buildRawMessage({
        content: BASE,
        reply: {
          messageIdHeader: '<orig@mail.example.com>',
          referencesHeader: '<first@mail.example.com> <orig@mail.example.com>',
        },
      }),
    );
    expect(headerOf({ message, name: 'References' })).toBe('<first@mail.example.com> <orig@mail.example.com>');
  });

  it('drops anything in the reply headers that is not a message id', () => {
    const message = parse(
      buildRawMessage({
        content: BASE,
        reply: { messageIdHeader: '<orig@mail.example.com> junk', referencesHeader: 'Bcc: mallory@example.com' },
      }),
    );
    expect(headerOf({ message, name: 'References' })).toBe('<orig@mail.example.com>');
  });

  it('encodes a long subject in encoded words of at most 45 bytes that never split a character', () => {
    const subject = '会議の予定とても長い件名🙂'.repeat(12);
    const text = Buffer.from(
      buildRawMessage({ content: { ...BASE, subject }, reply: undefined }),
      'base64url',
    ).toString();
    const words = [...text.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)];
    expect(words.length).toBeGreaterThan(1);
    for (const [word, payload = ''] of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(Buffer.from(payload, 'base64').length).toBeLessThanOrEqual(45);
      expect(Buffer.from(payload, 'base64').toString('utf8')).not.toContain('\uFFFD');
    }
    expect(
      headerOf({
        message: parse(buildRawMessage({ content: { ...BASE, subject }, reply: undefined })),
        name: 'Subject',
      }),
    ).toBe(subject);
  });

  it('refuses a line break in the subject, which would inject a header', () => {
    expect(() =>
      buildRawMessage({ content: { ...BASE, subject: 'Hi\r\nBcc: mallory@example.com' }, reply: undefined }),
    ).toThrow(RangeError);
  });
});

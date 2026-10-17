import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import { headerOf, readMessage } from '../../../../src/core/email/gmail/message';
import {
  contentTypeCharset,
  decodeBytes,
  decodeEncodedWords,
  stripInvisible,
} from '../../../../src/core/email/gmail/mimeText';
import { addressesIn, listThreadsResult, readEmailResult } from '../../../../src/core/email/gmail/results';
import { CHARSET_SAMPLES, ENCODED_WORD_SAMPLES } from './charsetFixtures';
import { message } from './fixtures';

const REPLACEMENT = '�';
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏]/;

function charsetMessage(input: {
  mimeType: 'text/plain' | 'text/html';
  charset: string;
  data: string;
  subject?: string;
}): GmailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    payload: {
      mimeType: input.mimeType,
      headers: [
        { name: 'Content-Type', value: `${input.mimeType}; charset="${input.charset}"` },
        { name: 'Subject', value: input.subject ?? 'x' },
      ],
      body: { data: input.data },
    },
  };
}

describe('contentTypeCharset', () => {
  it.each([
    ['text/plain; charset=ISO-8859-1', 'iso-8859-1'],
    ['text/html; format=flowed; charset="Shift_JIS"', 'shift_jis'],
    ['text/plain;charset=utf-8;format=flowed', 'utf-8'],
    ['text/plain; format="a;b"; charset=utf-8', 'utf-8'],
  ])('reads %s', (header, expected) => {
    expect(contentTypeCharset(header)).toEqual({ kind: 'one', charset: expected });
  });

  it('is none when none is declared, and ignores a charset that only appears inside a quoted value', () => {
    expect(contentTypeCharset('text/plain')).toEqual({ kind: 'none' });
    expect(contentTypeCharset('text/plain; name="x; charset=utf-7"')).toEqual({ kind: 'none' });
  });

  it.each([
    ['a repeated charset', 'text/plain; charset=utf-8; charset=utf-7'],
    ['an extended charset', "text/plain; charset*=utf-7''x"],
    ['a charset continuation', 'text/plain; charset*0=utf-; charset*1=7'],
    ['a charset continuation beside a plain one', 'text/plain; charset=utf-8; charset*0=utf-; charset*1=7'],
    ['different case', 'text/plain; CHARSET=utf-8; Charset=utf-7'],
    ['an unclosed quote', 'text/plain; name="x; charset=utf-8'],
  ])('is ambiguous for %s', (_name, header) => {
    expect(contentTypeCharset(header)).toEqual({ kind: 'ambiguous' });
  });
});

describe('plain text bodies in their declared charset', () => {
  it.each(CHARSET_SAMPLES)('reads $name ($charset) without losing a character', sample => {
    const read = readMessage(charsetMessage({ mimeType: 'text/plain', charset: sample.charset, data: sample.data }));
    expect(read.body).toBe(sample.text);
    expect(read.body).not.toContain(REPLACEMENT);
  });

  it('reads Windows-1252 punctuation that ISO-8859-1 would turn into control characters', () => {
    const sample = CHARSET_SAMPLES.find(item => item.name === 'french');
    expect(
      readMessage(charsetMessage({ mimeType: 'text/plain', charset: 'windows-1252', data: sample?.data ?? '' })).body,
    ).toContain('€ — “bonjour”');
  });

  it('keeps right-to-left text in logical order, adding no direction marks', () => {
    for (const name of ['arabic', 'hebrew', 'mixedRtl']) {
      const sample = CHARSET_SAMPLES.find(item => item.name === name);
      const body = readMessage(
        charsetMessage({ mimeType: 'text/plain', charset: 'utf-8', data: sample?.data ?? '' }),
      ).body;
      expect(body).toBe(sample?.text);
      expect(body).not.toMatch(BIDI_CONTROLS);
    }
  });

  it('reads undeclared bytes as UTF-8 when valid and as Windows-1252 when not, never with replacement marks', () => {
    expect(decodeBytes({ bytes: Buffer.from('Olá', 'utf8'), charset: null })).toBe('Olá');
    expect(decodeBytes({ bytes: Uint8Array.from([0x4f, 0x6c, 0xe1]), charset: null })).toBe('Olá');
  });

  it('reads the web label ISO-8859-1 as Windows-1252, as mail clients do', () => {
    expect(decodeBytes({ bytes: Uint8Array.from([0x80, 0x93, 0x94, 0xe9]), charset: 'iso-8859-1' })).toBe('€“”é');
  });

  it('shows the bytes as they are for a charset nothing here reads, and for UTF-7, instead of guessing', () => {
    expect(decodeBytes({ bytes: Buffer.from('Ola +AGE-', 'utf8'), charset: 'x-made-up' })).toBe('Ola +AGE-');
    expect(decodeBytes({ bytes: Buffer.from('+ADw-b+AD4-hi', 'utf8'), charset: 'utf-7' })).toBe('+ADw-b+AD4-hi');
    expect(decodeEncodedWords('=?utf-7?Q?+AGE-?=')).toBe('+AGE-');
  });
});

describe('HTML-only bodies', () => {
  it('converts Shift_JIS HTML to readable text', () => {
    // The HTML below, encoded as Shift_JIS, as Gmail hands it over.
    const data =
      'PGh0bWw-PGJvZHk-PHA-gqiQophigsmCyILBgsSCqILogtyCt4FCPC9wPjxwPoxflvGPkYLwim2URoK1gtyCtYK9gUI8L3A-PC9ib2R5PjwvaHRtbD4';
    const read = readMessage(charsetMessage({ mimeType: 'text/html', charset: 'shift_jis', data }));
    expect(read.body).toBe('お世話になっております。\n契約書を確認しました。');
  });

  it('prefers the plain text part when both exist, even when it is not UTF-8', () => {
    const sample = CHARSET_SAMPLES.find(item => item.name === 'chineseGbk');
    const mixed: GmailMessage = {
      id: 'm1',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/alternative',
        parts: [
          {
            mimeType: 'text/plain',
            headers: [{ name: 'Content-Type', value: 'text/plain; charset=GBK' }],
            body: { data: sample?.data ?? '' },
          },
          {
            mimeType: 'text/html',
            headers: [{ name: 'Content-Type', value: 'text/html; charset=GBK' }],
            body: { data: sample?.data ?? '' },
          },
        ],
      },
    };
    expect(readMessage(mixed).body).toBe(sample?.text);
  });
});

describe('HTML parts that declare their charset only in a meta tag', () => {
  it('reads Shift_JIS HTML with a meta http-equiv declaration', () => {
    const mail: GmailMessage = {
      id: 'm1',
      threadId: 't1',
      payload: {
        mimeType: 'text/html',
        body: {
          data: 'PGh0bWw-PGhlYWQ-PG1ldGEgaHR0cC1lcXVpdj0iQ29udGVudC1UeXBlIiBjb250ZW50PSJ0ZXh0L2h0bWw7IGNoYXJzZXQ9c2hpZnRfamlzIj48L2hlYWQ-PGJvZHk-PHA-gqiQophigsmCyILBgsSCqILogtyCt4FCPC9wPjwvYm9keT48L2h0bWw-',
        },
      },
    };
    expect(readMessage(mail).body).toBe('お世話になっております。');
  });

  it('reads Windows-1251 HTML with a short meta charset declaration', () => {
    const mail: GmailMessage = {
      id: 'm1',
      threadId: 't1',
      payload: {
        mimeType: 'text/html',
        body: {
          data: 'PGh0bWw-PGhlYWQ-PG1ldGEgY2hhcnNldD0id2luZG93cy0xMjUxIj48L2hlYWQ-PGJvZHk-z_Do4uXyLCDs6PA8L2JvZHk-PC9odG1sPg',
        },
      },
    };
    expect(readMessage(mail).body).toBe('Привет, мир');
  });
});

describe('message structure', () => {
  const plain = (text: string) => ({
    mimeType: 'text/plain',
    body: { data: Buffer.from(text, 'utf8').toString('base64url') },
  });
  const html = (text: string) => ({
    mimeType: 'text/html',
    body: { data: Buffer.from(text, 'utf8').toString('base64url') },
  });

  it('finds the text in nested multipart/alternative inside multipart/mixed and multipart/related', () => {
    const mail: GmailMessage = {
      id: 'm1',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'multipart/related',
            parts: [
              { mimeType: 'multipart/alternative', parts: [plain('Plain version'), html('<p>HTML version</p>')] },
            ],
          },
        ],
      },
    };
    const read = readMessage(mail);
    expect(read.body).toBe('Plain version');
    expect(read.hasHtml).toBe(true);
  });

  it('falls back to the HTML when the plain part is blank', () => {
    const mail: GmailMessage = {
      id: 'm1',
      threadId: 't1',
      payload: { mimeType: 'multipart/alternative', parts: [plain(' \r\n '), html('<p>Only in the <b>HTML</b></p>')] },
    };
    expect(readMessage(mail).body).toBe('Only in the HTML');
  });

  it('counts any part served by attachment id as an attachment, named or not', () => {
    const mail: GmailMessage = {
      id: 'm1',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          plain('see files'),
          { mimeType: 'application/pdf', filename: '', body: { attachmentId: 'a1', size: 10 } },
          { mimeType: 'image/png', body: { attachmentId: 'a2', size: 20 } },
        ],
      },
    };
    expect(readMessage(mail).attachments.map(file => [file.id, file.filename])).toEqual([
      ['a1', 'attachment'],
      ['a2', 'attachment'],
    ]);
  });
});

describe('hidden characters', () => {
  it('removes Unicode tag characters and bidi controls from headers and bodies', () => {
    const tagged = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e) + 'Hello';
    const mail = message({
      id: 'm1',
      subject: `Lea\u202Ese\u2066 ${tagged}`,
      body: `${tagged} body\u202E here\u200B!`,
    });
    expect(headerOf({ message: mail, name: 'Subject' })).toBe('Lease Hello');
    expect(readMessage(mail).body).toBe('Hello body here!');
  });

  it('keeps the joiners that Persian and Indic scripts need', () => {
    expect(stripInvisible('می\u200Cخواهم')).toBe('می\u200Cخواهم');
  });

  it('bounds a header that is far longer than any subject', () => {
    const mail = message({ id: 'm1', subject: 'x'.repeat(50_000), body: 'hi' });
    expect(headerOf({ message: mail, name: 'Subject' }).length).toBeLessThan(1100);
  });
});

describe('RFC 2047 encoded words in headers', () => {
  it('joins adjacent words of one charset before decoding, so a character split between them survives', () => {
    expect(decodeEncodedWords('=?utf-8?B?5pel5g==?= =?utf-8?B?nKzoqp4=?=')).toBe('日本語');
  });

  it('splits an address list before decoding, so a comma inside a name does not make a second address', () => {
    const mail = message({
      id: 'm1',
      to: '=?utf-8?Q?Doe=2C_John?= <john@example.com>, =?utf-8?B?5p2O?= <li@example.com>',
      body: 'hi',
    });
    expect(addressesIn({ message: mail, name: 'To' })).toEqual(['john@example.com', 'li@example.com']);
  });

  it.each(ENCODED_WORD_SAMPLES)('decodes $name', sample => {
    expect(decodeEncodedWords(sample.header)).toBe(sample.decoded);
    expect(decodeEncodedWords(sample.header)).not.toContain(REPLACEMENT);
  });

  it('leaves a plain header and a literal question-mark sequence alone', () => {
    expect(decodeEncodedWords('Re: lease =? not a word')).toBe('Re: lease =? not a word');
  });

  it('is applied to every header a result shows', () => {
    const encoded = ENCODED_WORD_SAMPLES.find(item => item.name === 'display name');
    const subject = ENCODED_WORD_SAMPLES.find(item => item.name === 'iso-2022-jp base64');
    const mail = message({
      id: 'm1',
      threadId: 't1',
      from: encoded?.header ?? '',
      subject: subject?.header ?? '',
      body: 'hi',
    });
    expect(headerOf({ message: mail, name: 'From' })).toBe('José Müller <jose@example.com>');
    const result = readEmailResult({
      context: { account: 'ada@example.com', attachmentsOpenable: true },
      message: mail,
    });
    expect(result.from).toBe('José Müller <jose@example.com>');
    expect(result.subject).toBe('会議の予定');
    const list = listThreadsResult({
      context: { account: 'ada@example.com', attachmentsOpenable: true },
      threads: [{ id: 't1', messages: [mail] }],
      providerEstimate: 1,
      nextPageToken: undefined,
      notReached: 0,
    });
    expect(list.threads[0]?.subject).toBe('会議の予定');
  });
});

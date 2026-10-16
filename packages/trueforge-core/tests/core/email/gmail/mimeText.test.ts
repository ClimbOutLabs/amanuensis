import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import { headerOf, htmlToText, readMessage } from '../../../../src/core/email/gmail/message';
import { charsetOf, decodeBytes, decodeEncodedWords } from '../../../../src/core/email/gmail/mimeText';
import { listThreadsResult, readEmailResult } from '../../../../src/core/email/gmail/results';
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

describe('charsetOf', () => {
  it.each([
    ['text/plain; charset=ISO-8859-1', 'iso-8859-1'],
    ['text/html; format=flowed; charset="Shift_JIS"', 'shift_jis'],
    ['text/plain;charset=utf-8;format=flowed', 'utf-8'],
  ])('reads %s', (header, expected) => {
    expect(charsetOf(header)).toBe(expected);
  });

  it('is null when none is declared', () => {
    expect(charsetOf('text/plain')).toBeNull();
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

  it('falls back safely on a charset name nothing knows', () => {
    expect(decodeBytes({ bytes: Buffer.from('Olá', 'utf8'), charset: 'x-made-up' })).toBe('Olá');
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

  it('decodes Portuguese entities and keeps accented letters', () => {
    expect(
      htmlToText(
        '<p>Ol&aacute;, voc&ecirc; j&aacute; recebeu a a&ccedil;&atilde;o?</p><p>Ol&Aacute;&nbsp;Jo&atilde;o</p>',
      ),
    ).toBe('Olá, você já recebeu a ação?\nOlÁ João');
  });

  it('does not mangle Arabic, Hebrew, Chinese or Russian in HTML', () => {
    const html = '<div dir="rtl">مرحبا بالعالم</div><div>שלום עולם</div><div>您好，世界</div><div>Привет, мир</div>';
    expect(htmlToText(html)).toBe('مرحبا بالعالم\nשלום עולם\n您好，世界\nПривет, мир');
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

describe('RFC 2047 encoded words in headers', () => {
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
    const result = readEmailResult({ context: { account: 'ada@example.com' }, message: mail });
    expect(result.from).toBe('José Müller <jose@example.com>');
    expect(result.subject).toBe('会議の予定');
    const list = listThreadsResult({
      context: { account: 'ada@example.com' },
      threads: [{ id: 't1', messages: [mail] }],
      providerEstimate: 1,
      nextPageToken: undefined,
    });
    expect(list.threads[0]?.subject).toBe('会議の予定');
  });
});

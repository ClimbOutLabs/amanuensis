/**
 * Every pattern and scanner that touches mail text is linear: each gets 1 MB of the input that hurts a
 * backtracking pattern, and must finish in under a second.
 */
import { assessDraft } from '../../../../src/core/email/gmail/draftAssessment';
import { decodeEntities, htmlToText } from '../../../../src/core/email/gmail/htmlText';
import { headerOf, readMessage } from '../../../../src/core/email/gmail/message';
import {
  charsetOf,
  decodeEncodedWords,
  hasHiddenCharacters,
  sniffHtmlCharset,
  stripInvisible,
} from '../../../../src/core/email/gmail/mimeText';
import { buildRawMessage, replySubject } from '../../../../src/core/email/gmail/rawMessage';
import {
  addressesOf,
  addressListIsPlain,
  neutralizeDeep,
  neutralizeInternalTags,
} from '../../../../src/core/email/gmail/results';
import { snippetOf } from '../../../../src/core/email/gmail/tokenBound';
import { escapeDisplayText } from '../../../../src/core/permissions/extractorRegistry';
import { message, plainDraft } from './fixtures';

const MB = 1_000_000;

function within(limitMs: number, work: () => unknown): number {
  const started = Date.now();
  try {
    work();
  } catch (error) {
    // A refusal is an answer; only slowness fails here.
    if (!(error instanceof RangeError)) {
      throw error;
    }
  }
  const took = Date.now() - started;
  expect(took).toBeLessThan(limitMs);
  return took;
}

const HOSTILE: [string, string][] = [
  ['an angle bracket and 32k spaces', `<${' '.repeat(32_000)}x`],
  ['a long run of angle brackets', '<'.repeat(MB)],
  ['angle brackets with spaces', '< '.repeat(MB / 2)],
  ['angle brackets with slashes', '</ '.repeat(MB / 3)],
  ['one angle bracket and a megabyte of slashes and spaces', `<${'/ '.repeat(MB / 2)}`],
  ['many commas', ','.repeat(40_000)],
  ['quotes and commas', '"a,'.repeat(MB / 3)],
  ['an unclosed quote', `"${'a, '.repeat(MB / 3)}`],
  ['encoded-word openers', '=?'.repeat(MB / 2)],
  ['long encoded-word charsets', `=?${'a'.repeat(MB)}`],
  ['semicolons and spaces', '; '.repeat(MB / 2)],
  ['meta openers', '<meta '.repeat(MB / 6)],
  ['ampersands', '&a'.repeat(MB / 2)],
  ['whitespace', ' \t\n'.repeat(MB / 3)],
  ['repeated reply prefixes', 're: '.repeat(MB / 4)],
  ['a word and a megabyte of spaces', `re${' '.repeat(MB)}`],
  ['variation selectors', '️'.repeat(MB)],
  ['tag characters', '\u{E0049}'.repeat(MB / 2)],
  ['emoji and markers', '\u{1F600}️'.repeat(MB / 3)],
];

describe.each(HOSTILE)('1 MB of %s', (_name, text) => {
  it.each([
    ['neutralizeInternalTags', () => neutralizeInternalTags(text)],
    ['neutralizeDeep', () => neutralizeDeep({ a: [text] })],
    ['addressesOf', () => addressesOf(text)],
    ['addressListIsPlain', () => addressListIsPlain(text)],
    ['decodeEncodedWords', () => decodeEncodedWords(text)],
    ['charsetOf', () => charsetOf(text)],
    ['sniffHtmlCharset', () => sniffHtmlCharset(Buffer.from(text))],
    ['decodeEntities', () => decodeEntities(text)],
    ['htmlToText', () => htmlToText(text)],
    ['snippetOf', () => snippetOf(text)],
    ['replySubject', () => replySubject(text)],
    ['stripInvisible', () => stripInvisible(text)],
    ['hasHiddenCharacters', () => hasHiddenCharacters(text)],
    ['escapeDisplayText', () => escapeDisplayText(text, { keepNewlines: true })],
    ['headerOf', () => headerOf({ message: message({ id: 'm', subject: text, to: text }), name: 'To' })],
    ['readMessage', () => readMessage(message({ id: 'm', body: text, html: text }))],
    [
      'assessDraft',
      () =>
        assessDraft({
          message: plainDraft({ id: 'd', to: text, subject: text, body: text }),
          account: 'ada@example.com',
          forSend: true,
        }),
    ],
    [
      'buildRawMessage',
      () =>
        buildRawMessage({
          content: { to: ['a@example.com'], cc: [], bcc: [], subject: text.slice(0, 300), body: text },
          reply: undefined,
        }),
    ],
  ])('reads it in %s in under a second', (_fn, work) => {
    within(1000, work);
  });
});

describe('attachment names', () => {
  it('cuts a file name and a media type before anything else looks at them', () => {
    const mail = message({
      id: 'm',
      body: 'x',
      attachments: [{ id: 'a', filename: 'n'.repeat(MB), mimeType: `application/${'x'.repeat(MB)}`, size: 1 }],
    });
    const [file] = readMessage(mail).attachments;
    expect(file?.filename).toHaveLength(255);
    expect(file?.mimeType).toHaveLength(100);
  });
});

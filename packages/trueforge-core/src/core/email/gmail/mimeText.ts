/**
 * Turns the bytes and headers of a Gmail message into text without losing characters. Gmail has already
 * removed the transfer encoding (base64, quoted-printable) from a part's body, so what is left to do is read
 * the bytes in the charset the part declares. The WHATWG decoder built into Node covers every legacy
 * charset mail still uses (ISO-8859-x, Windows-125x, Shift_JIS, EUC-JP/KR, ISO-2022-JP, GBK, Big5, KOI8-R), so
 * no decoding library is needed. Text stays in logical order, which is what keeps Arabic and Hebrew correct.
 */

/** Windows-1252 characters for bytes 0x80 to 0x9F; the five bytes it leaves undefined map to the control code. */
const WINDOWS_1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

/**
 * The web's "ISO-8859-1" is Windows-1252. Node's own decoder reads that label as plain Latin-1, which turns
 * the euro sign and curly quotes into invisible control codes, so this charset is decoded here.
 */
function decodeWindows1252(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += byte >= 0x80 && byte <= 0x9f ? (WINDOWS_1252_HIGH[byte - 0x80] ?? '') : String.fromCharCode(byte);
  }
  return text;
}

/** A charset Aman can read: one the decoder knows, and not UTF-7, which writes ordinary letters as escapes. */
export function isUsableCharset(label: string): boolean {
  if (label.toLowerCase().replace(/[^a-z0-9]/g, '') === 'utf7') {
    return false;
  }
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/** What a Content-Type header says about its charset. */
type ContentTypeCharset =
  | { kind: 'none' }
  | { kind: 'one'; charset: string }
  /** More than one `charset`, or a `charset*` form (RFC 2231), which readers resolve differently. */
  | { kind: 'ambiguous' };

/**
 * The `charset` parameter of a Content-Type header value. Exactly one plain `charset=` is read; none is
 * `none`; a repeated parameter or any `charset*` continuation or extended form is `ambiguous`, because readers
 * disagree about which one wins. Parameters are split outside quotes in one pass.
 */
export function contentTypeCharset(contentType: string): ContentTypeCharset {
  const params: string[] = [];
  let inQuotes = false;
  let start = 0;
  for (let index = 0; index < contentType.length; index += 1) {
    const character = contentType[index];
    if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === ';' && !inQuotes) {
      params.push(contentType.slice(start, index));
      start = index + 1;
    }
  }
  params.push(contentType.slice(start));
  const charsets: string[] = [];
  for (const param of params.slice(1)) {
    const equals = param.indexOf('=');
    const name = (equals === -1 ? param : param.slice(0, equals)).trim().toLowerCase();
    if (name.startsWith('charset') && name !== 'charset') {
      return { kind: 'ambiguous' };
    }
    if (name === 'charset') {
      charsets.push(
        param
          .slice(equals + 1)
          .trim()
          .replace(/^"(.*)"$/s, '$1')
          .trim()
          .toLowerCase(),
      );
    }
  }
  if (inQuotes || charsets.length > 1) {
    return { kind: 'ambiguous' };
  }
  const [only] = charsets;
  return only === undefined || only === '' ? { kind: 'none' } : { kind: 'one', charset: only };
}

/**
 * True for a Content-Type that is exactly `text/plain` with one plain charset, and at most `format=flowed` and
 * `delsp=yes`, each once. Any other parameter (a name, a filename, a note) could carry text that is neither shown
 * nor checked, so a send does not accept it.
 */
export function isPlainTextContentType(contentType: string): boolean {
  const params: string[] = [];
  let inQuotes = false;
  let start = 0;
  for (let index = 0; index < contentType.length; index += 1) {
    const character = contentType[index];
    if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === ';' && !inQuotes) {
      params.push(contentType.slice(start, index));
      start = index + 1;
    }
  }
  params.push(contentType.slice(start));
  const [mediaType, ...rest] = params;
  if (inQuotes || mediaType?.trim().toLowerCase() !== 'text/plain') {
    return false;
  }
  const seen = new Set<string>();
  for (const param of rest) {
    const equals = param.indexOf('=');
    if (equals === -1) {
      return false;
    }
    const name = param.slice(0, equals).trim().toLowerCase();
    const value = param
      .slice(equals + 1)
      .trim()
      .replace(/^"(.*)"$/s, '$1')
      .toLowerCase();
    const allowed =
      (name === 'charset' && /^[a-z0-9._:-]{1,60}$/.test(value)) ||
      (name === 'format' && value === 'flowed') ||
      (name === 'delsp' && value === 'yes');
    if (!allowed || seen.has(name)) {
      return false;
    }
    seen.add(name);
  }
  return seen.has('charset');
}

/** The charset an HTML document declares in a leading `<meta>` tag, or null. Reads only the first 2 KB. */
export function sniffHtmlCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
  const match = /<meta[^<>]{0,300}?charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(head);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Decodes bytes in the declared charset. With no declaration the bytes are read as UTF-8 when they are
 * valid UTF-8 and as Windows-1252 when they are not, which is how an undeclared Portuguese or Spanish message
 * most often arrives. A character is never swapped for a replacement mark when a charset is known.
 */
export function decodeBytes(input: { bytes: Uint8Array; charset: string | null }): string {
  if (input.charset !== null && !isUsableCharset(input.charset)) {
    // A charset nothing here reads (or UTF-7) is shown as the bytes it holds, never guessed at.
    return Buffer.from(input.bytes).toString('latin1');
  }
  if (input.charset !== null) {
    const decoder = new TextDecoder(input.charset);
    return decoder.encoding === 'windows-1252' ? decodeWindows1252(input.bytes) : decoder.decode(input.bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    return decodeWindows1252(input.bytes);
  }
}

function decodeQuotedPrintableWord(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    const hex = text.slice(index + 1, index + 3);
    if (character === '_') {
      bytes.push(0x20);
    } else if (character === '=' && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(character.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

const ENCODED_WORD = /=\?([^?\s]{1,60})\?([bq])\?([^?\s]{0,400})\?=/gi;

/** Like ENCODED_WORD but also finds a word with a space inside, which the standard forbids and some readers accept. */
const LOOSE_ENCODED_WORD = /=\?([^?\s]{1,60})\?([bq])\?([^?]{0,400})\?=/gi;

/**
 * True when a header holds an encoded word that readers could disagree about: one in a charset that is not
 * readable here (UTF-7 or unknown), or one with a space inside. Such a header is never decoded and sent on trust.
 */
export function hasAmbiguousEncodedWord(header: string): boolean {
  for (const match of header.matchAll(LOOSE_ENCODED_WORD)) {
    const charset = (match[1] ?? '').split('*')[0] ?? '';
    if (!isUsableCharset(charset) || /\s/.test(match[3] ?? '')) {
      return true;
    }
  }
  return false;
}

interface EncodedWord {
  charset: string;
  bytes: Uint8Array;
}

function wordBytes(input: { encoding: string; payload: string }): Uint8Array {
  return input.encoding.toLowerCase() === 'b'
    ? Uint8Array.from(Buffer.from(input.payload, 'base64'))
    : decodeQuotedPrintableWord(input.payload);
}

/**
 * RFC 2047 encoded words in a header (`=?UTF-8?B?...?=`, `=?ISO-2022-JP?B?...?=`, `=?iso-8859-1?Q?...?=`).
 * Adjacent words of one charset are joined before decoding, because a multi-byte character may be split across
 * two of them. Whitespace between encoded words is dropped, as the standard says, and an RFC 2231 language
 * suffix such as `*pt` on the charset is ignored.
 */
export function decodeEncodedWords(header: string): string {
  let out = '';
  let cursor = 0;
  let run: EncodedWord[] = [];
  const flush = () => {
    let index = 0;
    while (index < run.length) {
      const first = run[index];
      if (first === undefined) {
        break;
      }
      const chunks = [first.bytes];
      let next = index + 1;
      while (run[next]?.charset === first.charset) {
        chunks.push(run[next]?.bytes ?? new Uint8Array());
        next += 1;
      }
      out += decodeBytes({ bytes: Buffer.concat(chunks), charset: first.charset });
      index = next;
    }
    run = [];
  };
  for (const match of header.matchAll(ENCODED_WORD)) {
    const start = match.index;
    const between = header.slice(cursor, start);
    if (run.length > 0 && between.trim() !== '') {
      flush();
    }
    if (run.length === 0) {
      out += between;
    }
    run.push({
      charset: (match[1] ?? '').split('*')[0]?.toLowerCase() ?? '',
      bytes: wordBytes({ encoding: match[2] ?? 'b', payload: match[3] ?? '' }),
    });
    cursor = start + match[0].length;
  }
  flush();
  return out + header.slice(cursor);
}

/**
 * Characters that change what a reader sees without being visible, decided by Unicode properties rather than a
 * hand-made list: everything Unicode marks Default_Ignorable (tag characters, variation selectors, soft hyphen,
 * combining grapheme joiner, the Hangul and Braille fillers, bidi and format controls), control characters
 * other than tab, newline and carriage return, private-use code points, line and paragraph
 * separators, and the interlinear marks.
 *
 * A few of those have a real use and are allowed only where it applies, never anywhere else:
 *  - the zero-width joiner between two pictographs (emoji sequences) and in Indic scripts (half forms, chillu);
 *  - the zero-width non-joiner between Arabic or Indic letters and marks;
 *  - the zero-width space between Thai, Lao, Khmer or Myanmar letters;
 *  - the emoji marker after a pictograph that needs one (not one that is already an emoji), and in a keycap;
 *  - the text-style marker after a pictograph, an ideographic variation selector after a Han character, and a
 *    Mongolian free variation selector after a Mongolian letter;
 *  - the tag characters of the England, Scotland and Wales flags, and no other tag sequence.
 * Every other use is hidden data and is refused or escaped.
 */
const TAG_CHARACTER = '[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]';
const BLACK_FLAG = '\\u{1F3F4}';
const CANCEL_TAG = '\\u{E007F}';
const LETTER_OR_MARK = '[\\p{L}\\p{M}]';
const scriptsOf = (...names: string[]) => `[${names.map(name => `\\p{Script_Extensions=${name}}`).join('')}]`;
const INDIC_SCRIPTS = scriptsOf(
  'Devanagari',
  'Bengali',
  'Gurmukhi',
  'Gujarati',
  'Oriya',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Sinhala',
);
const INDIC = `[${LETTER_OR_MARK}&&${INDIC_SCRIPTS}]`;
const INDIC_MARK = `[\\p{Mn}&&${INDIC_SCRIPTS}]`;
const ARABIC_OR_INDIC = `[${LETTER_OR_MARK}&&${scriptsOf(
  'Arabic',
  'Devanagari',
  'Bengali',
  'Gurmukhi',
  'Gujarati',
  'Oriya',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Sinhala',
)}]`;
const SOUTHEAST_ASIAN = `[${LETTER_OR_MARK}&&${scriptsOf('Thai', 'Lao', 'Khmer', 'Myanmar')}]`;
const PICTOGRAPH_OR_MODIFIER = '[\\p{Extended_Pictographic}\\p{Emoji_Modifier}]';

/** A character matched only when it is not in a place it is allowed: the cheap test for the character comes first. */
const outOfContext = ({ character, allowed }: { character: string; allowed: string }) =>
  `(?=${character})(?!${allowed})${character}`;

/**
 * The only tag sequences that are allowed: the three subdivision flags emoji keyboards offer (England,
 * Scotland, Wales). A tag run is a way to carry text nobody sees, so any other run, whatever its length, is
 * hidden. For each flag, a tag character is allowed when it is the one at its place in that exact sequence.
 */
const FLAG_REGIONS: readonly (readonly string[])[] = [
  ['g', 'b', 'e', 'n', 'g'],
  ['g', 'b', 's', 'c', 't'],
  ['g', 'b', 'w', 'l', 's'],
];
const tagCodes = (letters: readonly string[]) =>
  letters.map(letter => `\\u{${(0xe0000 + letter.charCodeAt(0)).toString(16).toUpperCase()}}`).join('');
const FLAG_TAG_POSITIONS = FLAG_REGIONS.flatMap(region =>
  region.map(
    (_letter, index) =>
      `(?<=${BLACK_FLAG}${tagCodes(region.slice(0, index))})(?=${tagCodes(region.slice(index))}${CANCEL_TAG})`,
  ),
).join('|');
const FLAG_ENDINGS = FLAG_REGIONS.map(region => `${BLACK_FLAG}${tagCodes(region)}${CANCEL_TAG}`).join('|');

const HIDDEN_SOURCE = [
  '(?!\\t|\\n|\\r|\\u200B|\\u200C|\\u200D|\\uFE0E|\\uFE0F|\\u180B|\\u180C|\\u180D|\\u180F|[\\u{E0100}-\\u{E01EF}]|[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}\\u{E007F}])[\\p{Default_Ignorable_Code_Point}\\p{Cc}\\p{Zl}\\p{Zp}\\p{Co}\\u2800\\uFFF9-\\uFFFB]',
  outOfContext({
    character: '\\u200D',
    allowed: `(?<=${PICTOGRAPH_OR_MODIFIER}\\uFE0F?)(?=\\u200D\\p{Extended_Pictographic})|(?<=${INDIC})(?=\\u200D${INDIC})|(?<=${INDIC_MARK})`,
  }),
  outOfContext({ character: '\\u200C', allowed: `(?<=${ARABIC_OR_INDIC})(?=\\u200C${ARABIC_OR_INDIC})` }),
  outOfContext({ character: '\\u200B', allowed: `(?<=${SOUTHEAST_ASIAN})(?=\\u200B${SOUTHEAST_ASIAN})` }),
  outOfContext({
    character: '\\uFE0F',
    allowed: '(?<=[\\p{Extended_Pictographic}--\\p{Emoji_Presentation}])|(?<=[0-9#*])(?=\\uFE0F\\u20E3)',
  }),
  outOfContext({ character: '\\uFE0E', allowed: '(?<=\\p{Extended_Pictographic})' }),
  outOfContext({ character: '[\\u{E0100}-\\u{E01EF}]', allowed: '(?<=\\p{Script=Han})' }),
  outOfContext({
    character: '[\\u180B\\u180C\\u180D\\u180F]',
    allowed: '(?<=[\\p{L}&&\\p{Script=Mongolian}])',
  }),
  `(?=${TAG_CHARACTER})(?!${FLAG_TAG_POSITIONS})${TAG_CHARACTER}`,
  `${CANCEL_TAG}(?<!${FLAG_ENDINGS})`,
].join('|');
const HIDDEN_EVERYWHERE = new RegExp(HIDDEN_SOURCE, 'gv');
const HIDDEN_ANYWHERE = new RegExp(HIDDEN_SOURCE, 'v');

export function stripInvisible(text: string): string {
  return text.replace(HIDDEN_EVERYWHERE, '');
}

/** Rewrites each hidden character with `render`, so a display can show what stripping would have removed. */
export function replaceHiddenCharacters(text: string, render: (character: string) => string): string {
  return text.replace(HIDDEN_EVERYWHERE, render);
}

/** Most ideographic variation selectors one message may carry: names need a few, and each can hide a byte. */
export const MAX_IDEOGRAPHIC_SELECTORS = 16;

/** How many ideographic variation selectors the text holds, which are allowed after a Han character but carry data. */
export function countIdeographicSelectors(text: string): number {
  return (text.match(/[\u{E0100}-\u{E01EF}]/gu) ?? []).length;
}

/** The one test for "this text has a character that would not show", so what is read or sent is what is seen. */
export function hasHiddenCharacters(text: string): boolean {
  return HIDDEN_ANYWHERE.test(text);
}

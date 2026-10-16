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

/** The `charset` parameter of a Content-Type header value, or null when it names none. */
export function charsetOf(contentType: string): string | null {
  const match = /;\s*charset\s*=\s*(?:"([^"]*)"|([^\s;]+))/i.exec(contentType);
  const label = (match?.[1] ?? match?.[2] ?? '').trim().toLowerCase();
  return label === '' ? null : label;
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
 * other than tab, newline and carriage return, line and paragraph separators, and the interlinear marks.
 *
 * Three characters have a legitimate use and are allowed only where it applies: the zero-width joiner between
 * two pictographs (emoji sequences), the zero-width non-joiner between two Arabic, Persian or Indic letters,
 * and the emoji presentation marker straight after a pictograph that needs it (a pictograph that is already
 * shown as an emoji needs none, so one there carries nothing but hidden data).
 */
const INDIC_OR_ARABIC_LETTER =
  '[[\\p{L}\\p{M}]&&[\\p{Script=Arabic}\\p{Script=Devanagari}\\p{Script=Bengali}\\p{Script=Gurmukhi}\\p{Script=Gujarati}\\p{Script=Oriya}\\p{Script=Tamil}\\p{Script=Telugu}\\p{Script=Kannada}\\p{Script=Malayalam}\\p{Script=Sinhala}]]';
const PICTOGRAPH_OR_MODIFIER = '[\\p{Extended_Pictographic}\\p{Emoji_Modifier}]';
const HIDDEN_SOURCE = [
  '(?![\\t\\n\\r\\u200C\\u200D\\uFE0F])[\\p{Default_Ignorable_Code_Point}\\p{Cc}\\p{Zl}\\p{Zp}\\u2800\\uFFF9-\\uFFFB]',
  `(?<!${PICTOGRAPH_OR_MODIFIER}\\uFE0F?)\\u200D`,
  '\\u200D(?!\\p{Extended_Pictographic})',
  `(?<!${INDIC_OR_ARABIC_LETTER})\\u200C`,
  `\\u200C(?!${INDIC_OR_ARABIC_LETTER})`,
  '(?<![\\p{Extended_Pictographic}--\\p{Emoji_Presentation}])\\uFE0F',
].join('|');
// The lint rule cannot tell the joiners above are tested in context (lookarounds), not combined in a class.
// eslint-disable-next-line no-misleading-character-class
const HIDDEN_EVERYWHERE = new RegExp(HIDDEN_SOURCE, 'gv');
// eslint-disable-next-line no-misleading-character-class
const HIDDEN_ANYWHERE = new RegExp(HIDDEN_SOURCE, 'v');

export function stripInvisible(text: string): string {
  return text.replace(HIDDEN_EVERYWHERE, '');
}

/** Rewrites each hidden character with `render`, so a display can show what stripping would have removed. */
export function replaceHiddenCharacters(text: string, render: (character: string) => string): string {
  return text.replace(HIDDEN_EVERYWHERE, render);
}

/** The one test for "this text has a character that would not show", so what is read or sent is what is seen. */
export function hasHiddenCharacters(text: string): boolean {
  return HIDDEN_ANYWHERE.test(text);
}

/**
 * Turns the bytes and headers of a Gmail message into text without losing characters. Gmail has already
 * removed the transfer encoding (base64, quoted-printable) from a part's body, so what is left to do is read
 * the bytes in the charset the part declares. The WHATWG decoder built into Node covers every legacy
 * charset mail still uses (ISO-8859-x, Windows-125x, Shift_JIS, EUC-JP, ISO-2022-JP, GBK, Big5, KOI8-R), so no
 * decoding library is needed. Text stays in logical order, which is what keeps Arabic and Hebrew correct.
 */

/** Windows-1252 characters for bytes 0x80 to 0x9F; the five bytes it leaves undefined map to the control code. */
const WINDOWS_1252_HIGH =
  '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

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

function isKnownCharset(label: string): boolean {
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

/**
 * Decodes bytes in the declared charset. With no usable declaration the bytes are read as UTF-8 when they are
 * valid UTF-8 and as Windows-1252 when they are not, which is how an undeclared Portuguese or Spanish message
 * most often arrives. A character is never swapped for a replacement mark when a charset is known.
 */
export function decodeBytes(input: { bytes: Uint8Array; charset: string | null }): string {
  if (input.charset !== null && isKnownCharset(input.charset)) {
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

const ENCODED_WORD = /=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi;

/**
 * RFC 2047 encoded words in a header (`=?UTF-8?B?...?=`, `=?ISO-2022-JP?B?...?=`, `=?iso-8859-1?Q?...?=`).
 * Whitespace between two encoded words is dropped, as the standard says, and a charset suffix such as
 * `*pt` (RFC 2231 language) is ignored.
 */
export function decodeEncodedWords(header: string): string {
  const collapsed = header.replace(/(\?=)\s+(?==\?)/g, '$1');
  return collapsed.replace(ENCODED_WORD, (_match, label: string, encoding: string, payload: string) => {
    const charset = label.split('*')[0]?.toLowerCase() ?? null;
    const bytes =
      encoding.toLowerCase() === 'b'
        ? Uint8Array.from(Buffer.from(payload, 'base64'))
        : decodeQuotedPrintableWord(payload);
    return decodeBytes({ bytes, charset });
  });
}

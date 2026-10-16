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

/** The charset an HTML document declares in a leading `<meta>` tag, or null. Reads only the first 2 KB. */
export function sniffHtmlCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
  const match = /<meta[^<>]{0,300}?charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(head);
  return match?.[1]?.toLowerCase() ?? null;
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

const ENCODED_WORD = /=\?([^?\s]{1,60})\?([bq])\?([^?\s]{0,400})\?=/gi;

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
 * Characters that change what a reader sees without being visible: Unicode tag characters (a known way to
 * smuggle instructions), bidirectional controls (which reorder text to disguise it), and zero-width or soft
 * hyphen padding. Joiners (ZWNJ, ZWJ) stay, because Persian, Indic scripts and emoji need them.
 */
const INVISIBLE = /[\u{E0000}-\u{E007F}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/gu;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

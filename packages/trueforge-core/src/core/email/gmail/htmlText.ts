/**
 * HTML mail to readable text, in one pass that never backtracks, so a crafted message cannot stall the server.
 * Input is capped before anything runs, tags are found with `indexOf`, and nothing here uses a regex that can
 * grow with the length of the input.
 */

/** Longest HTML read; the rest is dropped. Mail bodies that matter are far shorter. */
export const MAX_HTML_CHARS = 300_000;

const MAX_LINK_CHARS = 200;

/** Latin-1 supplement names (U+00A0 to U+00FF), in code point order. */
const LATIN1_ENTITY_NAMES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(
    ' ',
  );

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  hellip: '…',
  euro: '€',
  trade: '™',
  bull: '•',
  dagger: '†',
  permil: '‰',
  lsaquo: '‹',
  rsaquo: '›',
  larr: '←',
  rarr: '→',
  zwnj: '‌',
  zwj: '‍',
  lrm: '‎',
  rlm: '‏',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ...Object.fromEntries(LATIN1_ENTITY_NAMES.map((name, index) => [name, String.fromCodePoint(0xa0 + index)])),
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,12});/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'tr',
  'table',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'br',
  'blockquote',
  'section',
  'article',
  'header',
  'footer',
  'pre',
]);
const CELL_TAGS = new Set(['td', 'th']);
const SKIPPED_BLOCKS = new Set(['script', 'style', 'head', 'title']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'wbr', 'col', 'area', 'base', 'source']);

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isNameChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** Index of the first `needle` (lowercase) at or after `from`, ignoring case; -1 when absent. */
function indexOfLower(input: { text: string; needle: string; from: number }): number {
  const { text, needle } = input;
  let at = text.indexOf('<', input.from);
  while (at !== -1) {
    if (text.slice(at, at + needle.length).toLowerCase() === needle) {
      return at;
    }
    at = text.indexOf('<', at + 1);
  }
  return -1;
}

function attributeValue(input: { tag: string; name: string }): string | null {
  const lower = input.tag.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(input.name, from);
    if (at === -1) {
      return null;
    }
    from = at + input.name.length;
    const before = lower.charCodeAt(at - 1);
    if (at > 0 && isNameChar(before)) {
      continue;
    }
    let cursor = from;
    while (lower[cursor] === ' ') {
      cursor += 1;
    }
    if (lower[cursor] !== '=') {
      return input.name === 'hidden' ? '' : null;
    }
    cursor += 1;
    while (lower[cursor] === ' ') {
      cursor += 1;
    }
    const quote = input.tag[cursor];
    if (quote === '"' || quote === "'") {
      const end = input.tag.indexOf(quote, cursor + 1);
      return input.tag.slice(cursor + 1, end === -1 ? undefined : end);
    }
    let end = cursor;
    while (end < input.tag.length && input.tag[end] !== ' ' && input.tag[end] !== '>') {
      end += 1;
    }
    return input.tag.slice(cursor, end);
  }
}

function isHiddenTag(tag: string): boolean {
  if (attributeValue({ tag, name: 'hidden' }) !== null) {
    return true;
  }
  const style = (attributeValue({ tag, name: 'style' }) ?? '').toLowerCase().replace(/\s+/g, '');
  return (
    style.includes('display:none') ||
    style.includes('visibility:hidden') ||
    style.includes('font-size:0') ||
    style.includes('max-height:0') ||
    style.includes('mso-hide:all')
  );
}

function safeLink(href: string): string | null {
  const decoded = decodeEntities(href).trim();
  return /^(https?:\/\/|mailto:)/i.test(decoded) && decoded.length <= MAX_LINK_CHARS ? decoded : null;
}

/** A readable plain-text version of an HTML body: no scripts, styles, hidden text or tags; links keep their address. */
export function htmlToText(source: string): string {
  const html = source.length > MAX_HTML_CHARS ? source.slice(0, MAX_HTML_CHARS) : source;
  const lastGt = html.lastIndexOf('>');
  // Pieces are joined once at the end: appending to one growing string and testing its tail is quadratic.
  const parts: string[] = [];
  let atLineStart = true;
  let cursor = 0;
  let gtCache = -2;
  let hidden: { name: string; depth: number } | null = null;
  let link: { href: string | null; startPart: number } | null = null;

  const push = (text: string) => {
    if (text !== '') {
      parts.push(text);
      atLineStart = text.endsWith('\n');
    }
  };
  const emit = (text: string) => {
    if (hidden === null) {
      push(text);
    }
  };
  const lineBreak = () => {
    if (parts.length > 0 && !atLineStart) {
      push('\n');
    }
  };

  while (cursor < html.length) {
    const lt = html.indexOf('<', cursor);
    if (lt === -1) {
      emit(html.slice(cursor));
      break;
    }
    emit(html.slice(cursor, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      cursor = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      // A doctype, an Outlook `<![if ...]>` marker or an XML declaration: markup, never text.
      const end = html.indexOf('>', lt + 2);
      cursor = end === -1 ? html.length : end + 1;
      continue;
    }
    const closing = html[lt + 1] === '/';
    const nameStart = lt + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < html.length && isNameChar(html.charCodeAt(nameEnd))) {
      nameEnd += 1;
    }
    if (nameEnd === nameStart || !isLetter(html.charCodeAt(nameStart)) || lt > lastGt) {
      // A lone `<` that opens no tag: it is text.
      emit('<');
      cursor = lt + 1;
      continue;
    }
    if (gtCache < lt) {
      gtCache = html.indexOf('>', lt + 1);
    }
    const nextLt = html.indexOf('<', lt + 1);
    if (gtCache === -1 || (nextLt !== -1 && nextLt < gtCache)) {
      emit('<');
      cursor = lt + 1;
      continue;
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const tag = html.slice(lt, gtCache + 1);
    cursor = gtCache + 1;

    if (!closing && SKIPPED_BLOCKS.has(name)) {
      const end = indexOfLower({ text: html, needle: `</${name}`, from: cursor });
      if (end === -1) {
        break;
      }
      const close = html.indexOf('>', end);
      cursor = close === -1 ? html.length : close + 1;
      continue;
    }
    if (hidden !== null) {
      if (name === hidden.name && !VOID_TAGS.has(name)) {
        hidden.depth += closing ? -1 : 1;
        if (hidden.depth === 0) {
          hidden = null;
        }
      }
      continue;
    }
    if (!closing && !VOID_TAGS.has(name) && isHiddenTag(tag)) {
      hidden = { name, depth: 1 };
      continue;
    }
    if (name === 'a') {
      if (closing && link !== null) {
        const shown = parts.slice(link.startPart).join('').trim();
        if (link.href !== null && !shown.includes(link.href)) {
          push(shown === '' ? link.href : ` (${link.href})`);
        }
        link = null;
      } else if (!closing) {
        link = { href: safeLink(attributeValue({ tag, name: 'href' }) ?? ''), startPart: parts.length };
      }
    } else if (name === 'li' && !closing) {
      lineBreak();
      push('- ');
    } else if (BLOCK_TAGS.has(name)) {
      lineBreak();
    } else if (CELL_TAGS.has(name) && closing) {
      push(' ');
    }
  }
  return decodeEntities(parts.join(''))
    .replace(/[\u00a0\u2002\u2003\u2009]/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

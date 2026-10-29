/**
 * HTML mail to readable text, in one pass that never backtracks, so a crafted message cannot stall the server.
 * Input is capped before anything runs, tags are found with `indexOf`, and nothing here uses a regex that can
 * grow with the length of the input.
 */

import { isTrackingImageLink } from '../../chatImages';

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

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

/** True where an attribute name stops. */
function endsName(char: string | undefined): boolean {
  return isSpace(char) || char === '=' || char === '>' || char === '/';
}

/**
 * The value of one attribute of a start tag, read attribute by attribute so a name inside another
 * attribute's value (a `src` query, an `alt` text, a `style`) never matches. '' for an attribute
 * written without a value; null when the tag does not have it.
 */
function attributeValue(input: { tag: string; name: string }): string | null {
  const { tag } = input;
  let cursor = 1;
  while (cursor < tag.length && !endsName(tag[cursor])) {
    cursor += 1;
  }
  while (cursor < tag.length) {
    while (isSpace(tag[cursor]) || tag[cursor] === '/') {
      cursor += 1;
    }
    if (cursor >= tag.length || tag[cursor] === '>') {
      return null;
    }
    const nameStart = cursor;
    while (cursor < tag.length && !endsName(tag[cursor])) {
      cursor += 1;
    }
    const name = tag.slice(nameStart, cursor).toLowerCase();
    let equals = cursor;
    while (isSpace(tag[equals])) {
      equals += 1;
    }
    let value = '';
    if (tag[equals] === '=') {
      cursor = equals + 1;
      while (isSpace(tag[cursor])) {
        cursor += 1;
      }
      const quote = tag[cursor];
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, cursor + 1);
        value = tag.slice(cursor + 1, end === -1 ? undefined : end);
        cursor = end === -1 ? tag.length : end + 1;
      } else {
        const start = cursor;
        while (cursor < tag.length && !isSpace(tag[cursor]) && tag[cursor] !== '>') {
          cursor += 1;
        }
        value = tag.slice(start, cursor);
      }
    }
    if (name === input.name) {
      return value;
    }
  }
  return null;
}

/** True for a CSS declaration that takes the element's text out of sight. */
function hidesText(input: { property: string; value: string }): boolean {
  const { property, value } = input;
  switch (property) {
    case 'display':
      return value === 'none';
    case 'visibility':
      return value === 'hidden' || value === 'collapse';
    case 'mso-hide':
      return value === 'all';
    case 'font-size':
    case 'max-height':
    case 'opacity':
      return Number.parseFloat(value) === 0;
    default:
      return false;
  }
}

function isHiddenTag(tag: string): boolean {
  if (attributeValue({ tag, name: 'hidden' }) !== null) {
    return true;
  }
  const style = (attributeValue({ tag, name: 'style' }) ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/!important/g, '');
  return style.split(';').some(declaration => {
    const colon = declaration.indexOf(':');
    return colon !== -1 && hidesText({ property: declaration.slice(0, colon), value: declaration.slice(colon + 1) });
  });
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

/** Images this small or smaller on a side are tracking pixels, not pictures anyone would look at. */
const TRACKING_PIXEL_MAX_SIDE = 2;

/** True for a width or height in pixels (a bare number or `px`) no larger than a tracking pixel. */
function tinySide(value: string | null): boolean {
  const size = value === null ? null : /^(\d*\.?\d+)(?:px)?(?:!important)?$/i.exec(value.trim());
  return size?.[1] !== undefined && Number.parseFloat(size[1]) <= TRACKING_PIXEL_MAX_SIDE;
}

/** True for an `<img>` tag drawn so small or so hidden that it can only be there to report the email was opened. */
function isTrackingPixelTag(tag: string): boolean {
  if (tinySide(attributeValue({ tag, name: 'width' })) || tinySide(attributeValue({ tag, name: 'height' }))) {
    return true;
  }
  const style = (attributeValue({ tag, name: 'style' }) ?? '').toLowerCase().replace(/\s/g, '');
  return style.split(';').some(declaration => {
    const colon = declaration.indexOf(':');
    const property = declaration.slice(0, colon);
    const value = declaration.slice(colon + 1);
    switch (colon === -1 ? '' : property) {
      case 'display':
        return value.startsWith('none');
      case 'visibility':
        return value.startsWith('hidden');
      case 'width':
      case 'height':
      case 'max-width':
      case 'max-height':
        return tinySide(value);
      default:
        return false;
    }
  });
}

/** Longest image address kept; longer ones are dropped rather than cut. */
const MAX_IMAGE_LINK_CHARS = 2048;

/** The value of one attribute of a tag; the name must stand alone, so `data-src` does not count as `src`. */
function tagAttribute({ tag, name }: { tag: string; name: string }): string | null {
  const lower = tag.toLowerCase();
  let at = lower.indexOf(name, 4);
  while (at !== -1) {
    const before = lower[at - 1];
    if (before === ' ' || before === '\t' || before === '\n' || before === '\r' || before === '/') {
      let cursor = at + name.length;
      while (lower[cursor] === ' ' || lower[cursor] === '\t' || lower[cursor] === '\n' || lower[cursor] === '\r') {
        cursor += 1;
      }
      if (lower[cursor] === '=') {
        cursor += 1;
        while (lower[cursor] === ' ' || lower[cursor] === '\t' || lower[cursor] === '\n' || lower[cursor] === '\r') {
          cursor += 1;
        }
        const quote = tag[cursor];
        if (quote === '"' || quote === "'") {
          const end = tag.indexOf(quote, cursor + 1);
          return end === -1 ? null : tag.slice(cursor + 1, end);
        }
        // HTML carried inside a JSON string keeps its quotes escaped: `src=\"...\"`.
        const escaped = tag[cursor + 1];
        if (quote === '\\' && (escaped === '"' || escaped === "'")) {
          const closing = `\\${escaped}`;
          const end = tag.indexOf(closing, cursor + 2);
          return end === -1 ? null : tag.slice(cursor + 2, end);
        }
        let end = cursor;
        while (end < tag.length && !/[\s>]/.test(tag.charAt(end))) {
          end += 1;
        }
        return tag.slice(cursor, end);
      }
    }
    at = lower.indexOf(name, at + name.length);
  }
  return null;
}

/** One `<img>` of an HTML body: its web address and its alt text, when the tag gives one. */
export interface HtmlImage {
  url: string;
  alt: string | undefined;
}

/**
 * The `<img>` tags of an HTML body with a web address, once each and in order, at most `max`. Inline
 * (`cid:`) and `data:` images are attachments, not links, and CSS backgrounds and `srcset` are not read.
 * Linear in the input like the rest of this module.
 */
export function htmlImages(input: { source: string; max: number }): HtmlImage[] {
  const html = input.source.length > MAX_HTML_CHARS ? input.source.slice(0, MAX_HTML_CHARS) : input.source;
  const images: HtmlImage[] = [];
  let at = indexOfLower({ text: html, needle: '<img', from: 0 });
  while (at !== -1 && images.length < input.max) {
    const end = html.indexOf('>', at);
    if (end === -1) {
      break;
    }
    const tag = html.slice(at, end + 1);
    const boundary = tag.charCodeAt(4);
    if (!isNameChar(boundary)) {
      const raw = tagAttribute({ tag, name: 'src' });
      const link = raw === null ? '' : decodeEntities(raw).trim();
      if (
        /^https?:\/\//i.test(link) &&
        link.length <= MAX_IMAGE_LINK_CHARS &&
        !images.some(image => image.url === link) &&
        !isTrackingPixelTag(tag) &&
        !isTrackingImageLink(link)
      ) {
        const alt = tagAttribute({ tag, name: 'alt' });
        const altText = alt === null ? '' : decodeEntities(alt).trim();
        images.push({ url: link, alt: altText === '' ? undefined : altText });
      }
    }
    at = indexOfLower({ text: html, needle: '<img', from: end + 1 });
  }
  return images;
}

/** The web addresses of an HTML body's `<img src>` tags, as `htmlImages` finds them. */
export function htmlImageLinks(input: { source: string; max: number }): string[] {
  return htmlImages(input).map(image => image.url);
}

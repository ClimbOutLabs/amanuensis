/**
 * Allow-list sanitiser for an html-format space body before it is handed to the sandboxed iframe
 * in `SpacesView`. The model authors the page; nothing here trusts it. This is a strict
 * allow-list, not a block-list: an element survives only if it is named below, an attribute
 * survives only if it is named for that element (or in the global set), and anything else is
 * removed, elements together with their contents. Links may use only `http`, `https`, `mailto`,
 * or a relative reference, and the only images that survive are `data:` raster images, so no
 * markup that reaches the frame can execute script or fetch anything off-page.
 *
 * SVG drawing elements are allowed so pages can carry inline charts and icons. Animation and
 * script-bearing SVG (SMIL elements, `foreignObject`, nested documents) are not on the list and
 * are removed like everything else unlisted. `xlink:href` is checked by the same rules as `href`.
 *
 * `<style>` elements and inline `style` attributes are kept, with the CSS scrubbed by `scrubCss`:
 * CSS escapes are decoded first so no spelling hides a keyword, then `@import` is dropped and
 * every `url(...)` that is not a same-document fragment or a raster `data:` image, `image-set(...)`
 * and the other fetching functions are replaced by `none`. SVG presentation attributes get the
 * same decoding and a fragment-only rule for any `url(...)`. Output is re-sanitised until it is
 * stable, so markup that only appears after a reparse never reaches the frame.
 *
 * The sandboxed iframe (`sandbox="allow-same-origin"`, no `allow-scripts`) is the primary
 * boundary; this sanitiser is defense in depth so the srcdoc itself never carries anything live.
 *
 * One additive, non-security pass runs alongside: a plain-text `<td>` whose whole content is a
 * bare number gets a `num` class, so the base stylesheet's `td.num` rule right-aligns it without
 * the model having to remember to mark numeric columns itself.
 */

/**
 * Browsers strip ASCII whitespace and C0 control characters before scheme-sniffing a URL (so
 * `"java\tscript:"` still resolves as `javascript:`); strip the same set here before testing
 * rather than encoding raw control characters into the regex itself. Attribute values reach this
 * code already entity-decoded by the HTML parser, so entity-encoded schemes arrive decoded.
 */
function stripUrlNoise(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x1f && !/\s/.test(char)) {
      result += char;
    }
  }
  return result;
}

const ALLOWED_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * A link target survives when it is relative (including fragments, queries, and
 * scheme-relative references, which resolve under the page's own scheme) or when its
 * scheme is on the allow-list. Everything else (`javascript:`, `vbscript:`, `data:`,
 * `file:`, and any other scheme) drops the attribute.
 */
function isAllowedLinkUrl(value: string): boolean {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripUrlNoise(value));
  if (scheme === null) return true;
  return ALLOWED_LINK_SCHEMES.has((scheme[1] ?? '').toLowerCase());
}

/**
 * The only images that survive are raster `data:` URIs. `data:image/svg+xml` is excluded on
 * purpose: an SVG payload is a document, not a picture, and never reaches the frame as an image.
 */
const DATA_RASTER_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)(?:;|,)/i;

function isAllowedImageSrc(value: string): boolean {
  return DATA_RASTER_IMAGE_RE.test(stripUrlNoise(value));
}

/** A same-document fragment reference such as `#icon`, used by `<use>` and `url(#...)`. */
function isFragmentReference(value: string): boolean {
  return stripUrlNoise(value).startsWith('#');
}

/**
 * `<use>` may point at a fragment in the same document or at a raster `data:` image; a remote
 * reference would pull in an outside document and is dropped.
 */
function isAllowedUseReference(value: string): boolean {
  return isFragmentReference(value) || isAllowedImageSrc(value);
}

/**
 * A CSS `url(...)` in a presentation attribute may only name a same-document fragment, with an
 * optional plain-word fallback paint (`url(#grad) red`).
 */
function isFragmentUrl(value: string): boolean {
  return /^url\(\s*(['"]?)#[^'"()\s]*\1\s*\)(?:\s+[a-zA-Z0-9#%.,-][a-zA-Z0-9#%.,\s-]*)?$/i.test(value.trim());
}

/**
 * Decodes CSS escapes so `u\72l(` and `@\69mport` are seen as the browser reads them. Escapes
 * that would yield a backslash, NUL, a surrogate, or an out-of-range code point are dropped or
 * replaced so decoding can never produce a fresh escape.
 */
function decodeCssEscapes(css: string): string {
  const decoded = css.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([\s\S]))/g,
    (_match, hex: string | undefined, newline: string | undefined, char: string | undefined) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        if (code === 0x5c) return '';
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
        return String.fromCodePoint(code);
      }
      if (newline !== undefined) return '';
      return char === '\\' ? '' : (char ?? '');
    },
  );
  return decoded.replaceAll('\\', '');
}

/** Index just past the `)` closing the call whose `(` is at `open`, or the end when unclosed. */
function endOfCssCall({ css, open }: { css: string; open: number }): number {
  let depth = 0;
  let i = open;
  while (i < css.length) {
    const char = css.charAt(i);
    if (char === '"' || char === "'") {
      const close = css.indexOf(char, i + 1);
      const newline = css.slice(i + 1, close === -1 ? css.length : close).search(/[\n\r\f]/);
      if (close === -1 || newline !== -1) return css.length;
      i = close + 1;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return css.length;
}

/** Functions that can fetch or run something; each is replaced by `none` (`url` is vetted below). */
const CSS_CALL_RE = /(image-set|cross-fade|image|src|element|paint|expression|url)\(/gi;

/** The raw target of a well-formed `url(...)` call, or null for anything malformed or unclosed. */
function cssUrlTarget(call: string): string | null {
  if (!call.endsWith(')')) return null;
  const inner = call.slice(call.indexOf('(') + 1, -1).trim();
  const quoted = /^(["'])([^"'\n\r\f]*)\1$/.exec(inner);
  if (quoted !== null) return quoted[2] ?? null;
  return /^[^\s"'()]*$/.test(inner) ? inner : null;
}

function isAllowedCssUrl(call: string): boolean {
  const target = cssUrlTarget(call);
  if (target === null) return false;
  return isFragmentReference(target) || isAllowedImageSrc(target);
}

function scrubCssOnce(css: string): string {
  // `<` is never needed in CSS and would let a decoded `</style>` end the element on reparse.
  let result = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '').replaceAll('<', '');
  result = decodeCssEscapes(result);
  result = result.replace(/@import[^;{}]*;?/gi, '');
  result = result.replace(/(?:-moz-binding|behavior)\s*:[^;}]*;?/gi, '');

  let out = '';
  let position = 0;
  CSS_CALL_RE.lastIndex = 0;
  for (let match = CSS_CALL_RE.exec(result); match !== null; match = CSS_CALL_RE.exec(result)) {
    const end = endOfCssCall({ css: result, open: match.index + match[0].length - 1 });
    const call = result.slice(match.index, end);
    const keep = (match[1] ?? '').toLowerCase() === 'url' && isAllowedCssUrl(call);
    out += result.slice(position, match.index) + (keep ? call : 'none');
    position = end;
    CSS_CALL_RE.lastIndex = end;
  }
  return out + result.slice(position);
}

/** Longest scrub chain tried before giving up; real CSS settles after one or two passes. */
const MAX_CSS_PASSES = 4;

/**
 * One CSS scrubber for both `<style>` blocks and inline `style` attributes, so there is a single
 * place that decides what CSS may reach off-page. It runs to a fixed point: what the browser
 * parses is exactly what was scanned, and a value that never settles is dropped.
 */
function scrubCss(css: string): string {
  let current = css;
  for (let pass = 0; pass < MAX_CSS_PASSES; pass += 1) {
    const next = scrubCssOnce(current);
    if (next === current) return current;
    current = next;
  }
  return '';
}

/** True when an SVG attribute value, read as CSS, holds nothing that can fetch off-page. */
function isSafePresentationValue(value: string): boolean {
  const decoded = decodeCssEscapes(value);
  CSS_CALL_RE.lastIndex = 0;
  return !CSS_CALL_RE.test(decoded) || isFragmentUrl(decoded);
}

/**
 * A cell counts as a bare number once its whitespace is trimmed: digits plus the punctuation a
 * number is written with (thousands separators, a decimal point, a leading `+`/`-`, a trailing
 * `%`, a leading currency symbol, or parens for an accounting negative like `(1,234.50)`).
 * Anything with other text (a unit word, a mixed cell) does not qualify. The parens are matched
 * as one alternative wrapping the whole number rather than two independently-optional characters,
 * so a stray unbalanced paren (`"123)"`) does not qualify either.
 */
const NUMBER_BODY = String.raw`(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?%?`;
const PURE_NUMBER_CELL_RE = new RegExp(`^[+-]?[$€£¥]?(?:${NUMBER_BODY}|\\(${NUMBER_BODY}\\))$`);

function isPureNumberCell(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && PURE_NUMBER_CELL_RE.test(trimmed);
}

/**
 * Adds the `num` class to a `<td>` whose entire content is a bare number. Only plain-text cells
 * qualify: one with child markup (a nested `<span>`, a badge) is left exactly as the model wrote
 * it rather than guessed at.
 */
function classifyNumericCell(cell: Element): void {
  if (cell.children.length > 0) return;
  if (!isPureNumberCell(cell.textContent ?? '')) return;
  const classes = new Set((cell.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
  classes.add('num');
  cell.setAttribute('class', Array.from(classes).join(' '));
}

/** Attributes every allowed element may carry. `style` is scrubbed before it is kept. */
const GLOBAL_ATTRIBUTES = new Set(['class', 'id', 'title', 'lang', 'dir', 'hidden', 'role', 'tabindex', 'style']);

function isGlobalAttribute(name: string): boolean {
  return GLOBAL_ATTRIBUTES.has(name) || name.startsWith('aria-') || name.startsWith('data-');
}

/** Presentation attributes shared by the SVG drawing elements. */
const SVG_PRESENTATION_ATTRIBUTES = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'fill-opacity',
  'stroke-opacity',
  'fill-rule',
  'clip-rule',
  'opacity',
  'transform',
  'color',
  'visibility',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'clip-path',
  'mask',
];

/**
 * The element allow-lists, one per namespace: tag name to the attributes that element may carry
 * beyond the global set. HTML and SVG share tag names (`a`, `style`, `title`) but not rules, so
 * they never share an entry. SVG tag names are spelled as parsed (`clipPath`, `linearGradient`,
 * ...). An HTML element absent from its list is unwrapped: its tag goes and its sanitised children
 * stay, so wording in `del`, `label` or `center` is never lost. Elements in `DROPPED_HTML_ELEMENTS`,
 * unlisted SVG elements and anything in another namespace (MathML, unknown) are removed with their
 * contents.
 */
const HTML_ELEMENTS = new Map<string, ReadonlySet<string>>();

/** HTML elements whose contents are code, embedded documents or hidden payloads, never page text. */
const DROPPED_HTML_ELEMENTS: ReadonlySet<string> = new Set([
  'applet',
  'embed',
  'frame',
  'frameset',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'object',
  'script',
  'template',
  'title',
]);
const SVG_ELEMENTS = new Map<string, ReadonlySet<string>>();

function allowElement(tag: string, attributes: readonly string[]): void {
  HTML_ELEMENTS.set(tag, new Set(attributes));
}

function allowSvgElement(tag: string, attributes: readonly string[]): void {
  SVG_ELEMENTS.set(tag, new Set([...SVG_PRESENTATION_ATTRIBUTES, ...attributes]));
}

// Text, structure, and formatting.
for (const tag of [
  'abbr',
  'address',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'dd',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'header',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'kbd',
  'main',
  'mark',
  'nav',
  'p',
  'pre',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'u',
  'var',
  'wbr',
]) {
  allowElement(tag, []);
}
allowElement('a', ['href', 'target', 'rel']);
allowElement('blockquote', ['cite']);
allowElement('q', ['cite']);
allowElement('data', ['value']);
allowElement('time', ['datetime']);
allowElement('details', ['open']);
allowElement('summary', []);
// Kept with its CSS scrubbed by scrubCss; see the file header.
allowElement('style', []);

// Lists.
allowElement('ul', []);
allowElement('ol', ['start', 'reversed', 'type']);
allowElement('li', ['value']);

// Tables.
allowElement('table', []);
allowElement('caption', []);
allowElement('colgroup', ['span']);
allowElement('col', ['span']);
allowElement('thead', []);
allowElement('tbody', []);
allowElement('tfoot', []);
allowElement('tr', []);
allowElement('td', ['colspan', 'rowspan', 'headers']);
allowElement('th', ['colspan', 'rowspan', 'headers', 'scope', 'abbr']);

// Images: raster `data:` URIs only; the element itself is dropped when `src` is anything else.
allowElement('picture', []);
allowElement('img', ['src', 'alt', 'width', 'height']);

// SVG drawing elements, without scripts or animation.
allowSvgElement('svg', ['viewBox', 'preserveAspectRatio', 'width', 'height', 'xmlns']);
allowSvgElement('g', []);
allowSvgElement('defs', []);
allowSvgElement('switch', []);
allowSvgElement('symbol', ['viewBox', 'preserveAspectRatio']);
allowSvgElement('style', []);
allowSvgElement('title', []);
allowSvgElement('desc', []);
allowSvgElement('a', ['href', 'xlink:href', 'target', 'rel']);
allowSvgElement('path', ['d', 'pathLength']);
allowSvgElement('line', ['x1', 'y1', 'x2', 'y2']);
allowSvgElement('rect', ['x', 'y', 'width', 'height', 'rx', 'ry']);
allowSvgElement('circle', ['cx', 'cy', 'r']);
allowSvgElement('ellipse', ['cx', 'cy', 'rx', 'ry']);
allowSvgElement('polyline', ['points']);
allowSvgElement('polygon', ['points']);
allowSvgElement('text', ['x', 'y', 'dx', 'dy', 'rotate']);
allowSvgElement('tspan', ['x', 'y', 'dx', 'dy', 'rotate']);
allowSvgElement('textPath', ['href', 'xlink:href', 'startOffset']);
allowSvgElement('use', ['href', 'xlink:href', 'x', 'y', 'width', 'height']);
allowSvgElement('image', ['href', 'xlink:href', 'x', 'y', 'width', 'height', 'preserveAspectRatio']);
allowSvgElement('linearGradient', ['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod']);
allowSvgElement('radialGradient', [
  'cx',
  'cy',
  'r',
  'fx',
  'fy',
  'fr',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
]);
allowSvgElement('stop', ['offset', 'stop-color', 'stop-opacity']);
allowSvgElement('clipPath', ['clipPathUnits']);
allowSvgElement('pattern', [
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  'x',
  'y',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
]);
allowSvgElement('marker', [
  'markerUnits',
  'markerWidth',
  'markerHeight',
  'refX',
  'refY',
  'orient',
  'viewBox',
  'preserveAspectRatio',
]);
allowSvgElement('mask', ['maskUnits', 'maskContentUnits', 'x', 'y', 'width', 'height']);

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

function allowedAttributesFor(element: Element): ReadonlySet<string> | undefined {
  if (element.namespaceURI === HTML_NAMESPACE) return HTML_ELEMENTS.get(element.localName);
  if (element.namespaceURI === SVG_NAMESPACE) return SVG_ELEMENTS.get(element.localName);
  return undefined;
}

/**
 * How a URL-bearing attribute is checked, by element and attribute. `link` is an ordinary
 * navigable reference, `use-reference` may only name a fragment or a raster `data:` image,
 * and `fragment` may only name a fragment in the same document.
 */
type UrlRule = 'link' | 'use-reference' | 'fragment';

function urlRuleFor({ tag, attribute }: { tag: string; attribute: string }): UrlRule | null {
  if (attribute === 'href' || attribute === 'xlink:href') {
    if (tag === 'a') return 'link';
    if (tag === 'use') return 'use-reference';
    if (tag === 'textPath') return 'fragment';
    return null;
  }
  if (attribute === 'cite' && (tag === 'blockquote' || tag === 'q')) return 'link';
  return null;
}

function urlPasses(rule: UrlRule, value: string): boolean {
  if (rule === 'link') return isAllowedLinkUrl(value);
  if (rule === 'use-reference') return isAllowedUseReference(value);
  return isFragmentReference(value);
}

/** Drops the tag and keeps its children, sanitised first so nothing unsafe is promoted. */
function unwrapElement(element: Element): void {
  for (const child of Array.from(element.children)) {
    sanitiseElement(child);
  }
  element.replaceWith(...Array.from(element.childNodes));
}

function sanitiseElement(element: Element): void {
  const tag = element.localName;
  const allowedAttributes = allowedAttributesFor(element);
  if (allowedAttributes === undefined) {
    if (element.namespaceURI === HTML_NAMESPACE && !DROPPED_HTML_ELEMENTS.has(tag)) {
      unwrapElement(element);
    } else {
      element.remove();
    }
    return;
  }

  // An image whose source is not a raster `data:` URI is dropped whole rather than left as a
  // broken frame; the same rule covers `<image>` inside SVG, through either href spelling.
  if (tag === 'img') {
    const src = element.getAttribute('src');
    if (src === null || !isAllowedImageSrc(src)) {
      element.remove();
      return;
    }
  }
  if (tag === 'image') {
    for (const name of ['href', 'xlink:href']) {
      const value = element.getAttribute(name);
      if (value !== null && !isAllowedImageSrc(value)) {
        element.remove();
        return;
      }
    }
  }

  if (tag === 'style') {
    element.textContent = scrubCss(element.textContent ?? '');
  }

  // Snapshot before mutating: `attributes` is a live NamedNodeMap.
  for (const attr of Array.from(element.attributes)) {
    const name = attr.name;
    const lowerName = name.toLowerCase();
    if (!allowedAttributes.has(name) && !isGlobalAttribute(lowerName)) {
      element.removeAttribute(name);
      continue;
    }
    if (name === 'style') {
      element.setAttribute('style', scrubCss(attr.value));
      continue;
    }
    const rule = urlRuleFor({ tag, attribute: name });
    if (rule !== null && !urlPasses(rule, attr.value)) {
      element.removeAttribute(name);
      continue;
    }
    // SVG presentation attributes are parsed as CSS: any value that can fetch is fragment-only.
    if (
      element.namespaceURI === SVG_NAMESPACE &&
      rule === null &&
      !isGlobalAttribute(lowerName) &&
      !isSafePresentationValue(attr.value)
    ) {
      element.removeAttribute(name);
      continue;
    }
    if (name === 'xmlns' && attr.value !== SVG_NAMESPACE) {
      element.removeAttribute(name);
      continue;
    }
  }

  if (tag === 'td') {
    classifyNumericCell(element);
  }

  // Snapshot before recursing: sanitising a child can remove it, so iterate over a static copy
  // of the live children. This walks the whole kept tree, including nested SVG.
  for (const child of Array.from(element.children)) {
    sanitiseElement(child);
  }
}

function sanitizeOnce(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const child of Array.from(doc.body.children)) {
    sanitiseElement(child);
  }
  // Elements parsed into <head> (e.g. a bare "<style>...</style>" before any other markup) must
  // be swept too, not just what DOMParser placed under <body>.
  for (const child of Array.from(doc.head.children)) {
    sanitiseElement(child);
  }
  return doc.head.innerHTML + doc.body.innerHTML;
}

/** Re-sanitise passes tried before a page is treated as unstable and rejected. */
const MAX_REPARSE_PASSES = 4;

/**
 * Returns `null` when no DOM parser is available (e.g. during server rendering) or when the
 * output does not settle: serialised markup can parse into a different tree (mutation XSS), so
 * the result is sanitised again until a pass changes nothing. Callers should skip the iframe on
 * `null` rather than render unsanitised content.
 */
export function sanitizeSpaceHtml(html: string): string | null {
  if (typeof DOMParser === 'undefined') return null;
  let current = sanitizeOnce(html);
  for (let pass = 0; pass < MAX_REPARSE_PASSES; pass += 1) {
    const next = sanitizeOnce(current);
    if (next === current) return current;
    current = next;
  }
  return null;
}

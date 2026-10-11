/**
 * Allow-list sanitiser for an html-format space body before it is handed to the sandboxed iframe
 * in `SpacesView`. The model authors the page; nothing here trusts it. Strips everything capable
 * of executing script or reaching off-page. No off-page fetch is left standing on purpose:
 * only a `data:` URI survives on `<img src>`; anything else drops the image entirely
 * rather than leaving a broken reference to strip later.
 *
 * Everything else that could reach off-page is removed:
 *   - `<script>`, `<link>`, `<iframe>`, `<object>`, `<embed>`, `<meta>`, `<base>`.
 *   - `on*` event-handler attributes, and `javascript:` URLs in `href`/`src`/`action`/`formaction`.
 *   - `srcset` on any element (including `<source>` inside `<picture>`), which can
 *     carry remote image candidates even when `src` is a `data:` URI.
 *   - `<image href>` inside `<svg>`, `<video poster>`, `<input type=image src>`,
 *     and the `background` attribute on table cells, all of which can trigger
 *     an off-page fetch.
 *   - every CSS `url(...)` whose target is not a `data:` URI, in both `<style>` blocks and inline
 *     `style` attributes; CSS `image-set(...)` is dropped outright because every
 *     branch can carry a remote URL.
 *   - CSS `expression(...)` and `-moz-binding` declarations.
 * `<style>` elements and inline `style` attributes are otherwise kept as written.
 *
 * The sandboxed iframe (`sandbox="allow-same-origin"`, no `allow-scripts`) is the primary boundary; this sanitiser
 * is defense in depth so the srcdoc itself never carries anything live, and so a viewer who reads
 * the page source sees the same inert markup the sandbox already prevents from running.
 *
 * Beyond that allow-list, one additive, non-security pass runs alongside it: a plain-text `<td>`
 * whose whole content is a bare number gets a `num` class, so the base stylesheet's `td.num` rule
 * right-aligns it without the model having to remember to mark numeric columns itself.
 */

const DISALLOWED_ELEMENT_TAGS = ['script', 'link', 'iframe', 'object', 'embed', 'meta', 'base'];

/**
 * Browsers strip ASCII whitespace and C0 control characters before scheme-sniffing a URL (so
 * `"java\tscript:"` still resolves as `javascript:`); strip the same set here before testing
 * rather than encoding raw control characters into the regex itself.
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

function isJavascriptUrl(value: string): boolean {
  return /^javascript:/i.test(stripUrlNoise(value));
}

function isAllowedImageSrc(value: string): boolean {
  return /^data:/i.test(value);
}

/**
 * One CSS scrubber for both `<style>` blocks and inline `style` attributes, so there is a single
 * place that decides what CSS may reach off-page rather than a special case per property.
 *
 *   - `@import` at-rules are dropped whole: their target is external by construction.
 *   - every remaining `url(...)` is neutralised unless its target is a `data:` URI, covering
 *     `background`, `background-image`, `cursor`, `list-style-image`, `border-image`, `mask`,
 *     `content`, and any other property that can carry a `url()` — not just `@import`.
 *   - `image-set(...)` is dropped outright: every branch can carry a remote URL, and
 *     allowlisting per-branch `data:` URIs is not worth the parsing risk.
 *   - `expression(...)` (legacy IE script-in-CSS) and `-moz-binding` (legacy Gecko XBL, which can
 *     load an external binding document) are stripped too.
 */
function scrubCss(css: string): string {
  let result = css.replace(/@import\b[^;]*;?/gi, '');
  result = result.replace(/image-set\s*\([^)]*\)/gi, 'none');
  result = result.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (match, _quote: string, target: string) =>
    /^data:/i.test(target.trim()) ? match : 'none',
  );
  result = result.replace(/expression\s*\([^)]*\)/gi, 'none');
  result = result.replace(/-moz-binding\s*:[^;]*;?/gi, '');
  return result;
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

function sanitiseElement(element: Element): void {
  const tag = element.tagName.toLowerCase();
  if (DISALLOWED_ELEMENT_TAGS.includes(tag)) {
    element.remove();
    return;
  }

  if (tag === 'img') {
    const src = element.getAttribute('src');
    if (src === null || !isAllowedImageSrc(src)) {
      element.remove();
      return;
    }
    // srcset can carry remote candidates even when src is a data: URI.
    element.removeAttribute('srcset');
  }

  // <source srcset> inside <picture> is another remote-image vector.
  if (tag === 'source') {
    element.removeAttribute('srcset');
    element.removeAttribute('src');
  }

  // <image href> inside <svg> can trigger an off-page fetch.
  if (tag === 'image') {
    element.removeAttribute('href');
    const href = element.getAttribute('xlink:href');
    if (href !== null) {
      element.removeAttribute('xlink:href');
    }
  }

  if (tag === 'style') {
    element.textContent = scrubCss(element.textContent ?? '');
  }

  if (tag === 'td') {
    classifyNumericCell(element);
  }

  // Snapshot before mutating: `attributes` is a live NamedNodeMap.
  for (const attr of Array.from(element.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on')) {
      element.removeAttribute(attr.name);
      continue;
    }
    if (
      (name === 'href' || name === 'src' || name === 'action' || name === 'formaction') &&
      isJavascriptUrl(attr.value)
    ) {
      element.removeAttribute(attr.name);
      continue;
    }
    // srcset on any element (img, source, etc.) can carry remote URLs.
    if (name === 'srcset') {
      element.removeAttribute(attr.name);
      continue;
    }
    // <video poster> triggers an off-page fetch for the poster image.
    if (name === 'poster') {
      element.removeAttribute(attr.name);
      continue;
    }
    // The background attribute on table cells (and other elements) fetches a remote image.
    if (name === 'background') {
      element.removeAttribute(attr.name);
      continue;
    }
    if (name === 'style') {
      element.setAttribute('style', scrubCss(attr.value));
    }
  }

  // <input type=image> uses src as a remote image button; strip the src so it
  // cannot fetch, but keep the element itself.
  if (tag === 'input' && element.getAttribute('type')?.toLowerCase() === 'image') {
    element.removeAttribute('src');
  }

  // Snapshot before recursing: sanitising a child can remove it (e.g. a nested <script>) or,
  // for <img>, replace the traversal target — iterate over a static copy of the live children.
  for (const child of Array.from(element.children)) {
    sanitiseElement(child);
  }
}

/**
 * Returns `null` when no DOM parser is available (e.g. during server rendering); callers should
 * skip the iframe in that case rather than render unsanitised content.
 */
export function sanitizeSpaceHtml(html: string): string | null {
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const child of Array.from(doc.body.children)) {
    sanitiseElement(child);
  }
  // <script>/<style> parsed into <head> (e.g. a bare "<script>...</script>" before any other
  // markup) must be swept too, not just what DOMParser placed under <body>.
  for (const child of Array.from(doc.head.children)) {
    sanitiseElement(child);
  }
  return doc.head.innerHTML + doc.body.innerHTML;
}

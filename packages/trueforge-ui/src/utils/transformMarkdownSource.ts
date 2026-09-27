/**
 * Pre-parse source transforms applied before ReactMarkdown parses the message; the stored message
 * is untouched. Both rewrites below run per non-code segment of {@link scanMarkdownSegments}, so
 * fenced code blocks and inline code spans are never touched:
 *
 * - Unicode-hyphen bullets: a gpt-oss habit the remark AST pass in
 *   {@link normalizeProseTypography} cannot fix, since it changes what markdown parses into
 *   rather than a text node's characters. CommonMark's list parser only recognises ASCII `-`,
 *   `+`, `*` as bullet markers, so a leading U+2010/U+2011 hyphen is rewritten to ASCII. A bullet
 *   directly after a `<br>` with no blank line is not "leading" until
 *   {@link insertNewlineBeforeBulletAfterBr} gives it one; the `<br>` itself renders via
 *   `rehype-raw` (see Markdown.tsx), untouched here.
 * - LaTeX-style `\[ ... \]` / `\( ... \)` math delimiters: some models (gpt-oss in particular)
 *   emit math this way instead of `$`/`$$`, which is what `remark-math` recognises; see
 *   {@link rewriteDisplayMath} and {@link rewriteInlineMath}.
 */

export type MarkdownSourceSegment = {
  text: string;
  /** True when this segment falls inside a fenced code block or an inline code span. */
  inCode: boolean;
};

// A fence line, after any blockquote prefix has been stripped: up to 3 leading spaces, then 3+
// of the same fence character (backtick or tilde), then an info string.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// Up to 3 leading spaces of blockquote-marker prefix (`>`, optionally repeated for nesting, each
// optionally followed by one space/tab), stripped only to test for a fence line underneath: the
// full raw line (prefix included) is still what gets pushed as a segment.
const QUOTE_PREFIX_RE = /^(?: {0,3}>[ \t]?)+/;

function stripQuotePrefix(line: string): string {
  const match = QUOTE_PREFIX_RE.exec(line);
  return match ? line.slice(match[0].length) : line;
}

type FenceOpen = { char: string; len: number };

/**
 * Matches a fence-opening line (after blockquote-prefix stripping and `\r` stripping). Backtick
 * fences additionally require no backtick anywhere in the info string, matching CommonMark: a
 * later backtick on that line means the line is not a valid backtick-fence opener (tilde fences
 * have no such restriction).
 */
function matchFenceOpen(rest: string): FenceOpen | null {
  const match = FENCE_OPEN_RE.exec(rest);
  if (!match) return null;
  const run = match[1]!;
  const char = run[0]!;
  const infoString = match[2]!;
  if (char === '`' && infoString.includes('`')) return null;
  return { char, len: run.length };
}

function isClosingFence(rest: string, fence: FenceOpen): boolean {
  const re = new RegExp(`^ {0,3}${fence.char}{${fence.len},} *$`);
  return re.test(rest);
}

/** Strips a `\r` immediately before end-of-line so CRLF input still matches fence regexes. */
function stripTrailingCr(text: string): string {
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/**
 * Splits markdown source into segments tagged by whether they fall inside a fenced code block
 * (backtick or tilde, including one nested in a blockquote) or an inline backtick code span, so a
 * pre-parse transform can skip code and only touch prose. This is a lightweight scanner, not a
 * full CommonMark tokenizer, but it does track: fence character/length and blockquote prefixes
 * for fenced blocks (line-by-line, since fences always occupy a whole line), backslash-escaped
 * backticks, and inline code spans that continue across line breaks within the same prose block
 * (stopping at a blank line, matching CommonMark's rule that a code span cannot cross a paragraph
 * break).
 */
export function scanMarkdownSegments(source: string): MarkdownSourceSegment[] {
  const segments: MarkdownSourceSegment[] = [];

  const push = (text: string, inCode: boolean) => {
    if (text.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.inCode === inCode) {
      last.text += text;
    } else {
      segments.push({ text, inCode });
    }
  };

  const lines = source.split('\n');
  const lastLineIdx = lines.length - 1;
  const lineWithSuffix = (idx: number) => lines[idx]! + (idx < lastLineIdx ? '\n' : '');
  const testableRest = (line: string) => stripTrailingCr(stripQuotePrefix(line));

  let inFence = false;
  let fence: FenceOpen = { char: '', len: 0 };
  let lineIdx = 0;

  while (lineIdx < lines.length) {
    const line = lines[lineIdx]!;

    if (inFence) {
      push(lineWithSuffix(lineIdx), true);
      if (isClosingFence(testableRest(line), fence)) inFence = false;
      lineIdx += 1;
      continue;
    }

    const openMatch = matchFenceOpen(testableRest(line));
    if (openMatch) {
      inFence = true;
      fence = openMatch;
      push(lineWithSuffix(lineIdx), true);
      lineIdx += 1;
      continue;
    }

    // Gather a run of consecutive non-fence lines and scan it as one prose block, so an inline
    // code span (or a run of ordinary text) can be recognized even when it continues onto the
    // next line.
    let end = lineIdx;
    while (end < lines.length && !matchFenceOpen(testableRest(lines[end]!))) end += 1;
    const proseText = lines
      .slice(lineIdx, end)
      .map((_, offset) => lineWithSuffix(lineIdx + offset))
      .join('');
    scanInlineCode(proseText, push);
    lineIdx = end;
  }

  return segments;
}

/** True when the character at `idx` is preceded by an odd (unbalanced) run of backslashes. */
function isEscapedAt(text: string, idx: number): boolean {
  let count = 0;
  let i = idx - 1;
  while (i >= 0 && text[i] === '\\') {
    count += 1;
    i -= 1;
  }
  return count % 2 === 1;
}

/**
 * Scans a block of prose (no fenced code in it) for backtick-delimited inline code spans,
 * pushing code and non-code segments via `push`. A code span may continue across a line break,
 * matching CommonMark, but not across a blank line, since that ends the containing block.
 * Backtick runs preceded by an odd number of backslashes are escaped and never open or close a
 * span (an escaped backtick renders as a literal character, per CommonMark).
 */
function scanInlineCode(text: string, push: (text: string, inCode: boolean) => void): void {
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      let next = text.indexOf('`', i);
      if (next === -1) next = text.length;
      push(text.slice(i, next), false);
      i = next;
      continue;
    }

    if (isEscapedAt(text, i)) {
      push(text[i]!, false);
      i += 1;
      continue;
    }

    let openEnd = i;
    while (text[openEnd] === '`') openEnd += 1;
    const openLen = openEnd - i;

    let k = openEnd;
    let closeStart = -1;
    while (k < text.length) {
      // A blank line (two consecutive newlines, or a CRLF pair "\r\n\r\n") ends the containing
      // block; a code span cannot cross it, so stop searching for a closer.
      if (text[k] === '\n' && (text[k + 1] === '\n' || (text[k + 1] === '\r' && text[k + 2] === '\n'))) break;

      if (text[k] === '`') {
        // Unlike the opening delimiter (checked outside a code span, where a backslash still
        // escapes), backslashes are literal once inside a code span per CommonMark: a matching
        // backtick run always closes the span, even immediately after a backslash.
        let runEnd = k;
        while (text[runEnd] === '`') runEnd += 1;
        if (runEnd - k === openLen) {
          closeStart = k;
          k = runEnd;
          break;
        }
        k = runEnd;
      } else {
        k += 1;
      }
    }

    if (closeStart >= 0) {
      push(text.slice(i, closeStart + openLen), true);
      i = closeStart + openLen;
    } else {
      // No matching closing run before the block ends: the backtick run is not an inline code
      // span, so only the run itself is emitted here; scanning resumes right after it.
      push(text.slice(i, openEnd), false);
      i = openEnd;
    }
  }
}

// "<br>", "<br/>", "<br />": case-insensitive, optional whitespace before the closing angle
// bracket and around the self-closing slash. Used only to find a <br> that sits directly before a
// unicode-hyphen bullet; see {@link insertNewlineBeforeBulletAfterBr}. Rendering `<br>` itself is
// handled by rehype-raw in Markdown.tsx, not by this module.
const BR_TAG_SOURCE = '<br\\s*\\/?\\s*>';

// A <br> tag immediately followed (optionally after horizontal whitespace) by a unicode-hyphen
// bullet: matched so a newline can be inserted between them, making the bullet "leading"; see
// {@link insertNewlineBeforeBulletAfterBr}.
const BR_THEN_BULLET_RE = new RegExp(`(${BR_TAG_SOURCE})([ \\t]*)(?=[\\u2010\\u2011] )`, 'gi');

// Start of line, optional leading whitespace, then a unicode hyphen immediately followed by a
// space: the shape gpt-oss emits for a bullet the CommonMark list parser does not recognise.
// Written as \u escapes (not literal characters), matching normalizeProseTypography.ts, so the
// source file itself does not carry invisible/irregular characters.
const HYPHEN_BULLET_RE = /^([ \t]*)[\u2010\u2011](?= )/gm;

/**
 * Inserts a newline between a `<br>` tag and a unicode-hyphen bullet that immediately follows it
 * on the same source line (gpt-oss often emits `<br>` directly before a bullet with no blank
 * line). Without this, the bullet is not at the start of any source line, not "leading", so
 * {@link HYPHEN_BULLET_RE} never matches it and CommonMark's list parser never sees it as a
 * bullet at all; the `<br>` itself still renders as a real line break via rehype-raw regardless,
 * but the text after it would otherwise stay part of the same paragraph as plain prose instead of
 * becoming its own list.
 */
function insertNewlineBeforeBulletAfterBr(text: string): string {
  return text.replace(BR_THEN_BULLET_RE, (_match, brTag: string, spacing: string) => `${brTag}\n${spacing}`);
}

// A container token at the start of a line: indentation, a blockquote marker (optionally
// repeated for nesting, handled by the loop in `parseContainerPrefix`), or a list marker.
const CONTAINER_TOKEN_RE = /^(?:[ \t]+|>[ \t]?|[-*+][ \t]|\d+[.)][ \t])/;

/**
 * Parses a leading run of container tokens from `line` (indentation, blockquote markers, list
 * markers, possibly nested). Returns the run verbatim as `prefix`, plus `continuation`: the form
 * used on every other line of a `$$` block so it stays inside the same list item or blockquote.
 * Blockquote markers and plain indentation are kept as-is; list markers become spaces of the same
 * width, since repeating the marker would start a new list item instead of continuing this one.
 */
function parseContainerPrefix(line: string): { prefix: string; continuation: string } {
  let rest = line;
  let prefix = '';
  let continuation = '';
  for (;;) {
    const match = CONTAINER_TOKEN_RE.exec(rest);
    if (!match) break;
    const token = match[0]!;
    prefix += token;
    continuation += /^[ \t]+$/.test(token) || token.startsWith('>') ? token : ' '.repeat(token.length);
    rest = rest.slice(token.length);
  }
  return { prefix, continuation };
}

// Non-greedy: pairs each `\[`/`\(` with its nearest following closer (display math routinely
// spans several lines), so an unmatched opener never matches at all.
const DISPLAY_MATH_RE = /\\\[([\s\S]*?)\\\]/g;
const INLINE_MATH_RE = /\\\(([\s\S]*?)\\\)/g;

/**
 * Rewrites `\[ ... \]` to a `$$` display-math block, but only when the opener is the first
 * non-container token on its line and the closer is the last token on its line (across one or
 * more lines): a mid-line `\[ ... \]` is CommonMark's escaped brackets (a citation like `\[1\]`,
 * `array\[i\]`), not math, and stays literal. A container prefix on the opener's line (list or
 * blockquote markers, see `parseContainerPrefix`) is carried onto every emitted line of the block
 * so it stays inside the same item or quote; with no container, the block is wrapped in blank
 * lines instead so it parses as its own block. Content containing `\(`/`\)` stays literal:
 * overlapping delimiter pairs are not math.
 */
function rewriteDisplayMath(text: string): string {
  return text.replace(DISPLAY_MATH_RE, (match: string, inner: string, offset: number) => {
    if (inner.includes('\\(') || inner.includes('\\)')) return match;

    const openStart = offset;
    const closeEnd = offset + match.length;

    const lineStart = text.lastIndexOf('\n', openStart - 1) + 1;
    const beforeOpener = text.slice(lineStart, openStart);
    const { prefix, continuation } = parseContainerPrefix(beforeOpener);
    if (prefix !== beforeOpener) return match;

    let lineEnd = text.indexOf('\n', closeEnd);
    if (lineEnd === -1) lineEnd = text.length;
    if (text.slice(closeEnd, lineEnd).trim() !== '') return match;

    const trimmedInner = inner.trim();
    if (prefix === '') {
      // No container prefix; avoid adding an extra leading newline at file start
      const leading = openStart === 0 ? '' : '\n\n';
      return `${leading}$$\n${trimmedInner}\n$$\n\n`;
    }

    const bodyLines = trimmedInner.split('\n').map(line => `${continuation}${line}`);
    return ['$$', ...bodyLines, `${continuation}$$`].join('\n');
  });
}

/**
 * Rewrites `\( ... \)` to an inline `$$...$$` run (two dollar signs, not one: this package
 * disables `singleDollarTextMath` in its `remark-math` config in Markdown.tsx, so a lone `$` in
 * ordinary prose is never mistaken for math, but a double-dollar run still opens inline math
 * regardless). Content containing `\[`, `\]`, or a newline stays literal: a multi-line span, or
 * one that overlaps a `\[ ... \]` pair, is not the single-line inline math this delimiter is for.
 */
function rewriteInlineMath(text: string): string {
  return text.replace(INLINE_MATH_RE, (match: string, inner: string) => {
    if (inner.includes('\\[') || inner.includes('\\]') || inner.includes('\n')) return match;
    return `$$${inner.trim()}$$`;
  });
}

/**
 * Applies both pre-parse rewrites (see the module doc comment) to `source`, segment by segment,
 * so fenced code and inline code spans are left untouched. Call this before handing the string to
 * the markdown parser; it does not touch the stored/persisted message.
 */
export function transformMarkdownSource(source: string): string {
  const segments = scanMarkdownSegments(source);
  return segments
    .map(segment => {
      if (segment.inCode) return segment.text;
      const withMath = rewriteInlineMath(rewriteDisplayMath(segment.text));
      return insertNewlineBeforeBulletAfterBr(withMath).replace(HYPHEN_BULLET_RE, '$1-');
    })
    .join('');
}

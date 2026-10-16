export type LinkSegment =
  { kind: 'text'; start: number; text: string } | { kind: 'link'; start: number; text: string; href: string };

const URL_CANDIDATE = /https:\/\/[^\s<>"'`]+/gi;
const SENTENCE_PUNCTUATION = '.,;:!?';
const BRACKET_OPENERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

function occurrences({ text, char }: { text: string; char: string }): number {
  return text.split(char).length - 1;
}

/** Drops punctuation that ends the surrounding sentence, keeping a closing bracket the URL itself balances. */
function trimTrailingPunctuation(candidate: string): string {
  let url = candidate;
  while (url !== '') {
    const last = url.slice(-1);
    const opener = BRACKET_OPENERS[last];
    const unbalancedCloser =
      opener !== undefined && occurrences({ text: url, char: last }) > occurrences({ text: url, char: opener });
    if (!SENTENCE_PUNCTUATION.includes(last) && !unbalancedCloser) {
      break;
    }
    url = url.slice(0, -1);
  }
  return url;
}

/** The normalized href of a well-formed https URL without credentials, else undefined. */
function toHttpsHref(candidate: string): string | undefined {
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Splits text into plain and link segments whose texts concatenate back to the input. Only
 * well-formed https URLs become links; any other scheme, and anything the URL parser rejects,
 * stays plain text.
 */
export function splitHttpsLinks(text: string): LinkSegment[] {
  const segments: LinkSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const label = trimTrailingPunctuation(match[0]);
    const href = toHttpsHref(label);
    if (href === undefined) {
      continue;
    }
    if (match.index > cursor) {
      segments.push({ kind: 'text', start: cursor, text: text.slice(cursor, match.index) });
    }
    segments.push({ kind: 'link', start: match.index, text: label, href });
    cursor = match.index + label.length;
  }
  if (cursor < text.length) {
    segments.push({ kind: 'text', start: cursor, text: text.slice(cursor) });
  }
  return segments;
}

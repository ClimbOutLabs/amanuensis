import { replaceHiddenCharacters } from '../email/gmail/mimeText.js';

function escapeToken(char: string): string {
  return `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`;
}

/** Tab and carriage return, which a card never shows raw, and lone surrogates; newlines too unless they are kept. */
const REMAINING_ESCAPES = /\p{Cc}|\p{Surrogate}/gu;
const REMAINING_ESCAPES_KEEPING_NEWLINES = /(?!\n)\p{Cc}|\p{Surrogate}/gu;

/**
 * Makes model-controlled text safe to show: characters that can hide or fake text become visible
 * `\u{XXXX}` tokens. Display only; nothing that is sent or hashed passes through here. Newlines are
 * kept only when asked, and CRLF counts as one.
 */
export function escapeDisplayText(text: string, options?: { keepNewlines?: boolean }): string {
  const keepNewlines = options?.keepNewlines === true;
  // The one definition of "does not show" decides first; the pass below adds what a card never shows raw.
  const visible = replaceHiddenCharacters(keepNewlines ? text.replace(/\r\n/g, '\n') : text, escapeToken);
  return visible.replace(keepNewlines ? REMAINING_ESCAPES_KEEPING_NEWLINES : REMAINING_ESCAPES, escapeToken);
}

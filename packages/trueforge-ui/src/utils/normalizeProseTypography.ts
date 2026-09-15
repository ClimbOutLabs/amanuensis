/**
 * Maps typographic characters that gpt-oss models sometimes emit in prose to their plain ASCII
 * equivalents, so the chat UI renders with the right glyph and word wrap still works.
 *
 * This is a display-only normalisation: the stored message stays byte-for-byte what the model
 * produced. It is applied at render time to markdown text nodes outside code blocks and inline
 * code, where such characters may be intentional. Curly quotes, em dashes, and en dashes are left
 * untouched because they already render correctly.
 */

// U+2010 HYPHEN, U+2011 NON-BREAKING HYPHEN -> ASCII hyphen-minus.
// U+00A0 NO-BREAK SPACE, U+202F NARROW NO-BREAK SPACE -> ASCII space.
// Written as \u escapes (not literal characters) so the source file itself does not carry
// invisible/irregular whitespace bytes.
const TYPOGRAPHIC_CHARS = /[\u2010\u2011\u00A0\u202F]/g;

function replacement(char: string): string {
  return char === '\u00A0' || char === '\u202F' ? ' ' : '-';
}

export function normalizeProseTypography(text: string): string {
  return text.replace(TYPOGRAPHIC_CHARS, replacement);
}

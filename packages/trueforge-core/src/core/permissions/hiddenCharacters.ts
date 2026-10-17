/** Blank filler characters that Unicode treats as letters or symbols but that draw nothing. */
const BLANK_FILLERS = '\\u00AD\\u115F\\u1160\\u180E\\u2800\\u3164\\uFFA0';
// The combining grapheme joiner sits outside the class because a lone combining mark in one trips the linter.
const HIDDEN_SET = `(?:[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}${BLANK_FILLERS}]|\\u034F)`;

const HIDDEN_CODE_POINT = new RegExp(`^${HIDDEN_SET}$`, 'u');
// Tab, newline and carriage return lay text out and are expected in a message body.
const HIDDEN_OUTSIDE_LAYOUT = new RegExp(`(?![\\t\\n\\r])${HIDDEN_SET}`, 'u');

/** True for a character that can hide or fake text, so it must be shown as a code or refused. */
export function isHiddenCodePoint(codePoint: number): boolean {
  return HIDDEN_CODE_POINT.test(String.fromCodePoint(codePoint));
}

/** True when the text holds a character that would not show, other than tab, newline and carriage return. */
export function hasHiddenCharacters(text: string): boolean {
  return HIDDEN_OUTSIDE_LAYOUT.test(text);
}

/** True when any string, key or nested value holds a hidden character. */
export function containsHiddenCharacters(value: unknown): boolean {
  if (typeof value === 'string') {
    return hasHiddenCharacters(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsHiddenCharacters);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([key, field]) => hasHiddenCharacters(key) || containsHiddenCharacters(field));
  }
  return false;
}

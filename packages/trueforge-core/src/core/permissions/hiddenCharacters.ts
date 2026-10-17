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

const EMOJI = /^\p{Emoji}$/u;
const EMOJI_BEFORE_JOINER = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F]$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const LETTER = /^\p{L}$/u;
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const HAN = /^\p{Script=Han}$/u;
// A subdivision flag such as England's: the black flag, a short lowercase tag code, then the terminator.
const FLAG_TAG_SEQUENCE = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,7}\u{E007F}/gu;

/** True when the invisible character at `index` belongs to a well-formed emoji or script sequence. */
function isInWellFormedSequence(points: string[], index: number): boolean {
  const char = points[index] ?? '';
  const before = points[index - 1] ?? '';
  const after = points[index + 1] ?? '';
  const codePoint = char.codePointAt(0) ?? 0;
  if (char === '\uFE0E' || char === '\uFE0F') {
    return EMOJI.test(before);
  }
  if (char === '\u200D') {
    return (
      (EMOJI_BEFORE_JOINER.test(before) && PICTOGRAPH.test(after)) ||
      (LETTER_OR_MARK.test(before) && LETTER_OR_MARK.test(after))
    );
  }
  if (char === '\u200C') {
    return LETTER_OR_MARK.test(before) && LETTER_OR_MARK.test(after);
  }
  if (char === '\u00AD') {
    return LETTER.test(before) && LETTER.test(after);
  }
  if (char === '\uFEFF') {
    return index === 0;
  }
  return codePoint >= 0xe0100 && codePoint <= 0xe01ef && HAN.test(before);
}

/**
 * Like hasHiddenCharacters, but allows the invisible characters that ordinary writing needs in
 * place: emoji presentation and ZWJ sequences, subdivision flags, joiners between letters, a soft
 * hyphen inside a word, CJK variation selectors and one leading BOM. Anything out of place, and
 * every other hidden character, still counts.
 */
export function hasHiddenMessageCharacters(text: string): boolean {
  const points = Array.from(text.replace(FLAG_TAG_SEQUENCE, '\u{1F3F4}'));
  return points.some((char, index) => HIDDEN_OUTSIDE_LAYOUT.test(char) && !isInWellFormedSequence(points, index));
}

/** Keys always take the strict check: a field name never needs an emoji or script joiner. */
function containsMatching(value: unknown, test: (text: string) => boolean): boolean {
  if (typeof value === 'string') {
    return test(value);
  }
  if (Array.isArray(value)) {
    return value.some(item => containsMatching(item, test));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([key, field]) => hasHiddenCharacters(key) || containsMatching(field, test));
  }
  return false;
}

/** True when any string, key or nested value holds a hidden character. */
export function containsHiddenCharacters(value: unknown): boolean {
  return containsMatching(value, hasHiddenCharacters);
}

/** True when any key holds a hidden character, or any string value one outside a well-formed sequence. */
export function containsHiddenMessageCharacters(value: unknown): boolean {
  return containsMatching(value, hasHiddenMessageCharacters);
}

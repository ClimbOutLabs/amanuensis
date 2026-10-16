/** A full SHA-1 object id, as git prints it. */
export const OBJECT_ID = /^[0-9a-f]{40}$/u;
/** The same pattern as text, for composing larger expressions. */
export const OBJECT_ID_PATTERN = '[0-9a-f]{40}';

/** ASCII control characters, built from code points so the pattern itself holds none. */
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'gu',
);

export function hasControlCharacter(text: string): boolean {
  CONTROL_CHARACTERS.lastIndex = 0;
  return CONTROL_CHARACTERS.test(text);
}

export function replaceControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, ' ');
}

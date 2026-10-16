/**
 * The one owner of what a message id is: `<left@right>` where each side is dot-separated atoms of RFC 5322
 * atext, so an id cannot hold a space, a comment, a quote or an encoded word, and at most 250 characters.
 * An id list holds at most 20 ids, separated by single spaces. No pattern here has overlapping quantifiers.
 */
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const DOT_ATOM = `${ATOM}(?:\\.${ATOM})*`;
const MESSAGE_ID = new RegExp(`^<${DOT_ATOM}@${DOT_ATOM}>$`);

const MAX_ID_CHARS = 250;
export const MAX_REFERENCES = 20;

function isMessageId(token: string): boolean {
  return token.length <= MAX_ID_CHARS && !token.includes('=?') && MESSAGE_ID.test(token);
}

/** The ids of a header written exactly as an id list, or null when it is anything else. */
export function parseIdList(input: { value: string; max: number }): string[] | null {
  const tokens = input.value.split(' ');
  return tokens.length >= 1 && tokens.length <= input.max && tokens.every(isMessageId) ? tokens : null;
}

/** The valid ids found in a header the sender wrote however they liked; anything else is dropped. */
export function idsIn(value: string): string[] {
  return value.split(/\s+/).filter(isMessageId);
}

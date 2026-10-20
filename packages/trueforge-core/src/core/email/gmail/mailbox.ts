import { decodeEncodedWords } from './mimeText.js';

import type { Tier3Mailbox } from '../../permissions/tierMailbox.js';

/** Longest `<address>` read out of a header; a longer one is taken whole, as the address. */
export const MAX_ANGLE_ADDRESS_CHARS = 320;

/** A display name with any of these could be read as an address. */
const NAME_LOOKS_LIKE_ADDRESS = /[@()[\]]/;

interface ReadMailbox {
  name: string;
  address: string;
}

/**
 * One mailbox of a header, read as the header says it. A part that could be read two ways (more than one
 * bracket, or a parenthesis around the address) is taken whole as the address, so nothing is hidden by it.
 */
function readMailbox(part: string): ReadMailbox {
  const whole = { name: '', address: part.trim() };
  if (part.split('<').length > 2 || part.split('>').length > 2) {
    return whole;
  }
  const close = part.indexOf('>');
  const open = close === -1 ? -1 : part.lastIndexOf('<', close);
  const inner = open === -1 ? '' : part.slice(open + 1, close).trim();
  if (inner === '' || inner.length > MAX_ANGLE_ADDRESS_CHARS) {
    return whole;
  }
  const rawName = part.slice(0, open).trim();
  const quoted = rawName.length >= 2 && rawName.startsWith('"') && rawName.endsWith('"');
  // A parenthesis inside a quoted name is text; one outside the quotes or after the address is not.
  if ((!quoted && /[()]/.test(rawName)) || /[()]/.test(part.slice(close + 1))) {
    return whole;
  }
  return { name: decodeEncodedWords(quoted ? rawName.slice(1, -1) : rawName), address: inner };
}

/** One mailbox as Gmail holds it: its display name, kept whole, and its address. */
export function deliveredMailboxOf(part: string): Tier3Mailbox {
  return readMailbox(part);
}

/**
 * One mailbox as a card shows it when Aman builds the header itself: a display name that looks like an
 * address is left off, so the card shows only the real address. Used for addresses the model supplies.
 */
export function mailboxOf(part: string): Tier3Mailbox {
  const { name, address } = readMailbox(part);
  return { name: NAME_LOOKS_LIKE_ADDRESS.test(name) ? '' : name, address };
}

/** Whether `mailboxOf` leaves a display name off this part because it looks like an address. */
export function nameLeftOff(part: string): boolean {
  const { name } = readMailbox(part);
  return name !== '' && NAME_LOOKS_LIKE_ADDRESS.test(name);
}

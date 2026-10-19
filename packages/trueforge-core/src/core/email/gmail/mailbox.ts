import { decodeEncodedWords } from './mimeText.js';

import type { Tier3Mailbox } from '../../permissions/tierMailbox.js';

/** Longest `<address>` read out of a header; a longer one is taken whole, as the address. */
export const MAX_ANGLE_ADDRESS_CHARS = 320;

/** A display name with any of these could be read as an address, so it is left off the card. */
const NAME_LOOKS_LIKE_ADDRESS = /[@()[\]]/;

interface ReadMailbox extends Tier3Mailbox {
  /** Whether a display name was there and was left off because it looked like an address. */
  nameDropped: boolean;
}

function readMailbox(part: string): ReadMailbox {
  // Two brackets could be read two ways, so such a part is shown whole and never split.
  if (part.split('<').length > 2 || part.split('>').length > 2) {
    return { name: '', address: part.trim(), nameDropped: false };
  }
  const close = part.indexOf('>');
  const open = close === -1 ? -1 : part.lastIndexOf('<', close);
  const inner = open === -1 ? '' : part.slice(open + 1, close).trim();
  if (inner === '' || inner.length > MAX_ANGLE_ADDRESS_CHARS) {
    return { name: '', address: part.trim(), nameDropped: false };
  }
  const rawName = part.slice(0, open).trim();
  const unquoted =
    rawName.length >= 2 && rawName.startsWith('"') && rawName.endsWith('"') ? rawName.slice(1, -1) : rawName;
  const name = decodeEncodedWords(unquoted);
  if (name !== '' && NAME_LOOKS_LIKE_ADDRESS.test(name)) {
    return { name: '', address: inner, nameDropped: true };
  }
  return { name, address: inner, nameDropped: false };
}

/**
 * One address of a header, as a reader sees it: the name it is shown with (decoded, empty when there is none)
 * and the address. A part with no usable `<address>` is taken whole as the address. A name that looks like an
 * address is left off, so the card shows the real address alone.
 */
export function mailboxOf(part: string): Tier3Mailbox {
  const { name, address } = readMailbox(part);
  return { name, address };
}

/** Whether `mailboxOf` left a display name off this part because it looked like an address. */
export function nameLeftOff(part: string): boolean {
  return readMailbox(part).nameDropped;
}

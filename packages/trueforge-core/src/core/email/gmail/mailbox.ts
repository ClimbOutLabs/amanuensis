import type { Tier3Mailbox } from '../../permissions/tierMailbox.js';
import { decodeEncodedWords } from './mimeText.js';

/** Longest `<address>` read out of a header; a longer one is taken whole, as the address. */
export const MAX_ANGLE_ADDRESS_CHARS = 320;

/**
 * One address of a header, as a reader sees it: the name it is shown with (decoded, empty when there is none)
 * and the address. A part with no usable `<address>` is taken whole as the address.
 */
export function mailboxOf(part: string): Tier3Mailbox {
  const close = part.indexOf('>');
  const open = close === -1 ? -1 : part.lastIndexOf('<', close);
  const inner = open === -1 ? '' : part.slice(open + 1, close).trim();
  if (inner === '' || inner.length > MAX_ANGLE_ADDRESS_CHARS) {
    return { name: '', address: part.trim() };
  }
  const rawName = part.slice(0, open).trim();
  const unquoted =
    rawName.length >= 2 && rawName.startsWith('"') && rawName.endsWith('"') ? rawName.slice(1, -1) : rawName;
  return { name: decodeEncodedWords(unquoted), address: inner };
}

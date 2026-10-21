import { randomUUID } from 'crypto';
import { open, readFile, rename, rm } from 'fs/promises';

/**
 * An exact mailbox made of ASCII letters, digits and `._%+-`, then `@`, then dot-separated domain labels.
 * Anything outside that set is refused, so no glob character, quote, backslash or space can reach the file.
 */
const EXACT_ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** The one shape the server reads back. Any other content reads as an empty list. */
const FILE_SHAPE = /^allowed_recipients = \[(.*)\]\n?$/;

/** Returns the lowercased address, or null when the value is not one exact mailbox. */
export function exactRecipientAddress(raw: string): string | null {
  const address = raw.trim().toLowerCase();
  return EXACT_ADDRESS.test(address) ? address : null;
}

/**
 * The file text for a list of addresses. Every entry must be an exact address, so a wildcard is never
 * written. An empty list is valid and denies every send.
 */
export function renderAllowedRecipientsFile(addresses: readonly string[]): string {
  const exact = addresses.map(address => {
    const checked = exactRecipientAddress(address);
    if (checked === null) {
      throw new Error(`Refusing to write ${JSON.stringify(address)}: it is not an exact address.`);
    }
    return checked;
  });
  return `allowed_recipients = [${exact.map(address => `"${address}"`).join(', ')}]\n`;
}

/**
 * Replaces the file in one step: the new text is written and flushed to a temporary sibling, then renamed
 * over the old file. A refused list leaves the existing file untouched.
 */
export async function writeAllowedRecipientsFile({
  path,
  addresses,
}: {
  path: string;
  addresses: readonly string[];
}): Promise<void> {
  const text = renderAllowedRecipientsFile(addresses);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * The addresses the file allows. A missing, unreadable or unfamiliar file allows nothing, so a damaged
 * file stops sends instead of opening them.
 */
export async function readAllowedRecipientsFile({ path }: { path: string }): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const shape = FILE_SHAPE.exec(text);
  if (shape === null) {
    return [];
  }
  const inner = shape[1] ?? '';
  if (inner === '') {
    return [];
  }
  const addresses: string[] = [];
  for (const item of inner.split(', ')) {
    const quoted = /^"([^"]*)"$/.exec(item);
    const value = quoted?.[1];
    if (value === undefined || exactRecipientAddress(value) !== value) {
      return [];
    }
    addresses.push(value);
  }
  return addresses;
}

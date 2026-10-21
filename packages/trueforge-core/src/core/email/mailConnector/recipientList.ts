/**
 * The sending fields of a mail call, named as the Email sidecar names them. `from` and `reply_to` never receive
 * the message, so they are not read.
 */
const SENDING_FIELDS = ['recipients', 'cc', 'bcc'] as const;

/** Case and edge space never change who receives a message, so they never change whether it is listed. */
export function normalizeMailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** The address an argument names: a bare string, or an object's `email` or `address` field. */
function addressOf(item: unknown): string {
  if (typeof item === 'string') {
    return item;
  }
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    if ('email' in item && typeof item.email === 'string') {
      return item.email;
    }
    if ('address' in item && typeof item.address === 'string') {
      return item.address;
    }
  }
  // An entry with no readable address matches nothing on the list, so it is shown rather than passed over.
  return JSON.stringify(item);
}

/**
 * The addresses a send would deliver to that are not on the listed set, each once, lowercased, in argument
 * order. Empty when every recipient is listed or when the call names no recipient.
 */
export function mailRecipientsNotListed({
  listed,
  params,
}: {
  listed: readonly string[];
  params: Record<string, unknown>;
}): string[] {
  const allowed = new Set(listed.map(normalizeMailAddress));
  const notListed = new Set<string>();
  for (const field of SENDING_FIELDS) {
    const value = params[field];
    const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (const item of items) {
      const address = normalizeMailAddress(addressOf(item));
      if (!allowed.has(address)) {
        notListed.add(address);
      }
    }
  }
  return [...notListed];
}

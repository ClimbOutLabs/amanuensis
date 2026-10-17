/** The one sentence shown when a demo instance refuses a send; it names no list and no address. */
export const DEMO_SEND_REFUSAL = "In this demo, Aman can only send to the demo's own addresses.";

/** Shown when a demo instance refuses a connector action it cannot fully check for outgoing messages. */
export const DEMO_CONNECTOR_REFUSAL = "In this demo, Aman can't use connected services that could send a message.";

/** Case and edge space never change who gets a message, so they never change whether it is allowed. */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Whether every recipient is on a demo instance's send list. A null list means this is not a demo and
 * anything goes; an empty list allows no one. A message with no recipients at all is refused too, since
 * nothing was checked.
 */
export function recipientsAllowed(input: {
  allowlist: readonly string[] | null;
  recipients: readonly string[];
}): boolean {
  if (input.allowlist === null) {
    return true;
  }
  if (input.recipients.length === 0) {
    return false;
  }
  const allowed = new Set(input.allowlist.map(normalizeAddress));
  return input.recipients.every(recipient => allowed.has(normalizeAddress(recipient)));
}

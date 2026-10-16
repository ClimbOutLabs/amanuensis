/** The one sentence shown when a demo instance refuses a send; it names no list and no address. */
export const DEMO_SEND_REFUSAL = "In this demo, Aman can only send to the demo's own addresses.";

/** Case and edge space never change who gets a message, so they never change whether it is allowed. */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Whether every recipient is on a demo instance's send list. A null list means this is not a demo and
 * anything goes; an empty list allows no one. One empty-looking recipient is refused rather than skipped.
 */
export function recipientsAllowed(input: {
  allowlist: readonly string[] | null;
  recipients: readonly string[];
}): boolean {
  if (input.allowlist === null) {
    return true;
  }
  const allowed = new Set(input.allowlist.map(normalizeAddress));
  return input.recipients.every(recipient => allowed.has(normalizeAddress(recipient)));
}

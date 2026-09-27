/**
 * Serializes persona-pill mutations with turn creation.
 *
 * The pill's PUT and the chat's turn creation are separate HTTP requests. If
 * the user sends a message while the pill's PUT is still in flight, the turn
 * would be admitted before the new activation lands and answer as the old
 * persona. The pill registers its mutation promise here; turn creation awaits
 * it so the resolver sees the new activation.
 *
 * Module-level (not React state): turn creation runs outside React in the
 * assistant-ui runtime adapter.
 */

let pending: Promise<unknown> | null = null;

/** Register a pill mutation; turn creation will wait for it before admitting. */
export function registerPersonaMutation(promise: Promise<unknown>): void {
  pending = promise;
  void promise.then(
    () => {
      if (pending === promise) {
        pending = null;
      }
    },
    () => {
      if (pending === promise) {
        pending = null;
      }
    },
  );
}

/**
 * Wait for any in-flight pill mutation to settle. Resolves immediately when
 * none is pending. Never rejects: a failed mutation still lets the turn run
 * (the pill surfaces its own error state).
 */
export async function awaitPendingPersonaMutation(): Promise<void> {
  const current = pending;
  if (current !== null) {
    await current.then(
      () => undefined,
      () => undefined,
    );
  }
}

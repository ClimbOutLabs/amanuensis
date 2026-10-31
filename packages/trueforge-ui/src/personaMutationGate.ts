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

/** A pick made on a new chat before it exists on the server: applied once, to that chat's first turn. */
type HeldPersona = { threadId: string; personaId: string | null; apply: (sessionId: string) => Promise<unknown> };

let held: HeldPersona | null = null;

/** Holds the picker's choice on a new chat until the chat's first turn is created. */
export function holdPersonaForNewChat(next: HeldPersona | null): void {
  held = next;
}

/** The persona held for this new chat, or undefined when nothing is held for it. */
export function heldPersonaFor(threadId: string): string | null | undefined {
  return held !== null && held.threadId === threadId ? held.personaId : undefined;
}

/** Drops a hold made on another chat, so a pick never carries over to the wrong one. */
export function dropHeldPersonaUnlessFor(threadId: string): void {
  if (held !== null && held.threadId !== threadId) held = null;
}

/**
 * Applies a held pick to the chat that was just created, before its first turn is admitted. Never
 * rejects: a failed switch still lets the turn run as the default answerer.
 */
export async function applyHeldPersona(sessionId: string): Promise<void> {
  const current = held;
  held = null;
  if (current === null) return;
  await current.apply(sessionId).then(
    () => undefined,
    () => undefined,
  );
}

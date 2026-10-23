/**
 * Which chats are having their history shortened right now, as seen on the live turn stream.
 * `chatServer.ts` taps the compaction start and end off the raw stream before the vendor-typed
 * pipeline narrows them away; the chat's wait line and the runtime rail read it.
 */
const compactingSessionIds = new Set<string>();
const listeners = new Set<() => void>();

export function subscribeToContextCompaction(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isContextCompacting(sessionId: string): boolean {
  return compactingSessionIds.has(sessionId);
}

export function publishContextCompaction({ sessionId, active }: { sessionId: string; active: boolean }): void {
  if (compactingSessionIds.has(sessionId) === active) return;
  if (active) compactingSessionIds.add(sessionId);
  else compactingSessionIds.delete(sessionId);
  for (const listener of listeners) listener();
}

/** Test helper: forgets every chat so suites do not leak state. */
export function clearContextCompaction(): void {
  compactingSessionIds.clear();
  for (const listener of listeners) listener();
}

/**
 * Facts a person pulled out of one chat's recall, by chat. Pulling a fact out lasts for the rest
 * of that chat on this server: the recall path skips the fact there, other chats still recall
 * it, and the memory itself is never changed or deleted. Kept in memory only, so a restart
 * forgets the list and every fact can be recalled again.
 */
const exclusionsBySession = new Map<string, Set<string>>();

/** Records that `factText`, in the plain words recall showed for it, is out of this chat's recall. */
export function excludeRecallFact(input: { sessionId: string; factText: string }): void {
  const existing = exclusionsBySession.get(input.sessionId);
  if (existing === undefined) {
    exclusionsBySession.set(input.sessionId, new Set([input.factText]));
    return;
  }
  existing.add(input.factText);
}

/** The facts pulled out of this chat's recall; an empty set when nothing was pulled out. */
export function recallExclusionsFor(sessionId: string): ReadonlySet<string> {
  return exclusionsBySession.get(sessionId) ?? EMPTY_EXCLUSIONS;
}

const EMPTY_EXCLUSIONS: ReadonlySet<string> = new Set();

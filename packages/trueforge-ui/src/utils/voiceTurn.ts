/**
 * Tracks which reply is read aloud: only the reply to a message the person sent from voice input.
 * Module state, because the mic button and the composer send path sit in different subtrees.
 */

/** Whether the composer's draft holds a voice transcript. */
let draftFromVoice = false;
/** The trimmed text of a voice send whose message has not reached the chat yet, or null. */
let sendingFromVoice: string | null = null;
/** The id of the voice message whose reply is still to be read, or null. */
let awaitingReplyTo: string | null = null;

export function markDraftFromVoice(): void {
  draftFromVoice = true;
}

/** Forgets the voice draft, e.g. once the composer is emptied. */
export function clearDraftFromVoice(): void {
  draftFromVoice = false;
}

/** Called when the composer sends: reports whether the draft came from voice and resets it. */
export function takeDraftFromVoice(): boolean {
  const fromVoice = draftFromVoice;
  draftFromVoice = false;
  return fromVoice;
}

/**
 * Arms the reply for the send just made. A typed send disarms it, and a new send replaces one still
 * waiting. The armed message is matched by its text, so an edit or a regenerate never picks it up.
 */
export function armSpokenReply({ fromVoice, text }: { fromVoice: boolean; text: string }): void {
  sendingFromVoice = fromVoice ? text.trim() : null;
  awaitingReplyTo = null;
}

/** Drops a voice send that failed or was cancelled, and any reply still waiting on it. */
export function disarmSpokenReply(): void {
  sendingFromVoice = null;
  awaitingReplyTo = null;
}

/**
 * Called for each new user message in the chat. The voice send's own message (same text) starts
 * waiting for its reply; any other new message means the voice send is over.
 */
export function noteUserMessage({ id, text }: { id: string; text: string }): void {
  if (sendingFromVoice === null) return;
  awaitingReplyTo = text.trim() === sendingFromVoice ? id : null;
  sendingFromVoice = null;
}

/** When a turn finishes: whether its reply answers the voice message. Consumes the pending reply. */
export function takeSpokenReply(latestUserId: string | undefined): boolean {
  const pending = awaitingReplyTo !== null && awaitingReplyTo === latestUserId;
  awaitingReplyTo = null;
  return pending;
}

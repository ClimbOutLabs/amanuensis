/**
 * Tracks whether a chat message was sent from voice input, so only its reply is read aloud. Module
 * state, because the mic button and the composer send path sit in different subtrees.
 */

/** Whether the composer's draft holds a voice transcript. */
let draftFromVoice = false;
/** Whether the turn in flight was sent from voice, so its reply should be read aloud. */
let replyAwaitingSpeech = false;

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

/** Arms the reply for the turn that was just sent. A typed send disarms it. */
export function armSpokenReply(fromVoice: boolean): void {
  replyAwaitingSpeech = fromVoice;
}

/** Reads and clears the armed flag when a turn finishes. */
export function takeSpokenReply(): boolean {
  const pending = replyAwaitingSpeech;
  replyAwaitingSpeech = false;
  return pending;
}

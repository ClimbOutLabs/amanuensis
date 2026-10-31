import { useSyncExternalStore } from 'react';

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

/** Whether the composer's draft holds a voice transcript that has not been sent. */
export function hasDraftFromVoice(): boolean {
  return draftFromVoice;
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

/**
 * Hands-free conversation for the open chat: off, listening for the person, waiting while Aman
 * answers, or due to listen again once the answer is over. Module state, because the composer that
 * shows the mic unmounts while a turn runs and remounts for an approval.
 */
export type HandsFree = 'off' | 'listening' | 'answering' | 'listen-due';

let handsFree: HandsFree = 'off';
const handsFreeListeners = new Set<() => void>();

export function getHandsFree(): HandsFree {
  return handsFree;
}

export function setHandsFree(next: HandsFree): void {
  if (handsFree === next) return;
  handsFree = next;
  for (const listener of handsFreeListeners) listener();
}

function subscribeHandsFree(listener: () => void): () => void {
  handsFreeListeners.add(listener);
  return () => {
    handsFreeListeners.delete(listener);
  };
}

export function useHandsFree(): HandsFree {
  return useSyncExternalStore(subscribeHandsFree, getHandsFree, () => 'off');
}

/**
 * Called when a turn is over as far as the person is concerned: its reply has been read aloud, or
 * there was nothing to read. A hands-free conversation waiting on the answer is due to listen again.
 */
export function voiceReplyDone(): void {
  if (handsFree === 'answering') setHandsFree('listen-due');
}

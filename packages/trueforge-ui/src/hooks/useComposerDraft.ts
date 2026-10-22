'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from 'react';

import { useComposerBusyState } from './useComposerBusyState.js';

const DRAFT_KEY_PREFIX = 'aman:composer-draft';

/**
 * Who the drafts belong to. Session storage outlives a sign-out in the same tab, so the host
 * scopes drafts to the signed-in identity; the empty default is for hosts without accounts.
 */
const ComposerDraftScopeContext = createContext<string>('');

export function ComposerDraftScopeProvider({ scope, children }: { scope: string; children: ReactNode }) {
  return createElement(ComposerDraftScopeContext.Provider, { value: scope }, children);
}

/** Where a draft lives: one account, one conversation. */
export interface ComposerDraftKey {
  scope: string;
  thread: string;
}

/**
 * The tab's session storage: it survives a reload and the sign-in round trip, which is what
 * loses a typed message otherwise, and dies with the tab, so a draft never follows the user to
 * another window. Null where storage is blocked; the composer then simply has no memory.
 */
function draftStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function composerDraftKey({ scope, thread }: ComposerDraftKey): string {
  return `${DRAFT_KEY_PREFIX}:${encodeURIComponent(scope)}:${encodeURIComponent(thread)}`;
}

export function readComposerDraft(key: ComposerDraftKey): string | null {
  try {
    return draftStorage()?.getItem(composerDraftKey(key)) ?? null;
  } catch {
    return null;
  }
}

/** True when the draft is now in storage; false when the store is missing, full, or blocked. */
export function writeComposerDraft({ text, ...key }: ComposerDraftKey & { text: string }): boolean {
  try {
    const storage = draftStorage();
    if (storage === null) {
      return false;
    }
    storage.setItem(composerDraftKey(key), text);
    return true;
  } catch {
    // Quota or a blocked store: the draft is a convenience, never a reason to fail typing.
    return false;
  }
}

export function clearComposerDraft(key: ComposerDraftKey): void {
  try {
    draftStorage()?.removeItem(composerDraftKey(key));
  } catch {
    // Nothing to do; the store is unavailable.
  }
}

let pendingComposerPrefill: string | null = null;

/**
 * Text for the next composer that mounts, set by a page outside the chat (Spaces) right before it
 * opens a new chat. It only fills the box: nothing is sent until the person types and sends.
 */
export function setComposerPrefill(text: string): void {
  pendingComposerPrefill = text;
}

/** Hands the pending prefill to the composer that is taking it, once. */
export function takeComposerPrefill(): string | null {
  const text = pendingComposerPrefill;
  pendingComposerPrefill = null;
  return text;
}

/**
 * Moves a draft to a conversation's new key. Text already under the new key is newer than the
 * old copy and wins; the old key goes only once the new key holds a copy, so a full store can
 * never leave the user with neither.
 */
export function moveComposerDraft({ from, to }: { from: ComposerDraftKey; to: ComposerDraftKey }): void {
  const saved = readComposerDraft(from);
  if (saved === null) {
    return;
  }
  const existing = readComposerDraft(to);
  const destinationHolds = (existing !== null && existing !== '') || writeComposerDraft({ ...to, text: saved });
  if (destinationHolds) {
    clearComposerDraft(from);
  }
}

/**
 * How the conversation identity moved between two renders. A new chat is keyed by its local id
 * until the first send gives it a server id; that is the same conversation under a new name, and
 * the draft (or the send still in flight) must move with it rather than be treated as a switch.
 */
export function conversationTransition({
  current,
  next,
}: {
  current: { scope: string; localId: string; thread: string } | null;
  next: { scope: string; localId: string; thread: string };
}): 'same' | 'renamed' | 'switched' {
  if (current === null || current.scope !== next.scope) {
    return 'switched';
  }
  if (current.thread === next.thread) {
    return 'same';
  }
  return current.localId === next.localId ? 'renamed' : 'switched';
}

/** The plain text of a thread message, for matching a stored draft against what was delivered. */
function messageText(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text ?? '')
    .join('');
}

/**
 * True when the most recent user message in the thread reads exactly `text`: the draft was the
 * last thing sent, so it was delivered. Only the latest user message counts; an older message
 * with the same words says nothing about a draft typed again later.
 */
export function lastUserMessageReads(
  messages: readonly { role: string; content: readonly { type: string; text?: string }[] }[],
  text: string,
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === 'user') {
      return messageText(message) === text;
    }
  }
  return false;
}

/** What the hook knows about the conversation it is currently tracking. */
interface TrackedConversation extends ComposerDraftKey {
  /** The runtime's own id for the thread; stable across the first send, unlike `thread`. */
  localId: string;
  /** The composer has held text for this conversation, so an emptied composer is meaningful. */
  seenText: boolean;
  /** Text still in the composer from the previous conversation; never saved under this one. */
  carried: string | null;
  /**
   * The thread length at the last render in which the composer held text, so a send's progress
   * is measured from before the message left the box, not from whatever render first observed
   * the empty composer (by then the reply may already be in the thread).
   */
  messageCountWithText: number;
  /**
   * A send emptied the composer and the stored draft is being kept until the runtime shows the
   * message left the box for good. `messageCount` is the thread length before the send.
   */
  sendInFlight: { messageCount: number } | null;
}

/**
 * Keeps what the user has typed across a page reload: the text is written to session storage on
 * every change and put back into an empty composer when a conversation opens.
 *
 * The hook owns storage only. It never decides whether a send succeeded or failed, and the one
 * place it writes into the composer is that restore on open. What happens to the composer after
 * a send is the chat runtime's business: the runtime clears it on send and gives the text back
 * itself when the server never registered the message. Inferring the same thing here from busy
 * flags and message counts is what used to put an already-delivered message back into the box.
 *
 * A send does empty the composer before the server has accepted anything, so the stored copy is
 * kept until the runtime shows progress (the turn is running, or the thread grew) and only then
 * dropped. A reload inside that window, such as the sign-in round trip on an expired session,
 * still finds the text on the way back. If the runtime gives the text back instead, the hook sees
 * it as ordinary typing and keeps saving it.
 */
export function useComposerDraft(): void {
  const aui = useAui();
  const text = useAuiState(state => state.composer.text);
  const remoteId = useAuiState(state => state.threadListItem.remoteId);
  const localId = useAuiState(state => state.threadListItem.id);
  const messages = useAuiState(state => state.thread.messages);
  const isLoading = useAuiState(state => state.thread.isLoading);
  const messageCount = messages.length;
  const thread = remoteId ?? localId;
  const scope = useContext(ComposerDraftScopeContext);
  const { isSubmitting, isRunning, sendThreadId } = useComposerBusyState();
  const tracked = useRef<TrackedConversation | null>(null);

  useEffect(() => {
    if (isLoading) {
      // History is still hydrating: whether a stored draft was already delivered cannot be told
      // yet, and nothing can be typed into a composer the thread view does not show while loading.
      return;
    }
    const transition = conversationTransition({ current: tracked.current, next: { scope, localId, thread } });
    if (transition === 'renamed' && tracked.current !== null) {
      // Same chat, now with its server id: move what is stored under the old key to the new one
      // so a reload right after creating the chat still has its text to give back.
      moveComposerDraft({
        from: { scope: tracked.current.scope, thread: tracked.current.thread },
        to: { scope, thread },
      });
      tracked.current = { ...tracked.current, scope, thread };
    }
    const current = tracked.current;
    if (transition === 'switched' || current === null) {
      // A conversation switch without a remount: start fresh for the new key, and never save
      // text the composer still carries from the previous one under the new key.
      tracked.current = {
        scope,
        thread,
        localId,
        seenText: false,
        carried: text === '' ? null : text,
        messageCountWithText: messageCount,
        sendInFlight: null,
      };
      if (remoteId != null && remoteId !== localId) {
        // A draft stored under the local id by an instance unmounted before the first send got
        // its server id (the composer remounts when the welcome view becomes a thread) belongs
        // to this conversation.
        moveComposerDraft({ from: { scope, thread: localId }, to: { scope, thread } });
      }
      const saved = readComposerDraft({ scope, thread });
      if (saved === null || saved === '' || text !== '') {
        return;
      }
      if (lastUserMessageReads(messages, saved)) {
        // Sent and delivered before this instance mounted (a remount or a reload after the send
        // went through): the draft is finished, not something to put back in the box.
        clearComposerDraft({ scope, thread });
        return;
      }
      if (isRunning || (isSubmitting && sendThreadId === localId)) {
        // The composer remounted in the middle of this conversation's own send (the welcome view
        // becomes a thread on the first message): the stored text is the message on its way, so
        // track it as such and let the runtime's progress retire it, exactly as if this instance
        // had sent it. A send pending on another conversation says nothing about this draft.
        tracked.current.seenText = true;
        tracked.current.sendInFlight = { messageCount };
        return;
      }
      aui.composer().setText(saved);
      return;
    }
    if (text !== '') {
      // Typing, or the runtime giving a failed send's text back: either way this is the draft now.
      current.sendInFlight = null;
      current.messageCountWithText = messageCount;
      if (current.carried === text) {
        return;
      }
      current.carried = null;
      current.seenText = true;
      writeComposerDraft({ scope, thread, text });
      return;
    }
    if (!current.seenText) {
      return;
    }
    if (current.sendInFlight !== null) {
      if (isRunning || messageCount > current.sendInFlight.messageCount) {
        // The runtime took the message: the turn is running, or the thread already grew. Drop
        // the stored copy so a later reload does not bring a delivered message back.
        clearComposerDraft({ scope, thread });
        current.sendInFlight = null;
        current.seenText = false;
      }
      return;
    }
    if (isSubmitting || messageCount > current.messageCountWithText) {
      // The send emptied the composer; keep the stored copy until the runtime shows progress,
      // measured from the thread length before the send. A thread that already grew in the same
      // render confirms at once below on the next pass.
      current.sendInFlight = { messageCount: current.messageCountWithText };
      if (isRunning || messageCount > current.messageCountWithText) {
        clearComposerDraft({ scope, thread });
        current.sendInFlight = null;
        current.seenText = false;
      }
      return;
    }
    // Emptied by the user: drop the draft like any other cleared text.
    clearComposerDraft({ scope, thread });
    current.seenText = false;
  }, [
    aui,
    isLoading,
    isRunning,
    isSubmitting,
    localId,
    messageCount,
    messages,
    remoteId,
    scope,
    sendThreadId,
    text,
    thread,
  ]);
}

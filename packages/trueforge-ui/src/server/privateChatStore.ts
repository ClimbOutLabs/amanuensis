import { useSyncExternalStore } from 'react';

/**
 * The new chat's Private choice, and the one private chat open in this tab. Both live in memory
 * only, never in browser storage: a reload forgets the chat here, and the server deletes it when
 * its time is up.
 */
export type PrivateChatState = {
  /** The person chose Private for the chat they have not sent yet. */
  pending: boolean;
  /** The private chat this tab started and has not closed. */
  openSessionId: string | undefined;
};

let state: PrivateChatState = { pending: false, openSessionId: undefined };
const listeners = new Set<() => void>();

function update(next: PrivateChatState): void {
  if (next.pending === state.pending && next.openSessionId === state.openSessionId) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readPrivateChatState(): PrivateChatState {
  return state;
}

export function usePrivateChatState(): PrivateChatState {
  return useSyncExternalStore(subscribe, readPrivateChatState, readPrivateChatState);
}

/** True when `sessionId` is the private chat open in this tab. */
export function useIsPrivateChat(sessionId: string | null | undefined): boolean {
  const { openSessionId } = usePrivateChatState();
  return sessionId != null && sessionId === openSessionId;
}

export function setPendingPrivateChat(pending: boolean): void {
  update({ ...state, pending });
}

/** The new chat was created private: it is now the open one, and the next new chat starts normal. */
export function adoptPrivateChat(sessionId: string): void {
  update({ pending: false, openSessionId: sessionId });
}

/** The chat was closed and deleted, so nothing points at it any more. */
export function forgetPrivateChat(sessionId: string): void {
  if (state.openSessionId !== sessionId) return;
  update({ ...state, openSessionId: undefined });
}

/**
 * Keeps private chats out of a chat list, except the one open in this tab. The server lists them
 * only when asked, so a list request asks only while one is open.
 */
export function withOpenPrivateChatOnly<T extends object>(sessions: readonly T[]): T[] {
  const openSessionId = state.openSessionId;
  return sessions.filter(
    session => Reflect.get(session, 'isIncognito') !== true || Reflect.get(session, 'id') === openSessionId,
  );
}

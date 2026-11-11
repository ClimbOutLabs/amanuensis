'use client';

import { useAuiState } from '@assistant-ui/react';

import { usePrivateChatState } from '../../server/privateChatStore.js';

/** True on the open private chat, and on a new chat with Private chosen: both wear the ink frame. */
export function usePrivateChatFrame(): boolean {
  const sessionId = useAuiState(state => state.threadListItem.remoteId) ?? undefined;
  const { pending, openSessionId } = usePrivateChatState();
  return sessionId === undefined ? pending : sessionId === openSessionId;
}

'use client';

import { useCallback } from 'react';

import { useAui, useAuiState } from '../assistant-ui.js';
import {
  readThreadAgentName,
  threadListIndicesByRecency,
  threadListItemIsMutable,
} from '../atoms/lib/threadListMeta.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';

/**
 * Opens the newest saved chat, or a new chat when there is none yet. While the list is still
 * loading it does nothing, so a slow load never starts an unwanted new chat.
 */
export function useOpenMostRecentChat(): () => void {
  const aui = useAui();
  const shell = useOptionalShellMode();
  const isLoading = useAuiState(s => s.threads.isLoading);
  const threadIds = useAuiState(s => s.threads.threadIds);
  const threadItems = useAuiState(s => s.threads.threadItems);
  const activeRemoteId = useAuiState(s => s.threadListItem.remoteId);

  return useCallback(() => {
    if (shell === null || isLoading) return;
    const saved = threadListIndicesByRecency({ threadIds, threadItems })
      .map(index => threadItems.find(item => item.id === threadIds[index] || item.remoteId === threadIds[index]))
      .find(item => item?.remoteId != null);
    if (saved?.remoteId != null) {
      if (saved.remoteId === activeRemoteId) return;
      const agentName = readThreadAgentName(saved.custom);
      shell.openHistorySession({
        sessionId: saved.remoteId,
        isMutable: threadListItemIsMutable(saved.custom),
        ...(agentName != null ? { agentName } : {}),
      });
      return;
    }
    if (!shell.isNewChatEnabled) return;
    if (shell.isComposerEnabled) {
      shell.openDraft();
      return;
    }
    void Promise.resolve(aui.threads().switchToNewThread()).catch(() => undefined);
  }, [aui, shell, isLoading, threadIds, threadItems, activeRemoteId]);
}

'use client';

import { useAuiState } from '@assistant-ui/react';
import { useTrueFoundryApprovals } from '@truefoundry/assistant-ui-runtime';
import { useMemo } from 'react';

import { pendingApprovalIdsOf } from '../utils/pendingApprovalIds.js';

/**
 * Pending tool approvals the user can still answer. The runtime lists every card that never got a
 * decision, but the server refuses a decision once the chat moved past the turn that asked, so only
 * cards on the newest message count. Older ones render as expired and must not block the composer.
 */
export function useAnswerableApprovals(): ReturnType<typeof useTrueFoundryApprovals> {
  const approvals = useTrueFoundryApprovals();
  const newestMessage = useAuiState(state => state.thread.messages.at(-1));
  const { pending: allPending } = approvals;
  const pending = useMemo(() => {
    const answerable = pendingApprovalIdsOf(newestMessage);
    return allPending.filter(approval => answerable.has(approval.approvalId));
  }, [allPending, newestMessage]);
  return { ...approvals, pending };
}

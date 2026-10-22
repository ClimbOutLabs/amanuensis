'use client';

import { useEffect, useMemo } from 'react';

import { useAnswerableApprovals } from '../hooks/useAnswerableApprovals.js';

/**
 * Reports the approvals waiting on the person to a host that renders outside the chat tree,
 * such as the right rail's Needs you ticket. Renders nothing.
 */
export function PendingApprovalsReporter({ onChange }: { onChange: (approvalIds: readonly string[]) => void }) {
  const { pending } = useAnswerableApprovals();
  const approvalIds = useMemo(() => pending.map(approval => approval.approvalId), [pending]);
  useEffect(() => {
    onChange(approvalIds);
  }, [approvalIds, onChange]);
  return null;
}

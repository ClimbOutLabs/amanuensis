'use client';

import { useCallback, useEffect, useRef } from 'react';

import { useOptionalApprovalFocus } from '../containers/approvalFocus.js';
import { useAnswerableApprovals } from './useAnswerableApprovals.js';

export type ApprovalNavState = {
  count: number;
  /** Id of the first pending approval, or null when none waits. */
  currentId: string | null;
  /** Scroll to the first pending approval and focus it. */
  focusCurrent: () => void;
};

/**
 * Tracks the first pending tool approval for the composer strip.
 * Focuses it when it appears; once it resolves the next one is the first.
 */
export function useApprovalNav(): ApprovalNavState {
  const { pending } = useAnswerableApprovals();
  const focusApi = useOptionalApprovalFocus();
  const currentId = pending[0]?.approvalId ?? null;
  const focusedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (currentId == null || focusApi == null) {
      if (currentId == null) focusedIdRef.current = null;
      return;
    }
    if (focusedIdRef.current === currentId) return;
    focusedIdRef.current = currentId;
    focusApi.focus(currentId);
  }, [currentId, focusApi]);

  const focusCurrent = useCallback(() => {
    if (currentId == null || focusApi == null) return;
    focusApi.focus(currentId, { focusPrimary: true });
  }, [currentId, focusApi]);

  return {
    count: pending.length,
    currentId,
    focusCurrent,
  };
}

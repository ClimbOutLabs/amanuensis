'use client';

import { useAuiState } from '@assistant-ui/react';
import { useTrueFoundryReload } from '@truefoundry/assistant-ui-runtime';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '../atoms/primitives/Button.js';
import { useAnswerableApprovals } from '../hooks/useAnswerableApprovals.js';
import { useApprovalCardPlacement } from '../hooks/useApprovalCardPlacement.js';
import {
  subscribeToBlockedSend,
  type HarnessChatServerExtensions,
} from '../plugins/trueforge-agent-server-adapter/sessionResync.js';
import { useOptionalServer } from '../server/ServerContext.js';
import { isStaleApprovalError } from '../utils/staleApproval.js';
import { useToasterOptional } from './ToasterContainer.js';

/** Structural check: the trueforge adapter's pending-approval escape hatch. */
function hasDismissPort(server: object): server is Pick<HarnessChatServerExtensions, 'dismissPendingApprovals'> {
  const dismiss: unknown = Reflect.get(server, 'dismissPendingApprovals');
  return typeof dismiss === 'function';
}

const DISMISS_REASON = 'Dismissed from the action-needed banner.';

/**
 * Prominent fallback for pending tool approvals. The approval card renders on
 * the assistant message, but when the stream died (or the send was rejected
 * with the pending-approvals 422) the card may never appear, so this banner
 * does not depend on it. Offers the fail-closed escape hatch: deny everything
 * pending so the chat can continue.
 *
 * It shows only when no card stands for the first pending approval, so the
 * person sees one pending signal. A blocked send always shows it.
 */
export function PendingApprovalsBanner(): React.JSX.Element | null {
  const { pending } = useAnswerableApprovals();
  // The composer banner follows the newest selection, which starts on the first pending approval.
  const placement = useApprovalCardPlacement(pending[0]?.approvalId ?? null);
  const reload = useTrueFoundryReload();
  const toaster = useToasterOptional();
  const server = useOptionalServer();
  const sessionId = useAuiState(state => state.threadListItem?.remoteId);
  const [blocked, setBlocked] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => subscribeToBlockedSend(() => setBlocked(true)), []);
  useEffect(() => {
    if (pending.length > 0) setBlocked(false);
  }, [pending.length]);

  const dismiss = useCallback(async () => {
    if (server == null || !hasDismissPort(server) || sessionId == null || dismissing) return;
    setDismissing(true);
    try {
      const result = await server.dismissPendingApprovals({ sessionId, reason: DISMISS_REASON });
      setBlocked(false);
      reload();
      if (!result.alreadyResolved) {
        const plural = result.dismissed === 1 ? '' : 's';
        toaster?.showSuccess({
          title: 'Approvals dismissed',
          description: `${result.dismissed} pending approval${plural} denied. You can send a new message now.`,
        });
      }
    } catch (error) {
      if (isStaleApprovalError(error)) {
        // The requests ended or the chat moved on while dismissing: nothing is left to deny, so
        // reload to the current state instead of showing the server's error.
        reload();
        return;
      }
      toaster?.showError(error instanceof Error ? error : new Error('Could not dismiss the pending approvals.'));
    } finally {
      setDismissing(false);
    }
  }, [server, sessionId, dismissing, reload, toaster]);

  const count = pending.length;
  const standsIn = count > 0 && placement === 'missing';
  if (!standsIn && !blocked) return null;
  const canDismiss = server != null && hasDismissPort(server) && sessionId != null;

  return (
    <div
      data-role="host-pending-approvals"
      role="alert"
      className="aui-pending-approvals-root border-gold-line bg-gold-soft text-text-primary m-2 rounded-md border p-3"
    >
      <div className="text-sm font-medium">Action needed</div>
      <p className="mt-1 text-sm">
        {count > 0
          ? `The assistant is waiting for your approval on ${count} tool call${count === 1 ? '' : 's'} before it can continue.`
          : 'Your message could not be sent because this chat has pending tool approvals.'}
      </p>
      {canDismiss && (
        <div className="mt-2 flex gap-2">
          <Button.Secondary size="small" onClick={() => void dismiss()} disabled={dismissing}>
            {dismissing ? 'Dismissing…' : 'Dismiss pending approvals'}
          </Button.Secondary>
        </div>
      )}
    </div>
  );
}

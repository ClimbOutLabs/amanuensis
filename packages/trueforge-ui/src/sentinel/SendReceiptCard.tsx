'use client';

import type { FC } from 'react';

import { Button } from '../atoms/primitives/Button.js';
import { Icon } from '../icons/Icon.js';
import { EmailMessage } from './PermissionApprovalCard.js';
import type { SentinelNotSentReason, SentinelSendReceipt } from './types.js';

/** What a person reads when a send did not go out. These words are fixed here; none comes from the model. */
export const NOT_SENT_TEXT: Record<SentinelNotSentReason, string> = {
  draft_changed: 'Not sent: the draft changed after you approved it. Review it again.',
  needs_ok_again: 'Not sent: this needs your OK again. Review it again.',
  cannot_send: 'Not sent: Aman could not read the draft from Gmail, so nothing was sent. Ask Aman to send it again.',
  gmail_refused: 'Not sent: Gmail did not accept it.',
  reconnect_google:
    'Not sent: Aman needs you to sign in to Google again. Open Settings, Connectors, Google and choose Reconnect.',
  rate_limited: 'Not sent: Gmail is limiting requests right now. Wait a minute, then ask Aman to send it again.',
  unconfirmed:
    'Gmail did not confirm the send, so it may have gone through. Check your Sent folder before trying again.',
};

/** Shown instead of "exactly as approved" when the sent text cannot be tied to the card the owner approved. */
export const SENT_MISMATCH_TEXT =
  "The text that was sent didn't match what you approved. Check your Sent folder to see what went out.";

/** Reasons where asking for the card again can fix things. */
const REVIEW_AGAIN_REASONS: readonly SentinelNotSentReason[] = ['draft_changed', 'needs_ok_again'];

/** The time of day in the viewer's own time zone, 24-hour, e.g. 09:12. */
export function formatSentTime(isoTime: string): string {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return isoTime;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export type SendReceiptCardProps = {
  receipt: SentinelSendReceipt;
  /** The check code of the card the owner approved for this same tool call; null when there is none on record. */
  approvedCheckCode: string | null;
  /** Asks for the send again so a fresh approval card is shown; only passed where that can help. */
  onReviewAgain?: (() => void) | undefined;
};

/**
 * The approval card of a send, after the send ended. A sent receipt repeats the message the server verified and
 * the check code the card showed; a send that did not go out says so and never shows a receipt.
 */
export const SendReceiptCard: FC<SendReceiptCardProps> = ({ receipt, approvedCheckCode, onReviewAgain }) => {
  if (receipt.outcome === 'not_sent') {
    return (
      <div data-role="send-not-sent" className="rounded-lg border border-border bg-card-bg px-4 py-3">
        <p className="flex items-start gap-2 text-sm text-text-primary">
          <Icon name="info" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{NOT_SENT_TEXT[receipt.reason]}</span>
        </p>
        {onReviewAgain !== undefined && REVIEW_AGAIN_REASONS.includes(receipt.reason) && (
          <Button variant="secondary" size="small" onClick={onReviewAgain} className="mt-3">
            Show the new card
          </Button>
        )}
      </div>
    );
  }
  const matchesApproval = approvedCheckCode !== null && approvedCheckCode === receipt.checkCode;
  return (
    <div data-role="send-receipt" className="rounded-lg border border-border bg-card-bg">
      <div className="flex items-center gap-2 rounded-t-lg border-b border-border bg-secondary-bg px-4 py-2">
        <Icon name="check" className="shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="text-sm font-semibold text-text-primary">Email sent</span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm text-text-primary" title={new Date(receipt.sentAt).toLocaleString()}>
          {matchesApproval
            ? `Sent at ${formatSentTime(receipt.sentAt)}, exactly as approved`
            : `Sent at ${formatSentTime(receipt.sentAt)}`}
        </p>
        {!matchesApproval && <p className="text-sm text-text-primary">{SENT_MISMATCH_TEXT}</p>}
        <EmailMessage email={receipt.message} heading="What was sent" checkCode={receipt.checkCode} />
      </div>
    </div>
  );
};

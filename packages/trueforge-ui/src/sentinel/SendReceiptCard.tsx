'use client';

import type { FC } from 'react';

import { Button } from '../atoms/primitives/Button.js';
import { CheckCodeRow, EmailBody, mailboxListText } from './EmailApprovalCard.js';
import type { SentinelNotSentReason, SentinelSendReceipt } from './types.js';

/** What a person reads when a send did not go out. These words are fixed here; none comes from the model. */
export const NOT_SENT_TEXT: Record<SentinelNotSentReason, string> = {
  draft_changed: 'Not sent: the draft changed after you approved it. Review it again.',
  needs_ok_again: 'Not sent: this needs your OK again. Review it again.',
  cannot_send: 'Not sent: Aman could not read the draft from Gmail. Ask Aman to send it again.',
  gmail_refused: 'Not sent: Gmail did not accept it. Ask Aman what Gmail said.',
  reconnect_google:
    'Not sent: Aman needs you to sign in to Google again. Open Settings, Connectors, Google and choose Reconnect.',
  rate_limited: 'Not sent: Gmail is limiting requests right now. Wait a minute, then ask Aman to send it again.',
  demo_limited: "Not sent: in this demo, Aman can only send to the demo's own addresses. Pick one of those instead.",
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
      <div data-role="send-not-sent" className="my-2 rounded-md border border-border bg-card-bg px-4 py-3">
        <p className="text-text-primary">{NOT_SENT_TEXT[receipt.reason]}</p>
        {onReviewAgain !== undefined && REVIEW_AGAIN_REASONS.includes(receipt.reason) && (
          <Button variant="secondary" size="small" onClick={onReviewAgain} className="mt-3">
            Show the new card
          </Button>
        )}
      </div>
    );
  }
  const matchesApproval = approvedCheckCode !== null && approvedCheckCode === receipt.checkCode;
  const { message } = receipt;
  const time = formatSentTime(receipt.sentAt);
  return (
    <article data-role="send-receipt" className="my-2 rounded-md border border-border bg-card-bg">
      <header className="flex items-center gap-2 px-4 py-3">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-text-secondary" />
        <h3 className="min-w-0 flex-1 text-text-primary">Email sent</h3>
        <span className="shrink-0 text-text-secondary">Gmail</span>
      </header>

      <div className="border-t border-border px-4 py-3">
        <p className="text-text-primary" title={new Date(receipt.sentAt).toLocaleString()}>
          {matchesApproval ? `Sent at ${time}, exactly as approved` : `Sent at ${time}`}
        </p>
        {!matchesApproval && <p className="mt-2 text-text-primary">{SENT_MISMATCH_TEXT}</p>}
      </div>

      <div className="border-t border-border px-4 py-3">
        <p className="mb-2 text-text-secondary">What was sent</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          <dt className="text-text-secondary">To</dt>
          <dd className="break-words text-text-primary">{mailboxListText(message.to)}</dd>
          {message.cc.length > 0 && (
            <>
              <dt className="text-text-secondary">Copy</dt>
              <dd className="break-words text-text-primary">{mailboxListText(message.cc)}</dd>
            </>
          )}
          {message.bcc.length > 0 && (
            <>
              <dt className="text-text-secondary">Hidden copy</dt>
              <dd className="break-words text-text-primary">{mailboxListText(message.bcc)}</dd>
            </>
          )}
          <dt className="text-text-secondary">Subject</dt>
          <dd className="break-words text-text-primary">{message.subject === '' ? 'No subject' : message.subject}</dd>
          <CheckCodeRow code={receipt.checkCode} />
        </dl>
        {message.reply_to !== null && <p className="mt-2 text-text-primary">Replies go to: {message.reply_to}</p>}
      </div>

      <div className="border-t border-border">
        <p className="px-4 pt-3 text-text-secondary">Message body</p>
        <EmailBody body={message.body} />
      </div>
    </article>
  );
};

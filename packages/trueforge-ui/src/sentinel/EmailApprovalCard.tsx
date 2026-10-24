'use client';

import { mailboxText } from '@truefoundry/trueforge-core/core/permissions/tierMailbox';
import { useLayoutEffect, useRef, useState, type FC } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { Button } from '../atoms/primitives/Button.js';
import { APPROVAL_CHOICES, EMAIL_CHOICES, isNewRecipientCard } from './approvalChoices.js';
import { approvalTime, approveVerb, declineVerb, emailQuestion } from './approvalCopy.js';
import { ChangeRequestBox } from './ChangeRequestBox.js';
import { countEmailWords, isLongEmailBody, splitEmailBody } from './emailBody.js';
import {
  WAITING_FOR_YOU_LABEL,
  type SentinelApprovalCard,
  type SentinelApprovalEmail,
  type SentinelApprovalMailbox,
} from './types.js';

export type EmailApprovalCardProps = {
  /** Id of the approval this card answers; the composer banner finds the card by it. */
  approvalId: string;
  /** A card whose `email` is set. Anything else renders nothing. */
  card: SentinelApprovalCard;
  disabled?: boolean;
  onApprove: () => void;
  onDeny: () => void;
  /** Passed only when the card may be revised. The text is the change the person typed. */
  onChangeRequest?: ((text: string) => void) | undefined;
  /** Passed only when the server offers a draft option for this approval. */
  onSaveDraft?: (() => void) | undefined;
};

function mailboxListText(mailboxes: readonly SentinelApprovalMailbox[]): string {
  return mailboxes.map(mailbox => mailboxText(mailbox, { escape: text => text })).join(', ');
}

/** Lines of a message shown before it folds: nine lines at 1.5rem each. */
const COLLAPSED_HEIGHT_CLASS = 'max-h-[13.5rem] overflow-hidden';

/**
 * The message as the recipient sees it. Line breaks are kept, fenced code reads in mono, and a long
 * message folds to about nine lines. The word count is the whole message, not the visible part.
 */
function EmailBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // A single very long line wraps past nine lines without any line break; measure it so it still folds.
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (expanded || element === null || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      setClipped(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [expanded, body]);

  if (body === '') {
    return <p className="px-4 py-3 text-sm text-text-secondary">This message has no text.</p>;
  }

  const long = clipped || isLongEmailBody(body);
  const collapsed = long && !expanded;
  return (
    <div className="px-4 py-3">
      <div
        ref={bodyRef}
        className={cn('space-y-3 text-sm leading-6 text-text-primary', collapsed && COLLAPSED_HEIGHT_CLASS)}
      >
        {splitEmailBody(body).map((segment, index) =>
          segment.kind === 'code' ? (
            <pre
              // Segments only ever append, so the index is stable for this body.
              key={index}
              className="overflow-x-auto whitespace-pre rounded-sm bg-primary-bg px-3 py-2 font-mono text-xs leading-5 text-text-primary"
            >
              {segment.text}
            </pre>
          ) : (
            <p key={index} className="whitespace-pre-wrap break-words">
              {segment.text}
            </p>
          ),
        )}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
          }}
          className="mt-2 border-0 bg-transparent p-0 text-sm font-medium text-gold-ink underline"
        >
          {expanded ? 'Show less' : `Show full message · ${String(countEmailWords(body))} words`}
        </button>
      )}
    </div>
  );
}

/**
 * The card for a mail waiting on the person. It shows the metadata, the message as it will be sent, and
 * one sticky bar of actions. Each field appears once; a Copy or Hidden copy row shows only when there are some.
 */
export const EmailApprovalCard: FC<EmailApprovalCardProps> = ({
  approvalId,
  card,
  disabled = false,
  onApprove,
  onDeny,
  onChangeRequest,
  onSaveDraft,
}) => {
  const [changing, setChanging] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const email: SentinelApprovalEmail | null = card.email;
  if (email === null) return null;

  const sending = email.action === 'send';
  const sendNow = () => {
    setSentAt(approvalTime(new Date()));
    onApprove();
  };

  return (
    <article
      data-role="approval-ticket"
      data-approval-id={approvalId}
      data-kind="email"
      className="my-2 rounded-md border border-border bg-card-bg text-sm"
    >
      <header className="flex items-center gap-2 px-4 py-3">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-gold-ink" />
        <h3 className="min-w-0 flex-1 text-base font-medium text-text-primary">{emailQuestion(email)}</h3>
        <span className="shrink-0 text-text-secondary">Gmail</span>
        {sentAt === null && <span className="shrink-0 text-text-secondary">{WAITING_FOR_YOU_LABEL}</span>}
      </header>

      <div className="border-t border-border px-4 py-3">
        <p className="mb-2 text-sm text-text-secondary">What will be sent</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          {email.reply_in_thread !== null && (
            <>
              <dt className="text-text-secondary">Reply in the thread, subject</dt>
              <dd className="break-words text-text-primary">{email.reply_in_thread.subject}</dd>
              <dt className="text-text-secondary">Reply in the thread, from</dt>
              <dd className="break-words text-text-primary">{email.reply_in_thread.from}</dd>
            </>
          )}
          <dt className="text-text-secondary">To</dt>
          <dd className="break-words text-text-primary">{mailboxListText(email.to)}</dd>
          {email.cc.length > 0 && (
            <>
              <dt className="text-text-secondary">Copy</dt>
              <dd className="break-words text-text-primary">{mailboxListText(email.cc)}</dd>
            </>
          )}
          {email.bcc.length > 0 && (
            <>
              <dt className="text-text-secondary">Hidden copy</dt>
              <dd className="break-words text-text-primary">{mailboxListText(email.bcc)}</dd>
            </>
          )}
          <dt className="text-text-secondary">Subject</dt>
          <dd className="break-words text-text-primary">{email.subject === '' ? 'No subject' : email.subject}</dd>
        </dl>
        {email.reply_in_thread !== null && <p className="mt-2 text-text-secondary">Reply in existing thread</p>}
        {email.reply_to !== null && <p className="mt-2 text-text-primary">Replies go to: {email.reply_to}</p>}
        {email.replaces !== null && (
          <p className="mt-2 text-text-secondary">
            Replaces the saved draft “{email.replaces.subject}” to {mailboxListText(email.replaces.to)}
          </p>
        )}
        {/* For a new address the server's sentence says that approving adds it; the fields above do not. */}
        {isNewRecipientCard(card) && <p className="mt-2 text-text-primary">{card.plain_what}</p>}
        {card.plain_why !== null && <p className="mt-2 text-text-secondary">Why: {card.plain_why}</p>}
        {card.cannot_be_undone !== null && <p className="mt-2 text-text-secondary">{card.cannot_be_undone}</p>}
        {card.why_asked_again !== null && (
          <p className="mt-2 text-xs text-text-secondary">You have seen this before: {card.why_asked_again}</p>
        )}
      </div>

      <div className="border-t border-border">
        <p className="px-4 pt-3 text-sm text-text-secondary">Message body</p>
        <EmailBody body={email.body} />
      </div>

      {changing && onChangeRequest !== undefined && (
        <div className="border-t border-border px-4 py-3">
          <ChangeRequestBox
            disabled={disabled}
            onSend={text => {
              setChanging(false);
              onChangeRequest(text);
            }}
            onCancel={() => {
              setChanging(false);
            }}
          />
        </div>
      )}

      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border bg-card-bg px-4 py-3">
        {sentAt === null ? (
          <>
            <Button
              variant="primary"
              size="small"
              title={APPROVAL_CHOICES.approve.hint}
              onClick={sendNow}
              disabled={disabled}
              className="border-transparent bg-text-primary text-card-bg hover:bg-text-primary/90"
            >
              {approveVerb(card)}
            </Button>
            {onChangeRequest !== undefined && (
              <Button
                variant="secondary"
                size="small"
                title={EMAIL_CHOICES.edit.hint}
                aria-expanded={changing}
                onClick={() => {
                  setChanging(true);
                }}
                disabled={disabled}
              >
                {EMAIL_CHOICES.edit.label}
              </Button>
            )}
            {sending && onSaveDraft !== undefined && (
              <Button
                variant="secondary"
                size="small"
                title={EMAIL_CHOICES.saveDraft.hint}
                onClick={onSaveDraft}
                disabled={disabled}
              >
                {EMAIL_CHOICES.saveDraft.label}
              </Button>
            )}
            <Button
              variant="ghost"
              size="small"
              title={APPROVAL_CHOICES.deny.hint}
              onClick={onDeny}
              disabled={disabled}
              className="ml-auto border-transparent bg-transparent px-1 text-text-primary shadow-none hover:underline"
            >
              {declineVerb(card)}
            </Button>
          </>
        ) : (
          <p className="text-text-secondary">
            {sending ? 'Sent' : 'Saved'} · {sentAt}
          </p>
        )}
      </div>
    </article>
  );
};

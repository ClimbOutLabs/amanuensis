'use client';

import { mailboxText } from '@truefoundry/trueforge-core/core/permissions/tierMailbox';
import { useLayoutEffect, useRef, useState, type FC } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { useAssistantDisplayName } from '../components/PersonalizationContext.js';
import {
  ApprovalActions,
  ApprovalButton,
  ApprovalCardShell,
  ApprovalFacts,
  type ApprovalFact,
} from './ApprovalCardParts.js';
import { APPROVAL_CHOICES, EMAIL_CHOICES, isNewRecipientCard } from './approvalChoices.js';
import {
  approvalTime,
  approveVerb,
  cardConsequence,
  cardHeadline,
  cardReason,
  declineVerb,
  safeVerb,
} from './approvalCopy.js';
import { ChangeRequestBox } from './ChangeRequestBox.js';
import { countEmailWords, isLongEmailBody, splitEmailBody } from './emailBody.js';
import type { SentinelApprovalCard, SentinelApprovalEmail, SentinelApprovalMailbox } from './types.js';

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
    return <p className="px-4 py-3 text-text-secondary">This message has no text.</p>;
  }

  const long = clipped || isLongEmailBody(body);
  const collapsed = long && !expanded;
  return (
    // The message is what is being approved, so it reads at the chat's body size while the rest of the card is smaller.
    <div className="px-4 py-3 text-base">
      <div ref={bodyRef} className={cn('space-y-3 text-text-primary', collapsed && COLLAPSED_HEIGHT_CLASS)}>
        {splitEmailBody(body).map((segment, index) =>
          segment.kind === 'code' ? (
            <pre
              // Segments only ever append, so the index is stable for this body.
              key={index}
              className="overflow-x-auto whitespace-pre rounded-sm bg-primary-bg px-3 py-2 font-mono text-text-primary text-sm"
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
          className="mt-2 border-0 bg-transparent p-0 font-medium text-gold-ink underline"
        >
          {expanded ? 'Show less' : `Show full message · ${String(countEmailWords(body))} words`}
        </button>
      )}
    </div>
  );
}

/**
 * The card for a mail waiting on the person: the same layout as every approval card, with the message as it
 * will be sent under the facts and the choices in one bar that stays in view. Each field appears once; a Copy
 * or Hidden copy row shows only when there are some.
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
  const assistant = useAssistantDisplayName();
  const [changing, setChanging] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const email: SentinelApprovalEmail | null = card.email;
  if (email === null) return null;

  const sending = email.action === 'send';
  const sendNow = () => {
    setSentAt(approvalTime(new Date()));
    onApprove();
  };
  const facts: ApprovalFact[] = [
    ...(email.reply_in_thread === null
      ? []
      : [
          { label: 'Reply in the thread, subject', value: email.reply_in_thread.subject },
          { label: 'Reply in the thread, from', value: email.reply_in_thread.from },
        ]),
    { label: 'To', value: mailboxListText(email.to) },
    ...(email.cc.length > 0 ? [{ label: 'Copy', value: mailboxListText(email.cc) }] : []),
    ...(email.bcc.length > 0 ? [{ label: 'Hidden copy', value: mailboxListText(email.bcc) }] : []),
    ...(email.from_name === null || email.from_name === undefined
      ? []
      : [{ label: 'Sent as', value: email.from_name }]),
    ...(email.reply_to === null ? [] : [{ label: 'Replies go to', value: email.reply_to }]),
    { label: 'Subject', value: email.subject === '' ? 'No subject' : email.subject },
  ];
  // A send reaches other people and cannot be unsent, so the server marks its card safe-first: the no then
  // says "Don't send" and takes keyboard focus. Allow still leads the row and no choice is filled.
  const safeFirst = card.safe_choice === true;
  const consequence = cardConsequence(card);

  return (
    <ApprovalCardShell
      data-role="approval-ticket"
      data-approval-id={approvalId}
      data-kind="email"
      className="my-2"
      question={cardHeadline(card)}
      reason={cardReason(card)}
      status={
        sentAt === null ? { kind: 'waiting' } : { kind: 'answered', text: `${sending ? 'Sent' : 'Saved'} · ${sentAt}` }
      }
    >
      {/* For a new address the server's sentence says that approving adds it; the fields do not. */}
      {isNewRecipientCard(card) && <p className="text-text-primary">{card.plain_what}</p>}
      {consequence !== null && <p className="text-text-secondary">{consequence}</p>}
      {card.why_asked_again !== null && (
        <p className="text-text-secondary">You have seen this before: {card.why_asked_again}</p>
      )}

      <ApprovalFacts facts={facts} />
      {email.name_left_off === true && (
        <p className="text-text-primary">The name was left off an address because it looked like an address.</p>
      )}
      {email.replaces !== null && (
        <p className="text-text-secondary">
          Replaces the saved draft “{email.replaces.subject}” to {mailboxListText(email.replaces.to)}
        </p>
      )}

      <section aria-label="Message body" className="rounded-lg border border-border">
        <EmailBody body={email.body} />
      </section>

      {card.plain_why !== null && (
        <p className="text-text-secondary" data-role="approval-intent">
          {assistant} says: {card.plain_why}
        </p>
      )}

      {changing && onChangeRequest !== undefined && (
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
      )}

      {/* The negative margins match the card padding, so the bar spans the card edge to edge. */}
      <div className="sticky bottom-0 -mx-4 -mb-3.5 rounded-b-[0.625rem] bg-card-bg px-4 pb-3.5 pt-1">
        <ApprovalActions>
          <ApprovalButton
            {...(safeFirst ? {} : { 'data-approval-primary': true })}
            title={APPROVAL_CHOICES.approve.hint}
            onClick={sendNow}
            disabled={disabled}
          >
            {approveVerb(card)}
          </ApprovalButton>
          {onChangeRequest !== undefined && (
            <ApprovalButton
              title={EMAIL_CHOICES.changeIt.hint}
              aria-expanded={changing}
              onClick={() => {
                setChanging(true);
              }}
              disabled={disabled}
            >
              {EMAIL_CHOICES.changeIt.label}
            </ApprovalButton>
          )}
          {sending && onSaveDraft !== undefined && (
            <ApprovalButton title={EMAIL_CHOICES.saveDraft.hint} onClick={onSaveDraft} disabled={disabled}>
              {EMAIL_CHOICES.saveDraft.label}
            </ApprovalButton>
          )}
          <ApprovalButton
            {...(safeFirst ? { 'data-approval-primary': true } : {})}
            title={APPROVAL_CHOICES.deny.hint}
            onClick={onDeny}
            disabled={disabled}
          >
            {safeFirst ? safeVerb(card) : declineVerb(card)}
          </ApprovalButton>
        </ApprovalActions>
      </div>
    </ApprovalCardShell>
  );
};

'use client';

import { useRef, useState, type FC, type ReactNode } from 'react';

import { useAssistantDisplayName } from '../components/PersonalizationContext.js';
import { Icon } from '../icons/Icon.js';
import { AlwaysAllowToolControl } from './AlwaysAllowToolControl.js';
import { ApprovalActions, ApprovalButton, ApprovalCardShell, ApprovalFacts } from './ApprovalCardParts.js';
import {
  alwaysAllowConfirm,
  APPROVAL_CHOICES,
  isNewRecipientCard,
  isNewRecipientDraftCard,
  NEW_RECIPIENT_CHOICES,
  NEW_RECIPIENT_DRAFT_CHOICES,
} from './approvalChoices.js';
import {
  approvalFacts,
  cardConsequence,
  cardHeadline,
  cardReason,
  outboundRepeatsFacts,
  safeVerb,
} from './approvalCopy.js';
import { CalendarEventDetails } from './CalendarEventDetails.js';
import { ChangeRequestBox } from './ChangeRequestBox.js';
import { APPROVED_OUTCOME_TEXT, HELD_EXPIRED_TEXT, type HeldActionOutcome } from './heldActionErrors.js';
import { ScheduleDetails } from './ScheduleDetails.js';
import type { SentinelApprovalCard } from './types.js';

export type HeldActionStatus =
  | { kind: 'waiting' }
  | { kind: 'working' }
  /** Approved in this tab, with what became of the action. */
  | { kind: 'approved'; outcome: HeldActionOutcome }
  /** Approved in an earlier visit; only the chat itself shows what came of it. */
  | { kind: 'approved_earlier' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  /** Cannot run any more; asking again will not help. */
  | { kind: 'refused'; message: string }
  /** The answer did not go through; the buttons stay. */
  | { kind: 'failed'; message: string };

export type HeldActionCardProps = {
  card: SentinelApprovalCard;
  status: HeldActionStatus;
  /** Show "Always allow everywhere": the server only accepts it for some tools. */
  alwaysAllowOffered: boolean;
  /** Lets a person who cannot manage this chat read the card without answering it. */
  disabled?: boolean;
  onApprove: () => void;
  onAlwaysAllow: () => void;
  onDeny: () => void;
  /** Only passed for a card with editable content. Gets the text the person typed. */
  onChangeRequest?: ((text: string) => void) | undefined;
  /** The owner's own words after a "Change it" answer, shown under the card. */
  changeRequestNote?: ReactNode;
};

/** What became of an answered held action, in the words of the card's status line. */
function answeredStatus(status: Exclude<HeldActionStatus, { kind: 'waiting' } | { kind: 'failed' }>): {
  text: string;
  tick?: ReactNode;
} {
  switch (status.kind) {
    case 'working':
      return { text: 'Working on it...' };
    case 'approved':
      return {
        text: APPROVED_OUTCOME_TEXT[status.outcome],
        tick: (
          <Icon
            name={status.outcome === 'done' ? 'circle-check' : 'info'}
            className={`shrink-0 ${status.outcome === 'done' ? 'text-success-bg' : 'text-text-secondary'}`}
            aria-hidden="true"
          />
        ),
      };
    case 'approved_earlier':
      return { text: 'Approved. See the result in the chat.' };
    case 'refused':
      return { text: status.message };
    case 'denied':
      return {
        text: 'Denied. Nothing was done.',
        tick: <Icon name="circle-xmark" className="shrink-0 text-failure-bg" aria-hidden="true" />,
      };
    case 'expired':
      return { text: HELD_EXPIRED_TEXT };
  }
}

/**
 * One action a scheduled run held for its owner. Written for someone who was not there when the
 * model decided: what will happen, to whom, and the exact text come from the server, and the
 * model's own reason is shown last because it is the model's word, not a checked fact.
 */
export const HeldActionCard: FC<HeldActionCardProps> = ({
  card,
  status,
  alwaysAllowOffered,
  disabled = false,
  onApprove,
  onAlwaysAllow,
  onDeny,
  onChangeRequest,
  changeRequestNote,
}) => {
  const assistant = useAssistantDisplayName();
  const canAnswer = status.kind === 'waiting' || status.kind === 'failed';
  const [changing, setChanging] = useState(false);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  // Approving a new-recipient card adds its addresses, so it never offers "Always allow" and its labels say so,
  // in draft words when the card saves a draft instead of sending.
  const newRecipients = isNewRecipientCard(card);
  const newRecipientDraft = isNewRecipientDraftCard(card);
  const approveChoice = newRecipientDraft
    ? NEW_RECIPIENT_DRAFT_CHOICES.approve
    : newRecipients
      ? NEW_RECIPIENT_CHOICES.approve
      : APPROVAL_CHOICES.approve;
  const denyChoice = newRecipientDraft
    ? NEW_RECIPIENT_DRAFT_CHOICES.cancel
    : newRecipients
      ? NEW_RECIPIENT_CHOICES.cancel
      : APPROVAL_CHOICES.deny;
  // Allow always leads the row and no choice is filled. On a card the server marks safe-first (irreversible,
  // or reaching other people) the no at the end keeps its safe words, such as "Keep it".
  const denyLabel =
    card.safe_choice === true && !newRecipients && !newRecipientDraft ? safeVerb(card) : denyChoice.label;
  const consequence = cardConsequence(card);

  return (
    <li className="list-none" data-role="held-action">
      <ApprovalCardShell
        question={cardHeadline(card)}
        reason={cardReason(card)}
        status={canAnswer ? { kind: 'waiting' } : { kind: 'answered', ...answeredStatus(status) }}
      >
        {card.why_asked_again !== null && (
          <p className="text-text-secondary" data-role="held-action-why-held">
            {card.why_asked_again}
          </p>
        )}

        <ApprovalFacts facts={approvalFacts(card)} />

        {card.calendar_event !== null && <CalendarEventDetails event={card.calendar_event} />}

        {card.schedule !== null && <ScheduleDetails schedule={card.schedule} />}

        {card.outbound_text !== null && !outboundRepeatsFacts(card, card.outbound_text) && (
          <div className="rounded border border-border bg-primary-bg px-3 py-2">
            <p className="mb-1 font-medium text-text-secondary">Full request</p>
            {card.outbound_truncated && (
              <p className="mb-1 font-medium text-text-primary" data-role="held-action-truncated">
                Part of this is not shown in full. Check it before you approve.
              </p>
            )}
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text-primary">
              {card.outbound_text}
            </pre>
          </div>
        )}

        {consequence !== null && (
          <p className="flex items-start gap-2 text-text-secondary">
            <Icon name="info" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{consequence}</span>
          </p>
        )}

        {card.plain_why !== null && (
          <p className="text-text-secondary" data-role="held-action-reason">
            {assistant} says: {card.plain_why}
          </p>
        )}

        {status.kind === 'failed' && (
          <p role="alert" className="text-failure-bg">
            {status.message}
          </p>
        )}

        <ApprovalActions>
          <ApprovalButton title={approveChoice.hint} onClick={onApprove} disabled={disabled}>
            {approveChoice.label}
          </ApprovalButton>
          {alwaysAllowOffered && !newRecipients && (
            <AlwaysAllowToolControl
              size="large"
              disabled={disabled}
              confirm={alwaysAllowConfirm({
                covers: undefined,
                toolSay: `${assistant} will run this tool on this connector without asking, in every chat.`,
              })}
              onConfirm={onAlwaysAllow}
              className="aui-approval-card__choice"
            />
          )}
          {onChangeRequest !== undefined && (
            <ApprovalButton
              ref={changeButtonRef}
              title={APPROVAL_CHOICES.changeIt.hint}
              aria-expanded={changing}
              onClick={() => {
                setChanging(true);
              }}
              disabled={disabled}
            >
              {APPROVAL_CHOICES.changeIt.label}
            </ApprovalButton>
          )}
          <ApprovalButton title={denyChoice.hint} onClick={onDeny} disabled={disabled}>
            {denyLabel}
          </ApprovalButton>
        </ApprovalActions>
        {changing && onChangeRequest !== undefined && (
          <ChangeRequestBox
            disabled={disabled}
            onSend={text => {
              setChanging(false);
              onChangeRequest(text);
            }}
            onCancel={() => {
              setChanging(false);
              changeButtonRef.current?.focus();
            }}
          />
        )}
      </ApprovalCardShell>
      {changeRequestNote}
    </li>
  );
};

'use client';

import { useRef, useState, type FC } from 'react';

import { GoldTick } from '../atoms/Reward.js';
import { useAssistantDisplayName } from '../components/PersonalizationContext.js';
import { useRewardLedger } from '../hooks/useRewardLedger.js';
import { Icon } from '../icons/Icon.js';
import { AlwaysAllowToolControl } from './AlwaysAllowToolControl.js';
import { ApprovalActions, ApprovalButton, ApprovalCardShell, ApprovalFacts, FoldedText } from './ApprovalCardParts.js';
import { alwaysAllowConfirm, APPROVAL_CHOICES, isNewRecipientCard } from './approvalChoices.js';
import {
  approvalFacts,
  approvalSentLine,
  approvalTime,
  approveVerb,
  cardConsequence,
  cardHeadline,
  cardReason,
  declineVerb,
  outboundRepeatsFacts,
  safeVerb,
} from './approvalCopy.js';
import { CalendarEventDetails } from './CalendarEventDetails.js';
import { ChangeRequestBox } from './ChangeRequestBox.js';
import { PersonaDetails } from './PersonaDetails.js';
import { sameScheduleTools, ScheduleDetails, scheduleToolsRequest } from './ScheduleDetails.js';
import { SkillDetails } from './SkillDetails.js';
import type { SentinelApprovalCard } from './types.js';

export type PermissionApprovalCardProps = {
  /** Id of the approval this card answers; the composer banner finds the card by it. */
  approvalId: string;
  card: SentinelApprovalCard;
  /** True for the one card per screen that takes the gold edge. Set by the container. */
  highlighted?: boolean;
  /** How many other approvals wait on the person. The approval tick never plays while any do. */
  othersWaiting: number;
  onApprove: () => void;
  /** Only passed when the server declared a chat-scoped allow for this call. */
  onApproveForChat?: (() => void) | undefined;
  /**
   * Records a standing "Always allow everywhere" grant and approves this call. Only passed when the
   * server says the owner may always allow this tool; the card asks for confirmation first.
   */
  onApproveAlways?: (() => void) | undefined;
  /** Set when that answer lets maps run without asking, instead of allowing one tool. */
  alwaysAllowCovers?: 'maps' | undefined;
  onDeny: () => void;
  /** Only passed for a card with editable content. Gets the text the person typed. */
  onChangeRequest?: ((text: string) => void) | undefined;
  /**
   * Approves every pending Tier 2 call in one step. Only the container passes it, and
   * only for a Tier 2 card with other Tier 2 calls waiting; Tier 3 never gets it.
   */
  onApproveAll?: (() => void) | undefined;
  /** How many Tier 2 calls "Approve all" covers, shown on its button. */
  batchSize?: number | undefined;
  disabled?: boolean;
  /**
   * Shows what will be sent open above the choices instead of behind Details. For a card built on this
   * screen from the call alone, whose arguments are the only place the recipient or address appears.
   */
  outboundOpen?: boolean;
};

/** The search service's own fields: kept out of the way, but still listed, behind a closed disclosure. */
function PlumbingDetails({ text }: { text: string }) {
  return (
    <details className="rounded border border-border bg-primary-bg px-3 py-2">
      <summary className="cursor-pointer text-text-secondary">Search service details</summary>
      <p className="mb-1 mt-2 font-medium text-text-secondary">Also sent by the search service</p>
      <FoldedText
        text={text}
        as="pre"
        className="max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono text-text-primary text-sm"
      />
    </details>
  );
}

/**
 * The main block of "Exactly what will be sent": every line except the search service's own, which the
 * Details disclosure lists. Lines are matched exactly, so nothing is dropped from the full list.
 */
function visibleOutboundText(text: string, plumbing: string | null): string {
  if (plumbing === null) return text;
  const folded = new Set(plumbing.split('\n'));
  return text
    .split('\n')
    .filter(line => !folded.has(line))
    .join('\n');
}

function OutboundBlock({ text, truncated }: { text: string; truncated: boolean }) {
  return (
    <div className="rounded border border-border bg-primary-bg px-3 py-2">
      <p className="mb-1 font-medium text-text-secondary">Full request</p>
      {truncated && <p className="mb-1 text-text-primary">Part of what will be sent is not shown in full.</p>}
      <FoldedText
        text={text}
        as="pre"
        className="max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono text-text-primary text-sm"
      />
    </div>
  );
}

/**
 * Approval card for browser, calendar, schedule, persona, command and connector actions. The question is the
 * title under its status line, the server's reason sits under it, each fact shows once, and the choices
 * share one row. The raw request and the standing grant fold into Details, which shows only when it holds
 * something the card does not already say. Mail uses EmailApprovalCard instead.
 */
export const PermissionApprovalCard: FC<PermissionApprovalCardProps> = ({
  approvalId,
  card,
  highlighted = false,
  othersWaiting,
  onApprove,
  onApproveForChat,
  onApproveAlways,
  alwaysAllowCovers,
  onDeny,
  onChangeRequest,
  onApproveAll,
  batchSize,
  disabled = false,
  outboundOpen = false,
}) => {
  const assistant = useAssistantDisplayName();
  const [changing, setChanging] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [ticking, setTicking] = useState(false);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const { tryPlay } = useRewardLedger();

  const { calendar_event: calendarEvent, schedule, persona, skill } = card;
  const cardTools = schedule?.tools;
  const [pickedTools, setPickedTools] = useState(cardTools);
  // Approving saves what the card shows, so other choices must come back on a new card first.
  const toolsChanged =
    cardTools !== undefined && pickedTools !== undefined && !sameScheduleTools(pickedTools, cardTools);
  // A new-recipient send never offers a standing grant or a chat-wide allow: approving it adds addresses.
  const newRecipients = isNewRecipientCard(card);
  const plumbingText = card.outbound_plumbing_text ?? null;
  const visibleOutbound =
    card.outbound_text === null ? null : visibleOutboundText(card.outbound_text, plumbingText) || null;
  // A page's own address is already the Address row, so its request is not shown a second time.
  const outboundShown =
    visibleOutbound !== null && plumbingText === null && outboundRepeatsFacts(card, visibleOutbound)
      ? null
      : visibleOutbound;
  const alwaysOffered = onApproveAlways !== undefined && !newRecipients;
  const hasDetails = (!outboundOpen && outboundShown !== null) || plumbingText !== null || alwaysOffered;
  const consequence = cardConsequence(card);
  // Allow always leads the row and no choice is filled. On a card the server marks safe-first (irreversible,
  // or reaching other people) the no keeps its safe words and stays the keyboard focus target.
  const safeFirst = card.safe_choice === true;

  // The tick plays only for an approval the ledger allows; otherwise the card simply says it is done.
  const markSent = (send: () => void) => () => {
    const now = new Date();
    setTicking(
      tryPlay({
        request: { kind: 'tear' },
        context: { busy: false, waitingOnPerson: othersWaiting > 0, hasError: false, scheduleFailedToday: false },
        now,
      }),
    );
    setSentAt(approvalTime(now));
    send();
  };

  const answered = sentAt !== null;
  const busy = disabled || answered;

  return (
    <ApprovalCardShell
      data-role="approval-ticket"
      data-approval-id={approvalId}
      question={cardHeadline(card)}
      reason={cardReason(card)}
      highlighted={highlighted}
      status={
        answered
          ? {
              kind: 'answered',
              text: approvalSentLine(card, sentAt),
              tick: <GoldTick play={ticking} className="size-4 text-gold-ink" />,
            }
          : { kind: 'waiting' }
      }
    >
      {consequence !== null && (
        <p className="flex items-start gap-2 text-text-secondary">
          <Icon name="info" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{consequence}</span>
        </p>
      )}

      {card.why_asked_again !== null && (
        <p className="text-text-secondary">You have seen this before: {card.why_asked_again}</p>
      )}

      <ApprovalFacts facts={approvalFacts(card)} />

      {calendarEvent !== null && <CalendarEventDetails event={calendarEvent} />}

      {schedule !== null && (
        <ScheduleDetails
          schedule={schedule}
          picker={
            pickedTools === undefined || onChangeRequest === undefined
              ? undefined
              : {
                  picked: pickedTools,
                  onPick: setPickedTools,
                  onUpdate: () => {
                    onChangeRequest(scheduleToolsRequest(pickedTools));
                  },
                  disabled: busy,
                }
          }
        />
      )}

      {persona !== null && <PersonaDetails persona={persona} />}

      {skill !== null && <SkillDetails skill={skill} />}

      {outboundOpen && outboundShown !== null && (
        <OutboundBlock text={outboundShown} truncated={card.outbound_truncated} />
      )}

      {card.plain_why !== null && (
        <p className="text-text-secondary" data-role="approval-intent">
          {assistant} says: {card.plain_why}
        </p>
      )}

      <ApprovalActions>
        <ApprovalButton
          {...(safeFirst ? {} : { 'data-approval-primary': true })}
          title={APPROVAL_CHOICES.approve.hint}
          onClick={markSent(onApprove)}
          disabled={busy || toolsChanged}
        >
          {approveVerb(card)}
        </ApprovalButton>
        {/* The server offers a chat-wide grant only where it is safe, so the card shows it, never folds it away. */}
        {onApproveForChat !== undefined && !newRecipients && (
          <ApprovalButton
            title={APPROVAL_CHOICES.approveForChat.hint}
            onClick={markSent(onApproveForChat)}
            disabled={busy}
          >
            {APPROVAL_CHOICES.approveForChat.label}
          </ApprovalButton>
        )}
        {onApproveAll !== undefined && (
          <ApprovalButton onClick={onApproveAll} disabled={disabled}>
            {batchSize === undefined ? 'Approve all' : `Approve all (${String(batchSize)})`}
          </ApprovalButton>
        )}
        {onChangeRequest !== undefined && (
          <ApprovalButton
            ref={changeButtonRef}
            title={APPROVAL_CHOICES.changeIt.hint}
            aria-expanded={changing}
            onClick={() => {
              setChanging(true);
            }}
            disabled={busy}
          >
            {APPROVAL_CHOICES.changeIt.label}
          </ApprovalButton>
        )}
        <ApprovalButton
          {...(safeFirst ? { 'data-approval-primary': true } : {})}
          title={APPROVAL_CHOICES.deny.hint}
          onClick={onDeny}
          disabled={busy}
        >
          {safeFirst ? safeVerb(card) : declineVerb(card)}
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

      {hasDetails && (
        <details>
          <summary className="cursor-pointer text-text-secondary underline">Details</summary>
          <div className="mt-2 space-y-3">
            {!outboundOpen && outboundShown !== null && (
              <OutboundBlock text={outboundShown} truncated={card.outbound_truncated} />
            )}
            {plumbingText !== null && <PlumbingDetails text={plumbingText} />}
            {onApproveAlways !== undefined && !newRecipients && (
              <AlwaysAllowToolControl
                size="small"
                disabled={busy}
                confirm={alwaysAllowConfirm({
                  covers: alwaysAllowCovers,
                  toolSay: `${assistant} will run this kind of action on this connector without asking, in every chat.`,
                })}
                onConfirm={markSent(onApproveAlways)}
              />
            )}
          </div>
        </details>
      )}
    </ApprovalCardShell>
  );
};

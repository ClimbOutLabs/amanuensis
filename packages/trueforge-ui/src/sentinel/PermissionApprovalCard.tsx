'use client';

import { mailboxText } from '@truefoundry/trueforge-core/core/permissions/tierMailbox';
import { useRef, useState, type FC } from 'react';

import { Button } from '../atoms/primitives/Button.js';
import { Icon } from '../icons/Icon.js';
import { APPROVAL_CHOICES } from './approvalChoices.js';
import { CALENDAR_BADGES, CalendarEventDetails } from './CalendarEventDetails.js';
import { ChangeRequestBox } from './ChangeRequestBox.js';
import { PERSONA_BADGE, PersonaDetails } from './PersonaDetails.js';
import { SCHEDULE_BADGES, ScheduleDetails } from './ScheduleDetails.js';
import type {
  SentinelApprovalCard,
  SentinelApprovalEmail,
  SentinelApprovalEmailAction,
  SentinelApprovalMailbox,
} from './types.js';

type ApprovalCardTier = 2 | 3;

/** Characters shown before a long value is folded behind "Show all". */
const FOLD_PREVIEW_CHARS = 500;

const TIER_LABELS: Record<ApprovalCardTier, string> = { 2: 'Needs your OK', 3: 'Review carefully' };

const EMAIL_BADGES: Record<SentinelApprovalEmailAction, string> = {
  send: 'Send email',
  save: 'Save draft',
  change: 'Change draft',
};

export type PermissionApprovalCardProps = {
  toolName: string;
  card: SentinelApprovalCard;
  /** Tier the server sent; it only changes the badge, never the controls. */
  tier: ApprovalCardTier;
  onApprove: () => void;
  /** Only passed when the server declared a chat-scoped allow for this call. */
  onApproveForChat?: (() => void) | undefined;
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
};

/** Text folded after a preview, cut on code points so a surrogate pair is never split. */
function FoldedText({ text, as: Tag, className }: { text: string; as: 'pre' | 'span'; className: string }) {
  const [expanded, setExpanded] = useState(false);
  const points = Array.from(text);
  const isLong = points.length > FOLD_PREVIEW_CHARS;
  const shown = isLong && !expanded ? `${points.slice(0, FOLD_PREVIEW_CHARS).join('')}...` : text;
  return (
    <>
      <Tag className={className}>{shown}</Tag>
      {isLong && (
        <button
          type="button"
          onClick={() => {
            setExpanded(!expanded);
          }}
          aria-expanded={expanded}
          className="mt-1 block text-xs font-medium text-text-secondary underline hover:text-text-primary"
        >
          {expanded ? 'Show less' : `Show all (${String(points.length - FOLD_PREVIEW_CHARS)} more characters)`}
        </button>
      )}
    </>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <dt className="shrink-0 text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</dt>
      <dd className="min-w-0">
        <FoldedText
          text={value}
          as="span"
          className={`text-text-primary ${mono ? 'break-all font-mono text-xs' : 'break-words'}`}
        />
      </dd>
    </div>
  );
}

function mailboxListText(mailboxes: readonly SentinelApprovalMailbox[]): string {
  return mailboxes.map(mailbox => mailboxText(mailbox, { escape: text => text })).join(', ');
}

/** What a change replaces, with the recipients of that saved draft. */
function ReplacesRow({ replaces }: { replaces: NonNullable<SentinelApprovalEmail['replaces']> }) {
  return (
    <dl className="rounded border border-border bg-primary-bg px-3 py-2">
      <DetailRow label="Replaces" value={replaces.subject} />
      <DetailRow label="Replaced draft to" value={mailboxListText(replaces.to)} />
    </dl>
  );
}

/** The whole message, never cut: the body scrolls in its own box instead of being folded. */
function EmailMessage({ email }: { email: SentinelApprovalEmail }) {
  return (
    <div className="rounded border border-border bg-primary-bg px-3 py-2">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-secondary">Exactly what will be sent</p>
      {email.reply_in_thread !== null && (
        <dl className="mb-1">
          <DetailRow label="Reply in the thread, subject" value={email.reply_in_thread.subject} />
          <DetailRow label="Reply in the thread, from" value={email.reply_in_thread.from} />
        </dl>
      )}
      <p className="break-words text-sm text-text-primary">To: {mailboxListText(email.to)}</p>
      {email.cc.length > 0 && (
        <p className="break-words text-sm text-text-primary">Copy: {mailboxListText(email.cc)}</p>
      )}
      {email.bcc.length > 0 && (
        <p className="break-words text-sm text-text-primary">Hidden copy: {mailboxListText(email.bcc)}</p>
      )}
      <p className="break-words text-sm text-text-primary">Subject: {email.subject}</p>
      <p className="mb-1 mt-3 text-xs font-medium uppercase tracking-wide text-text-secondary">
        Message, exactly as sent
      </p>
      <div
        role="region"
        aria-label="Message, exactly as sent"
        tabIndex={0}
        className="max-h-80 overflow-auto rounded border border-border bg-card-bg px-3 py-2"
      >
        <p className="whitespace-pre-wrap break-words text-sm text-text-primary">
          {email.body === '' ? 'This message has no text.' : email.body}
        </p>
      </div>
    </div>
  );
}

function OutboundBlock({ text, truncated }: { text: string; truncated: boolean }) {
  return (
    <div className="rounded border border-border bg-primary-bg px-3 py-2">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-secondary">Exactly what will be sent</p>
      {truncated && <p className="mb-1 text-sm text-text-primary">Part of what will be sent is not shown in full.</p>}
      <FoldedText
        text={text}
        as="pre"
        className="max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-text-primary"
      />
    </div>
  );
}

/**
 * Plain-language approval card for Tier 3 actions and Tier 2 actions that ask. Every row renders only what the server sent:
 * `plain_what` is always present, everything else renders when non-null. The parsed
 * command renders whenever the card carries one; the server only attaches it to shell
 * cards, so the card never needs to know which tool it is. The card never infers the
 * tier; the container only mounts it for an explicit Tier 2 or Tier 3 approval.
 */
export const PermissionApprovalCard: FC<PermissionApprovalCardProps> = ({
  toolName,
  card,
  tier,
  onApprove,
  onApproveForChat,
  onDeny,
  onChangeRequest,
  onApproveAll,
  batchSize,
  disabled = false,
}) => {
  const [changing, setChanging] = useState(false);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const hasDetails =
    card.destination !== null ||
    card.recipient !== null ||
    card.amount !== null ||
    card.parsed_command !== null ||
    card.destination_host !== null;

  const { email, calendar_event: calendarEvent, schedule, persona } = card;
  const badge =
    email !== null
      ? EMAIL_BADGES[email.action]
      : calendarEvent !== null
        ? CALENDAR_BADGES[calendarEvent.action]
        : schedule !== null
          ? SCHEDULE_BADGES[schedule.action]
          : persona !== null
            ? PERSONA_BADGE
            : null;
  return (
    <div className="rounded-lg border border-border bg-card-bg">
      <div className="flex items-center justify-between gap-3 rounded-t-lg border-b border-border bg-secondary-bg px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="lock" className="shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="truncate text-sm font-semibold text-text-primary">Approval needed</span>
          {badge === null ? (
            <span className="min-w-0 truncate rounded bg-primary-bg px-1.5 py-0.5 font-mono text-xs text-text-secondary">
              {toolName}
            </span>
          ) : (
            <span className="min-w-0 truncate rounded bg-primary-bg px-1.5 py-0.5 text-xs text-text-secondary">
              {badge}
            </span>
          )}
        </div>
        <span className="shrink-0 rounded border border-border bg-primary-bg px-2 py-0.5 text-[0.6875rem] font-medium text-text-secondary">
          {TIER_LABELS[tier]}
        </span>
      </div>

      <div className="space-y-3 px-4 py-3">
        <p className="text-sm text-text-primary">{card.plain_what}</p>
        {card.plain_why !== null && <p className="text-sm text-text-secondary">Agent says: {card.plain_why}</p>}

        {card.cannot_be_undone !== null && (
          <p className="flex items-start gap-2 text-sm text-text-secondary">
            <Icon name="info" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{card.cannot_be_undone}</span>
          </p>
        )}

        {card.why_asked_again !== null && (
          <p className="text-xs text-text-secondary">You have seen this before: {card.why_asked_again}</p>
        )}

        {email !== null && email.replaces !== null && <ReplacesRow replaces={email.replaces} />}

        {hasDetails && (
          <dl className="space-y-1.5 rounded border border-border bg-primary-bg px-3 py-2">
            {card.destination !== null && <DetailRow label="Destination" value={card.destination} mono />}
            {card.recipient !== null && <DetailRow label="Recipient" value={card.recipient} />}
            {card.amount !== null && <DetailRow label="Amount" value={card.amount} mono />}
            {card.parsed_command !== null && <DetailRow label="Command" value={card.parsed_command} mono />}
            {card.destination_host !== null && <DetailRow label="Sends to" value={card.destination_host} mono />}
          </dl>
        )}

        {email !== null && <EmailMessage email={email} />}

        {calendarEvent !== null && <CalendarEventDetails event={calendarEvent} />}

        {schedule !== null && <ScheduleDetails schedule={schedule} />}

        {persona !== null && <PersonaDetails persona={persona} />}

        {card.outbound_text !== null && <OutboundBlock text={card.outbound_text} truncated={card.outbound_truncated} />}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="small"
            title={APPROVAL_CHOICES.approve.hint}
            onClick={onApprove}
            disabled={disabled}
            className="flex-1"
          >
            {APPROVAL_CHOICES.approve.label}
          </Button>
          {onApproveForChat !== undefined && (
            <Button
              variant="secondary"
              size="small"
              title={APPROVAL_CHOICES.approveForChat.hint}
              onClick={onApproveForChat}
              disabled={disabled}
              className="flex-1"
            >
              {APPROVAL_CHOICES.approveForChat.label}
            </Button>
          )}
          {onChangeRequest !== undefined && (
            <Button
              ref={changeButtonRef}
              variant="secondary"
              size="small"
              title={APPROVAL_CHOICES.changeIt.hint}
              aria-expanded={changing}
              onClick={() => {
                setChanging(true);
              }}
              disabled={disabled}
              className="flex-1"
            >
              {APPROVAL_CHOICES.changeIt.label}
            </Button>
          )}
          <Button
            variant="secondary"
            size="small"
            title={APPROVAL_CHOICES.deny.hint}
            onClick={onDeny}
            disabled={disabled}
            className="flex-1"
          >
            {APPROVAL_CHOICES.deny.label}
          </Button>
        </div>
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
        {onApproveAll !== undefined && (
          <Button variant="secondary" size="small" onClick={onApproveAll} disabled={disabled} className="w-full">
            {batchSize === undefined ? 'Approve all' : `Approve all (${String(batchSize)})`}
          </Button>
        )}
      </div>
    </div>
  );
};

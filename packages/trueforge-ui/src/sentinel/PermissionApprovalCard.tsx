'use client';

import { isSearchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';
import { useRef, useState, type FC } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { Button } from '../atoms/primitives/Button.js';
import { StubTear } from '../atoms/Reward.js';
import { useRewardLedger } from '../hooks/useRewardLedger.js';
import { Icon } from '../icons/Icon.js';
import { AlwaysAllowToolControl } from './AlwaysAllowToolControl.js';
import { APPROVAL_CHOICES, isNewRecipientCard } from './approvalChoices.js';
import {
  approvalQuestion,
  approvalSentLine,
  approvalStub,
  approvalTime,
  approveVerb,
  declineVerb,
  searchHoldParts,
} from './approvalCopy.js';
import { CalendarEventDetails } from './CalendarEventDetails.js';
import { ChangeRequestBox } from './ChangeRequestBox.js';
import { PersonaDetails } from './PersonaDetails.js';
import { ScheduleDetails } from './ScheduleDetails.js';
import { WAITING_FOR_YOU_LABEL, type SentinelApprovalCard } from './types.js';

/** Characters shown before a long value is folded behind "Show all". */
const FOLD_PREVIEW_CHARS = 500;
/** A held search's query is a few lines on a phone; the rest waits behind "Show all". */
const QUERY_PREVIEW_CHARS = 160;

export type PermissionApprovalCardProps = {
  /** Id of the approval this card answers; the composer banner finds the card by it. */
  approvalId: string;
  card: SentinelApprovalCard;
  /** True for the one card per screen that takes the gold fill and edge. Set by the container. */
  highlighted?: boolean;
  /** How many other approvals wait on the person. A stub never tears while any do. */
  othersWaiting: number;
  onApprove: () => void;
  /** Only passed when the server declared a chat-scoped allow for this call. */
  onApproveForChat?: (() => void) | undefined;
  /**
   * Records a standing "Always allow this tool" grant and approves this call. Only passed when the
   * server says the owner may always allow this tool; the card asks for confirmation first.
   */
  onApproveAlways?: (() => void) | undefined;
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
function FoldedText({
  text,
  as: Tag,
  className,
  previewChars = FOLD_PREVIEW_CHARS,
}: {
  text: string;
  as: 'pre' | 'span';
  className: string;
  previewChars?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const points = Array.from(text);
  const isLong = points.length > previewChars;
  const shown = isLong && !expanded ? `${points.slice(0, previewChars).join('')}...` : text;
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
          {expanded ? 'Show less' : `Show all (${String(points.length - previewChars)} more characters)`}
        </button>
      )}
    </>
  );
}

/** A held search: the query in a quiet mono quote, then the reason in body text. */
function HeldSearchText({ query, reason }: { query: string; reason: string }) {
  return (
    <div className="space-y-2">
      {query !== '' && (
        <FoldedText
          text={query}
          as="pre"
          previewChars={QUERY_PREVIEW_CHARS}
          className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 font-mono text-sm text-text-primary"
        />
      )}
      <p className="text-sm text-text-primary">{reason}</p>
    </div>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <dt className="shrink-0 text-xs font-medium text-text-secondary">{label}</dt>
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

/** The search service's own fields: kept out of the way, but still listed, behind a closed disclosure. */
function PlumbingDetails({ text }: { text: string }) {
  return (
    <details className="rounded border border-border bg-primary-bg px-3 py-2">
      <summary className="cursor-pointer text-sm text-text-secondary">Search service details</summary>
      <p className="mb-1 mt-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
        Also sent by the search service
      </p>
      <FoldedText
        text={text}
        as="pre"
        className="max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-text-primary"
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
      <p className="mb-1 text-xs font-medium text-text-secondary">Full request</p>
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
 * Approval ticket for calendar, schedule, specialist and other non-mail actions. The question is the
 * title, the rows show only what the server sent, and the stub says what it is and where it stands. The
 * raw request and the connector's arguments fold into Details. Mail uses EmailApprovalCard instead.
 */
export const PermissionApprovalCard: FC<PermissionApprovalCardProps> = ({
  approvalId,
  card,
  highlighted = false,
  othersWaiting,
  onApprove,
  onApproveForChat,
  onApproveAlways,
  onDeny,
  onChangeRequest,
  onApproveAll,
  batchSize,
  disabled = false,
}) => {
  const [changing, setChanging] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [tearing, setTearing] = useState(false);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const { tryPlay } = useRewardLedger();
  const hasDetails =
    card.destination !== null ||
    card.recipient !== null ||
    card.amount !== null ||
    card.parsed_command !== null ||
    card.destination_host !== null;

  const { calendar_event: calendarEvent, schedule, persona } = card;
  // A new-recipient send never offers a standing grant or a chat-wide allow: approving it adds addresses.
  const newRecipients = isNewRecipientCard(card);
  const stub = approvalStub(card, { sentAt });
  const heldSearch = searchHoldParts(card.plain_what);
  // A held search whose sentence has no known reason: its whole sentence is body text, not the title.
  const heldSearchSentence = heldSearch === undefined && isSearchHoldCardText(card.plain_what) ? card.plain_what : null;
  // A held search's chat choice only lifts its private-read check, so it says what it lets through.
  const chatChoice = isSearchHoldCardText(card.plain_what)
    ? APPROVAL_CHOICES.allowSearchesForChat
    : APPROVAL_CHOICES.approveForChat;
  const plumbingText = card.outbound_plumbing_text ?? null;
  const outboundShown =
    card.outbound_text === null ? null : visibleOutboundText(card.outbound_text, plumbingText) || null;

  // The stub tears only for an approval the ledger allows; otherwise it simply goes.
  const markSent = (send: () => void) => () => {
    const now = new Date();
    setTearing(
      tryPlay({
        request: { kind: 'tear' },
        context: { busy: false, waitingOnPerson: othersWaiting > 0, hasError: false, scheduleFailedToday: false },
        now,
      }),
    );
    setSentAt(approvalTime(now));
    send();
  };

  const stubContent = (
    <>
      <p className="aui-ticket__label text-text-secondary">{stub.what}</p>
      {stub.detail !== null && <p className="aui-ticket__detail text-sm text-text-primary">{stub.detail}</p>}
      {stub.state !== null && <p className="aui-ticket__label text-gold-ink">{stub.state}</p>}
    </>
  );

  return (
    <article
      data-role="approval-ticket"
      data-approval-id={approvalId}
      className={cn('aui-ticket aui-ticket--stub aui-ticket--punch aui-settle', highlighted && 'aui-ticket--selected')}
    >
      <div className="min-w-0 space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="aui-ticket__title min-w-0 text-text-primary">{approvalQuestion(card)}</h3>
          {sentAt === null ? (
            <span className="aui-ticket__label shrink-0 rounded-full border border-gold-line px-2 py-0.5 text-gold-ink">
              {WAITING_FOR_YOU_LABEL}
            </span>
          ) : (
            <span className="aui-ticket__label shrink-0 rounded-full border border-gold-line px-2 py-0.5 text-gold-ink">
              {approvalSentLine(card, sentAt)}
            </span>
          )}
        </div>
        {heldSearch !== undefined && <HeldSearchText query={heldSearch.query} reason={heldSearch.reason} />}
        {heldSearchSentence !== null && (
          <FoldedText
            text={heldSearchSentence}
            as="span"
            previewChars={QUERY_PREVIEW_CHARS}
            className="block break-words text-sm text-text-primary"
          />
        )}

        {card.plain_why !== null && <p className="text-sm text-text-secondary">Why: {card.plain_why}</p>}

        {card.cannot_be_undone !== null && (
          <p className="flex items-start gap-2 text-sm text-text-secondary">
            <Icon name="info" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{card.cannot_be_undone}</span>
          </p>
        )}

        {card.why_asked_again !== null && (
          <p className="text-xs text-text-secondary">You have seen this before: {card.why_asked_again}</p>
        )}

        {hasDetails && (
          <dl className="space-y-1.5 rounded border border-border bg-primary-bg px-3 py-2">
            {card.destination !== null && <DetailRow label="Destination" value={card.destination} mono />}
            {card.recipient !== null && <DetailRow label="Recipient" value={card.recipient} />}
            {card.amount !== null && <DetailRow label="Amount" value={card.amount} mono />}
            {card.parsed_command !== null && <DetailRow label="Command" value={card.parsed_command} mono />}
            {card.destination_host !== null && <DetailRow label="Sends to" value={card.destination_host} mono />}
          </dl>
        )}

        {calendarEvent !== null && <CalendarEventDetails event={calendarEvent} />}

        {schedule !== null && <ScheduleDetails schedule={schedule} />}

        {persona !== null && <PersonaDetails persona={persona} />}

        <div
          className={cn(
            'flex flex-wrap gap-2 transition-opacity duration-150 motion-reduce:transition-none',
            sentAt !== null && 'pointer-events-none opacity-0',
          )}
          aria-hidden={sentAt !== null}
        >
          <Button
            variant="primary"
            size="small"
            title={APPROVAL_CHOICES.approve.hint}
            onClick={markSent(onApprove)}
            disabled={disabled || sentAt !== null}
            className="flex-1"
          >
            {approveVerb(card)}
          </Button>
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
              disabled={disabled || sentAt !== null}
              className="flex-1"
            >
              {APPROVAL_CHOICES.changeIt.label}
            </Button>
          )}
          <Button
            variant="ghost"
            size="small"
            title={APPROVAL_CHOICES.deny.hint}
            onClick={onDeny}
            disabled={disabled || sentAt !== null}
            className="flex-1 text-gold-ink"
          >
            {declineVerb(card)}
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

        <details className="text-sm">
          <summary className="cursor-pointer text-text-secondary underline">Details</summary>
          <div className="mt-2 space-y-3">
            {outboundShown !== null && <OutboundBlock text={outboundShown} truncated={card.outbound_truncated} />}
            {plumbingText !== null && <PlumbingDetails text={plumbingText} />}
            {onApproveForChat !== undefined && !newRecipients && (
              <Button
                variant="secondary"
                size="small"
                title={chatChoice.hint}
                onClick={markSent(onApproveForChat)}
                disabled={disabled || sentAt !== null}
              >
                {chatChoice.label}
              </Button>
            )}
            {onApproveAlways !== undefined && !newRecipients && (
              <AlwaysAllowToolControl
                size="small"
                disabled={disabled || sentAt !== null}
                description="The agent will run this kind of action on this connector without asking, in every chat."
                onConfirm={markSent(onApproveAlways)}
              />
            )}
          </div>
        </details>
      </div>
      {sentAt === null && <div className="aui-ticket__stub">{stubContent}</div>}
      <StubTear play={tearing} onDone={() => setTearing(false)} className="aui-ticket__stub">
        {stubContent}
      </StubTear>
    </article>
  );
};

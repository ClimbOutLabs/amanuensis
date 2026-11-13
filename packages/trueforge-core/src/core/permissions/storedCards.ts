/**
 * Approval cards stored before each recipient carried a name hold recipients as bare address strings. These
 * read them in the name-and-address form, so every reader sees one shape. Values already in that form, and
 * events that are not approvals, pass through unchanged.
 */
import { z } from 'zod';

import type { SessionEventItem } from '../../agent-session/schemas/events';
import type { TurnState } from '../../agent-session/schemas/turn';
import { ApprovalToolCallRefSchema, EventType } from '../events/schema';
import { Tier3CardSchema, Tier3EmailSchema } from './tier';
import { readStoredMailbox, StoredMailboxSchema, type Tier3Mailbox } from './tierMailbox';

type ApprovalToolCallRef = z.infer<typeof ApprovalToolCallRefSchema>;
type Tier3Card = z.infer<typeof Tier3CardSchema>;
type Tier3Email = z.infer<typeof Tier3EmailSchema>;

function storedMailboxes(recipients: readonly unknown[]): Tier3Mailbox[] {
  return recipients.map(recipient => StoredMailboxSchema.parse(recipient));
}

function withStoredRecipients(email: Tier3Email): Tier3Email {
  return {
    ...email,
    // Cards stored before the sending account was recorded hold no sent_from; they read as not known.
    sent_from: email.sent_from ?? null,
    to: storedMailboxes(email.to),
    cc: storedMailboxes(email.cc),
    bcc: storedMailboxes(email.bcc),
    replaces: email.replaces === null ? null : { ...email.replaces, to: storedMailboxes(email.replaces.to) },
  };
}

type Tier3CalendarEvent = NonNullable<Tier3Card['calendar_event']>;

/**
 * The guest line a stored calendar event carries. Cards written before the line was carried hold only
 * the flag it was rendered from, so the line is rebuilt from that flag in plain words; a card with no
 * guests never carried a line.
 */
function storedGuestsLine(event: unknown): string {
  if (!isRecord(event)) {
    return '';
  }
  if (typeof event['guests_line'] === 'string' && event['guests_line'] !== '') {
    return event['guests_line'];
  }
  const attendees = event['attendees'];
  if (!Array.isArray(attendees) || attendees.length === 0) {
    return '';
  }
  if (event['guests_emailed'] === true) {
    return 'The guests will be emailed about this.';
  }
  if (event['guests_emailed'] === false) {
    return 'The guests will not be emailed about this.';
  }
  return '';
}

function withStoredGuestsLine(event: Tier3CalendarEvent): Tier3CalendarEvent {
  return { ...event, guests_line: storedGuestsLine(event) };
}

function upgradeToolCall(call: ApprovalToolCallRef): ApprovalToolCallRef {
  const card = call.tier3_card;
  if (card == null) {
    return call;
  }
  return {
    ...call,
    tier3_card: {
      ...card,
      email: card.email == null ? card.email : withStoredRecipients(card.email),
      calendar_event: card.calendar_event == null ? card.calendar_event : withStoredGuestsLine(card.calendar_event),
    },
  };
}

/** One event of a chat's timeline with its approval cards upgraded; other events are returned as they are. */
export function upgradeStoredSessionEventItem(item: SessionEventItem): SessionEventItem {
  const { event } = item;
  if (event.type !== EventType.TOOL_APPROVAL_REQUIRED) {
    return item;
  }
  return { ...item, event: { ...event, tool_calls: event.tool_calls.map(upgradeToolCall) } };
}

/** A turn state with the approval cards it still waits on upgraded; its other fields are unchanged. */
export function upgradeStoredTurnState(state: TurnState): TurnState {
  if (state.status !== 'done') {
    return state;
  }
  return {
    ...state,
    required_actions: state.required_actions.map(action =>
      action.type === EventType.TOOL_APPROVAL_REQUIRED
        ? { ...action, tool_calls: action.tool_calls.map(upgradeToolCall) }
        : action,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The same upgrade for an archive, whose values are not yet checked. A recipient that does not read as either
 * shape is left as it is, so the strict read that follows reports it.
 */
function archivedRecipients(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const recipients: unknown[] = value;
  return recipients.map(recipient => readStoredMailbox(recipient) ?? recipient);
}

function archivedCard(email: Record<string, unknown>): Record<string, unknown> {
  const replaces = email['replaces'];
  return {
    ...email,
    to: archivedRecipients(email['to']),
    cc: archivedRecipients(email['cc']),
    bcc: archivedRecipients(email['bcc']),
    replaces: isRecord(replaces) ? { ...replaces, to: archivedRecipients(replaces['to']) } : replaces,
    // Archives written before reply addresses existed replied to the sender.
    reply_to: email['reply_to'] ?? null,
  };
}

/** An archived calendar event with its guest line filled from the flag older archives hold instead. */
function archivedCalendarEvent(event: Record<string, unknown>): Record<string, unknown> {
  const upgraded: Record<string, unknown> = { ...event, guests_line: storedGuestsLine(event) };
  delete upgraded['guests_emailed'];
  return upgraded;
}

function archivedToolCall(call: unknown): unknown {
  if (!isRecord(call) || !isRecord(call['tier3_card'])) {
    return call;
  }
  const card = call['tier3_card'];
  // Archives written before cards carried their rendered copy hold no copy key. The strict read requires
  // the key, so it is filled with null, the value a card still carries until a later step fills its wording.
  const withCopy: Record<string, unknown> = { ...card, copy: card['copy'] ?? null };
  const withCalendar: Record<string, unknown> = isRecord(card['calendar_event'])
    ? { ...withCopy, calendar_event: archivedCalendarEvent(card['calendar_event']) }
    : withCopy;
  return isRecord(card['email'])
    ? { ...call, tier3_card: { ...withCalendar, email: archivedCard(card['email']) } }
    : { ...call, tier3_card: withCalendar };
}

/** An archived event with its approval cards upgraded; any other value is returned as it is. */
export function upgradeArchivedApprovalEvent(event: unknown): unknown {
  if (!isRecord(event) || event['type'] !== EventType.TOOL_APPROVAL_REQUIRED || !Array.isArray(event['tool_calls'])) {
    return event;
  }
  const calls: unknown[] = event['tool_calls'];
  return { ...event, tool_calls: calls.map(archivedToolCall) };
}

/** An archived turn state with the approval cards it still waits on upgraded. */
export function upgradeArchivedTurnState(state: unknown): unknown {
  if (!isRecord(state) || !Array.isArray(state['required_actions'])) {
    return state;
  }
  const actions: unknown[] = state['required_actions'];
  return { ...state, required_actions: actions.map(upgradeArchivedApprovalEvent) };
}

/**
 * Approval cards stored before each recipient carried a name hold recipients as bare address strings. These
 * read them in the name-and-address form, so every reader sees one shape. Values already in that form, and
 * events that are not approvals, pass through unchanged.
 */
import { z } from 'zod';

import type { SessionEventItem } from '../../agent-session/schemas/events';
import type { TurnState } from '../../agent-session/schemas/turn';
import { mailboxOf } from '../email/gmail/mailbox';
import { ApprovalToolCallRefSchema, EventType } from '../events/schema';
import { Tier3EmailSchema } from './tier';
import { Tier3MailboxSchema, type Tier3Mailbox } from './tierMailbox';

type ApprovalToolCallRef = z.infer<typeof ApprovalToolCallRefSchema>;
type Tier3Email = z.infer<typeof Tier3EmailSchema>;

const StoredMailboxSchema = z.union([Tier3MailboxSchema, z.string().transform(address => mailboxOf(address))]);

function storedMailboxes(recipients: readonly unknown[]): Tier3Mailbox[] {
  return recipients.map(recipient => StoredMailboxSchema.parse(recipient));
}

function withStoredRecipients(email: Tier3Email): Tier3Email {
  return {
    ...email,
    to: storedMailboxes(email.to),
    cc: storedMailboxes(email.cc),
    bcc: storedMailboxes(email.bcc),
    replaces: email.replaces === null ? null : { ...email.replaces, to: storedMailboxes(email.replaces.to) },
  };
}

function upgradeToolCall(call: ApprovalToolCallRef): ApprovalToolCallRef {
  const card = call.tier3_card;
  if (card?.email == null) {
    return call;
  }
  return { ...call, tier3_card: { ...card, email: withStoredRecipients(card.email) } };
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
  return recipients.map(recipient => {
    const parsed = StoredMailboxSchema.safeParse(recipient);
    return parsed.success ? parsed.data : recipient;
  });
}

function archivedCard(email: Record<string, unknown>): Record<string, unknown> {
  const replaces = email['replaces'];
  return {
    ...email,
    to: archivedRecipients(email['to']),
    cc: archivedRecipients(email['cc']),
    bcc: archivedRecipients(email['bcc']),
    replaces: isRecord(replaces) ? { ...replaces, to: archivedRecipients(replaces['to']) } : replaces,
  };
}

function archivedToolCall(call: unknown): unknown {
  if (!isRecord(call) || !isRecord(call['tier3_card'])) {
    return call;
  }
  const card = call['tier3_card'];
  return isRecord(card['email']) ? { ...call, tier3_card: { ...card, email: archivedCard(card['email']) } } : call;
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

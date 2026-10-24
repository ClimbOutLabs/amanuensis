import { isNewRecipientCard, NEW_RECIPIENT_CHOICES } from './approvalChoices.js';
import type { SentinelApprovalCard, SentinelApprovalEmail, SentinelApprovalMailbox } from './types.js';

/**
 * The title of a mail card. A send names its first recipient, so the person sees who it goes to
 * without opening anything. The button is the uniform Allow, not the title's verb.
 */
export function emailQuestion(email: SentinelApprovalEmail): string {
  if (email.action !== 'send') return 'Save this draft?';
  if (email.to.length === 0) return email.reply_in_thread !== null ? 'Send this reply?' : 'Send this email?';
  const to = recipientsText(email.to);
  return email.reply_in_thread !== null ? `Send this reply to ${to}?` : `Send this email to ${to}?`;
}

/** The people a card sends to, in plain words: the first name, then how many more. */
function recipientsText(recipients: readonly SentinelApprovalMailbox[]): string {
  const [first, ...rest] = recipients;
  if (first === undefined) return 'no one';
  const name = first.name === '' ? first.address : first.name;
  if (rest.length === 0) return name;
  return `${name} and ${String(rest.length)} more`;
}

/** The question a ticket asks, one sentence the person can answer with a verb. */
export function approvalQuestion(card: SentinelApprovalCard): string {
  const { email, calendar_event: event, schedule, persona } = card;
  if (email !== null) return emailQuestion(email);
  if (event !== null) {
    return event.action === 'create'
      ? `Add "${event.title}" to your calendar?`
      : `Change "${event.title}" in your calendar?`;
  }
  if (schedule !== null) {
    return schedule.action === 'create'
      ? `Create the schedule "${schedule.name}"?`
      : `Delete the schedule "${schedule.name}"?`;
  }
  if (persona !== null) return `Add the specialist "${persona.name}"?`;
  return card.plain_what;
}

/** The verb on the primary button: Allow for every card, except a new-recipient send, which says it adds its addresses. */
export function approveVerb(card: SentinelApprovalCard): string {
  // Approving a new-recipient send adds its addresses to the send list, so it says so.
  if (isNewRecipientCard(card)) return NEW_RECIPIENT_CHOICES.approve.label;
  return 'Allow';
}

/** The verb on the quiet button that says no: Not now, except a new-recipient send, which says Don't send. */
export function declineVerb(card: SentinelApprovalCard): string {
  if (isNewRecipientCard(card)) return NEW_RECIPIENT_CHOICES.cancel.label;
  return 'Not now';
}

/** Word for a finished approval, shown in the stub and the badge. */
function doneWord(card: SentinelApprovalCard): string {
  if (card.email === null) return 'Done';
  if (card.email.action === 'send') return 'Sent';
  return 'Saved';
}

/** Short time for a finished approval, e.g. 09:14. */
export function approvalTime(now: Date): string {
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The badge after an approval: "Sent to Rui · 09:14", or "Done · 09:14" for other kinds. */
export function approvalSentLine(card: SentinelApprovalCard, time: string): string {
  if (card.email !== null && card.email.action === 'send') {
    return `Sent to ${recipientsText(card.email.to)} · ${time}`;
  }
  return `${doneWord(card)} · ${time}`;
}

export type ApprovalStub = {
  /** What the ticket is, in a few words: "New schedule", "Changed event". */
  what: string;
  /** What it holds: the event or the schedule name. */
  detail: string;
};

function stubWhat(card: SentinelApprovalCard): string {
  const { calendar_event: event, schedule, persona } = card;
  if (event !== null) return event.action === 'create' ? 'New event' : 'Changed event';
  if (schedule !== null) return schedule.action === 'create' ? 'New schedule' : 'Delete schedule';
  if (persona !== null) return 'New specialist';
  return 'Action';
}

function stubDetail(card: SentinelApprovalCard): string {
  const { calendar_event: event, schedule, persona } = card;
  if (event !== null) return event.title;
  if (schedule !== null) return schedule.name;
  if (persona !== null) return persona.name;
  return card.destination ?? card.recipient ?? 'Open Details to see what it does';
}

/** The stub of a ticket that is not a mail: what it is and what it holds. The header pill is the one status line, so the stub carries no state. */
export function approvalStub(card: SentinelApprovalCard): ApprovalStub {
  return {
    what: stubWhat(card),
    detail: stubDetail(card),
  };
}

/** What a mail card is called in the banner: "1 email waiting for your approval". */
export function approvalKindNoun(card: SentinelApprovalCard): string {
  const { email, calendar_event: event, schedule, persona } = card;
  if (email !== null) return 'email';
  if (event !== null) return 'calendar change';
  if (schedule !== null) return 'schedule change';
  if (persona !== null) return 'specialist';
  return 'action';
}

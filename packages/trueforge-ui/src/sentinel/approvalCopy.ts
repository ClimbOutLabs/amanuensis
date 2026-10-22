import { isNewRecipientCard, NEW_RECIPIENT_CHOICES } from './approvalChoices.js';
import type { SentinelApprovalCard, SentinelApprovalMailbox } from './types.js';

/** Labels over the text an approval sends. Every card kind reads them from here. */
export const SENT_CONTENT_LABELS = {
  whatWillBeSent: 'What will be sent',
  messageBody: 'Message body',
} as const;

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
  if (email !== null) {
    const to = recipientsText(email.to);
    switch (email.action) {
      case 'send':
        return email.reply_in_thread !== null ? `Send this reply to ${to}?` : `Send this email to ${to}?`;
      case 'save':
        return 'Save this draft?';
      case 'change':
        return 'Change this saved draft?';
    }
  }
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

/** The verb on the safe button: what "yes" does, in the card's own words. */
export function approveVerb(card: SentinelApprovalCard): string {
  // Approving a new-recipient send adds its addresses to the send list, so it says so.
  if (isNewRecipientCard(card)) return NEW_RECIPIENT_CHOICES.approve.label;
  const { email, calendar_event: event, schedule, persona } = card;
  if (email !== null) return email.action === 'send' ? 'Send it' : 'Save it';
  if (event !== null) return event.action === 'create' ? 'Add it' : 'Save it';
  if (schedule !== null) return schedule.action === 'create' ? 'Create it' : 'Delete it';
  if (persona !== null) return 'Create it';
  return 'Allow it';
}

/** The verb on the quiet button that says no. */
export function declineVerb(card: SentinelApprovalCard): string {
  if (isNewRecipientCard(card)) return NEW_RECIPIENT_CHOICES.cancel.label;
  return card.email !== null && card.email.action === 'send' ? "Don't send" : 'Not now';
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
  /** What the ticket is, in a few words: REPLY TO RUI, NEW SCHEDULE. */
  what: string;
  /** What it holds: the subject, the event or the schedule name. */
  detail: string;
  /** The state: WAITING FOR YOU, or SENT with the time. */
  state: string;
};

function stubWhat(card: SentinelApprovalCard): string {
  const { email, calendar_event: event, schedule, persona } = card;
  if (email !== null) {
    switch (email.action) {
      case 'send':
        return email.reply_in_thread !== null
          ? `Reply to ${recipientsText(email.to)}`
          : `Email to ${recipientsText(email.to)}`;
      case 'save':
        return 'New draft';
      case 'change':
        return 'Changed draft';
    }
  }
  if (event !== null) return event.action === 'create' ? 'New event' : 'Changed event';
  if (schedule !== null) return schedule.action === 'create' ? 'New schedule' : 'Delete schedule';
  if (persona !== null) return 'New specialist';
  return 'Action';
}

function stubDetail(card: SentinelApprovalCard): string {
  const { email, calendar_event: event, schedule, persona } = card;
  if (email !== null) return email.subject === '' ? 'No subject' : email.subject;
  if (event !== null) return event.title;
  if (schedule !== null) return schedule.name;
  if (persona !== null) return persona.name;
  return card.destination ?? card.recipient ?? 'Open Details to see what it does';
}

/** The stub of an approval ticket. `sentAt` is the time it was sent, or null while it waits. */
export function approvalStub(card: SentinelApprovalCard, { sentAt }: { sentAt: string | null }): ApprovalStub {
  return {
    what: stubWhat(card),
    detail: stubDetail(card),
    state: sentAt === null ? 'Waiting for you' : `${doneWord(card)} ${sentAt}`,
  };
}

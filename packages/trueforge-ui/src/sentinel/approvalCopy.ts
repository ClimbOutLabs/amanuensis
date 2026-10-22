import { HOLD_SAY, isSearchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';

import { isNewRecipientCard, NEW_RECIPIENT_CHOICES } from './approvalChoices.js';
import type { SentinelApprovalCard, SentinelApprovalEmail, SentinelApprovalMailbox } from './types.js';

/** Title of a held web search card; its query and reason sit under it as body text. */
export const HELD_SEARCH_TITLE = 'Web search';

/**
 * The query and the reason of a held search card, read back from its sentence. Undefined for any other
 * card, and for a saved search sentence that does not end in a known reason.
 */
export function searchHoldParts(text: string): { query: string; reason: string } | undefined {
  if (!isSearchHoldCardText(text)) return undefined;
  const reason = Object.values(HOLD_SAY).find(say => text.endsWith(` ${say}`));
  if (reason === undefined) return undefined;
  // The sentence reads "<prefix>: <query>. <reason>"; the prefix ends at the first ": ". Only the closing
  // period is dropped, so a query that ends in "." keeps it.
  const subject = text.slice(0, text.length - reason.length - 1);
  const start = subject.indexOf(': ');
  const query = start === -1 ? '' : subject.slice(start + 2).replace(/\.$/, '');
  return { query, reason };
}

/**
 * The title of a mail card. Its verb is the verb on the primary button, so the title and the button
 * always name the same action.
 */
export function emailQuestion(email: SentinelApprovalEmail): string {
  if (email.action !== 'send') return 'Save this draft?';
  return email.reply_in_thread !== null ? 'Send this reply?' : 'Send this email?';
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
  if (isSearchHoldCardText(card.plain_what)) return HELD_SEARCH_TITLE;
  return card.plain_what;
}

/** The verb on the primary button: what "yes" does, in the card's own words. */
export function approveVerb(card: SentinelApprovalCard): string {
  // Approving a new-recipient send adds its addresses to the send list, so it says so.
  if (isNewRecipientCard(card)) return NEW_RECIPIENT_CHOICES.approve.label;
  const { email, calendar_event: event, schedule, persona } = card;
  if (email !== null) return email.action === 'send' ? 'Send' : 'Save draft';
  if (event !== null) return event.action === 'create' ? 'Add it' : 'Save it';
  if (schedule !== null) return schedule.action === 'create' ? 'Create it' : 'Delete it';
  if (persona !== null) return 'Create it';
  return 'Allow it';
}

/** The verb on the quiet button that says no. */
export function declineVerb(card: SentinelApprovalCard): string {
  if (isNewRecipientCard(card)) return NEW_RECIPIENT_CHOICES.cancel.label;
  if (card.email === null) return 'Not now';
  return card.email.action === 'send' ? "Don't send" : "Don't save";
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
  /** What it holds: the event or the schedule name. Null when nothing more useful is known. */
  detail: string | null;
  /** The state once done: Done with the time. Null while it waits, since the badge already says so. */
  state: string | null;
};

function stubWhat(card: SentinelApprovalCard): string {
  const { calendar_event: event, schedule, persona } = card;
  if (isSearchHoldCardText(card.plain_what)) return HELD_SEARCH_TITLE;
  if (event !== null) return event.action === 'create' ? 'New event' : 'Changed event';
  if (schedule !== null) return schedule.action === 'create' ? 'New schedule' : 'Delete schedule';
  if (persona !== null) return 'New specialist';
  return 'Action';
}

function stubDetail(card: SentinelApprovalCard): string | null {
  const { calendar_event: event, schedule, persona } = card;
  if (event !== null) return event.title;
  if (schedule !== null) return schedule.name;
  if (persona !== null) return persona.name;
  return card.destination ?? card.recipient ?? null;
}

/** The stub of a ticket that is not a mail. `sentAt` is the time it was approved, or null while it waits. */
export function approvalStub(card: SentinelApprovalCard, { sentAt }: { sentAt: string | null }): ApprovalStub {
  return {
    what: stubWhat(card),
    detail: stubDetail(card),
    state: sentAt === null ? null : `${doneWord(card)} ${sentAt}`,
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

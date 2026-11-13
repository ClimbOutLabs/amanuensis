import {
  isNewRecipientCard,
  isNewRecipientDraftCard,
  NEW_RECIPIENT_CHOICES,
  NEW_RECIPIENT_DRAFT_CHOICES,
} from './approvalChoices.js';
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

/**
 * The headline a card leads with: the server's copy when the card carries it. Cards saved before
 * copy existed fall back to the question built from their fields, or to the generic headline when
 * the card has no fields to build one from.
 */
export function cardHeadline(card: SentinelApprovalCard): string {
  return card.copy?.headline ?? approvalQuestion(card);
}

/**
 * The headline for a card with neither copy nor the fields a question is built from. A card saved
 * before copy existed can carry a raw server sentence as its plain_what, identifiers and all (an
 * old calendar card named the event by its id), so that sentence never appears on a headline
 * surface: not the card's title, not the strip, not the stub, not the spoken line. The card's own
 * detail rows still show what the card holds, so the person can judge it there.
 */
export const GENERIC_CARD_HEADLINE = 'Needs your OK';

/**
 * The consequence line a card shows: the copy's consequence on a card with copy, the older
 * cannot-be-undone note on a card saved before copy existed.
 */
export function cardConsequence(card: SentinelApprovalCard): string | null {
  return card.copy !== null && card.copy !== undefined ? card.copy.consequence : card.cannot_be_undone;
}

/** The tier reason a card shows behind "Why I'm asking"; null when the tier gave none. */
export function cardReason(card: SentinelApprovalCard): string | null {
  return card.copy?.reason ?? null;
}

/**
 * The question a ticket asks, one sentence the person can answer with a verb, built from the
 * card's own fields. A card with none of those fields gets the generic headline instead of its
 * stored plain_what: a sentence saved before copy existed is not checked wording and may carry
 * an identifier, so it is never the question a surface shows.
 */
export function approvalQuestion(card: SentinelApprovalCard): string {
  const { email, calendar_event: event, schedule, persona, skill } = card;
  if (email != null) return emailQuestion(email);
  if (event != null) {
    return event.action === 'create'
      ? `Add "${event.title}" to your calendar?`
      : `Change "${event.title}" in your calendar?`;
  }
  if (schedule != null) {
    return schedule.action === 'create'
      ? `Create the schedule "${schedule.name}"?`
      : `Delete the schedule "${schedule.name}"?`;
  }
  if (persona != null) return `Add the persona "${persona.name}"?`;
  if (skill != null) return `Add the skill "${skill.name}"?`;
  return GENERIC_CARD_HEADLINE;
}

/** The verb on the primary button: Allow for every card, except a new-recipient card, which says it adds its addresses. */
export function approveVerb(card: SentinelApprovalCard): string {
  // Approving a new-recipient card adds its addresses to the send list, so it says so, in send or draft words.
  if (isNewRecipientDraftCard(card)) return NEW_RECIPIENT_DRAFT_CHOICES.approve.label;
  if (isNewRecipientCard(card)) return NEW_RECIPIENT_CHOICES.approve.label;
  return 'Allow';
}

/** The verb on the quiet button that says no: Not now, except a new-recipient card, which says what will not happen. */
export function declineVerb(card: SentinelApprovalCard): string {
  if (isNewRecipientDraftCard(card)) return NEW_RECIPIENT_DRAFT_CHOICES.cancel.label;
  if (isNewRecipientCard(card)) return NEW_RECIPIENT_CHOICES.cancel.label;
  return 'Not now';
}

/**
 * The words on the safe choice, which is the primary button whenever the server marks the card
 * safe-first: Keep it for a destructive action, Don't send or Don't save for mail, Not now otherwise.
 * A new-recipient card keeps its own cancel words, which say what will not happen.
 */
export function safeVerb(card: SentinelApprovalCard): string {
  if (isNewRecipientDraftCard(card)) return NEW_RECIPIENT_DRAFT_CHOICES.cancel.label;
  if (isNewRecipientCard(card)) return NEW_RECIPIENT_CHOICES.cancel.label;
  if (card.email != null) return card.email.action === 'send' ? "Don't send" : "Don't save";
  if (card.destructive === true) return 'Keep it';
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
  if (card.email != null && card.email.action === 'send') {
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
  const { calendar_event: event, schedule, persona, skill } = card;
  if (event != null) return event.action === 'create' ? 'New event' : 'Changed event';
  if (schedule != null) return schedule.action === 'create' ? 'New schedule' : 'Delete schedule';
  if (persona != null) return 'New persona';
  if (skill != null) return 'New skill';
  return 'Approval';
}

function stubDetail(card: SentinelApprovalCard): string {
  const { calendar_event: event, schedule, persona, skill } = card;
  if (event != null) return event.title;
  if (schedule != null) return schedule.name;
  if (persona != null) return persona.name;
  if (skill != null) return skill.name;
  return card.destination ?? card.recipient ?? cardHeadline(card);
}

/** The stub of a ticket that is not a mail: what it is and what it holds. The header pill is the one status line, so the stub carries no state. */
export function approvalStub(card: SentinelApprovalCard): ApprovalStub {
  return {
    what: stubWhat(card),
    detail: stubDetail(card),
  };
}

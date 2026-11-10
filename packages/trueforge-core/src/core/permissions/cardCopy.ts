import type { ApprovalCardCopy, Tier3Email } from './tier';
import type { Tier3Mailbox } from './tierMailbox';

/**
 * One owner per action kind for the words an approval card is made of. Callers supply checked facts
 * (a title, a time, a recipient, an amount); the owner for the kind decides what becomes the headline,
 * what becomes the consequence line, and what becomes the reason behind "Why I'm asking". The UI
 * renders the three parts and never builds sentences of its own.
 *
 * No part ever carries an internal id: an event is named by its title and time, an email by its
 * recipient and subject, a file by its name. When a fact the owner needs is missing, the caller
 * refuses the action instead of asking for copy (see the calendar refusal in caldavTier.ts).
 */

/** The sentences that make one line, in order, skipping the ones that do not apply; null when none apply. */
export function joinLine(parts: readonly (string | null)[]): string | null {
  const present = parts.filter((part): part is string => part !== null && part !== '');
  return present.length === 0 ? null : present.join(' ');
}

/**
 * Calendar copy, shared by the CalDAV card and the Google Calendar card. The headline is the one
 * question; who gets emailed about the change and what cannot be undone form the consequence;
 * the tier's own sentence (who always asks, and why) is the reason.
 */
export function calendarCardCopy(input: {
  headline: string;
  emailed: string | null;
  undo: string | null;
  reason: string | null;
}): ApprovalCardCopy {
  return {
    headline: input.headline,
    consequence: joinLine([input.emailed, input.undo]),
    reason: input.reason,
  };
}

/** The first recipient as a person names them: their name, or their address when they have no name. */
function firstRecipientText(recipients: readonly Tier3Mailbox[]): string | null {
  const [first, ...rest] = recipients;
  if (first === undefined) {
    return null;
  }
  const name = first.name === '' ? first.address : first.name;
  return rest.length === 0 ? name : `${name} and ${String(rest.length)} more`;
}

/** Email copy: a send names its first recipient; a saved draft reaches no one, so it has no consequence. */
export function emailCardCopy(email: Tier3Email): ApprovalCardCopy {
  if (email.action === 'save') {
    return { headline: 'Save this draft?', consequence: null, reason: null };
  }
  if (email.action === 'change') {
    return { headline: 'Change this draft?', consequence: null, reason: null };
  }
  const to = firstRecipientText(email.to);
  const headline =
    to === null
      ? email.reply_in_thread !== null
        ? 'Send this reply?'
        : 'Send this email?'
      : email.reply_in_thread !== null
        ? `Send this reply to ${to}?`
        : `Send this email to ${to}?`;
  return { headline, consequence: "Once this is sent, it can't be unsent.", reason: null };
}

/** File copy: the headline already names the file; what cannot be undone is the consequence. */
export function fileCardCopy(input: { headline: string; undo: string | null }): ApprovalCardCopy {
  return { headline: input.headline, consequence: input.undo, reason: null };
}

/** Payment copy: the headline names the amount and who it goes to, never a transaction id. */
export function paymentCardCopy(input: {
  amount: string;
  recipient: string | null;
  destination: string | null;
}): ApprovalCardCopy {
  const where = input.recipient ?? input.destination;
  return {
    headline: where === null ? `Pay ${input.amount}?` : `Pay ${input.amount} to ${where}?`,
    consequence: "Once this is sent, it can't be unsent.",
    reason: null,
  };
}

/** Sandbox copy: the headline names the run; the reason says why this run asks when it does. */
export function sandboxCardCopy(input: {
  headline: string;
  undo: string | null;
  reason: string | null;
}): ApprovalCardCopy {
  return { headline: input.headline, consequence: input.undo, reason: input.reason };
}

/**
 * Copy for a kind whose card sentence is already one checked question (a schedule, a persona, a held
 * search): the question is the headline, what cannot be undone is the consequence, and the sentence
 * that says why this kind asks is the reason.
 */
export function simpleCardCopy(input: {
  headline: string;
  undo: string | null;
  reason: string | null;
}): ApprovalCardCopy {
  return { headline: input.headline, consequence: input.undo, reason: input.reason };
}

/**
 * Browser copy: opening a page or clicking a commit button sends nothing the card has to warn about
 * beyond the action itself, so there is no consequence; why the open asks is the reason.
 */
export function browserCardCopy(input: { headline: string; reason: string | null }): ApprovalCardCopy {
  return { headline: input.headline, consequence: null, reason: input.reason };
}

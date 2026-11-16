import type { ReviewableDraft } from '../email/gmail/draftReview';
import { escapeDisplayText } from './displayText';
import { mailboxText, type Tier3Mailbox } from './tierMailbox';

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^[^.!?\n]+[.!?]?/.exec(trimmed);
  return (match !== null ? match[0] : trimmed).trim().slice(0, 280);
}

/** Null when the agent gave no reason, so the card shows no line instead of an empty one. */
export function plainWhy(agentIntent: string | null): string | null {
  if (agentIntent === null || agentIntent.trim() === '') {
    return null;
  }
  return firstSentence(agentIntent);
}

/** Most characters of a subject or name the card shows inside its sentence. */
const CARD_TEXT_MAX_CHARS = 80;

/** Already-escaped items in a sentence: `A, B and C`. */
function joinSentence(shown: readonly string[]): string {
  if (shown.length <= 1) {
    return shown.join('');
  }
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
}

export function displayList(addresses: readonly string[]): string {
  return joinSentence(addresses.map(address => escapeDisplayText(address)));
}

export function recipientList(recipients: readonly Tier3Mailbox[]): string {
  return joinSentence(recipients.map(mailbox => mailboxText(mailbox, { escape: escapeDisplayText })));
}

/** A recipient for the structured email block: its name and address, each escaped as the card escapes text. */
export function escapedMailbox(mailbox: Tier3Mailbox): Tier3Mailbox {
  return { name: escapeDisplayText(mailbox.name), address: escapeDisplayText(mailbox.address) };
}

/** The message as a card shows it. The send receipt shows this same text, so both read it from here. */
export function messageForDisplay(content: ReviewableDraft) {
  return {
    to: content.to.map(escapedMailbox),
    cc: content.cc.map(escapedMailbox),
    bcc: content.bcc.map(escapedMailbox),
    subject: escapeDisplayText(content.subject),
    body: escapeDisplayText(content.body, { keepNewlines: true }),
    reply_to: content.replyTo === null ? null : escapeDisplayText(content.replyTo),
  };
}

export function cardText(text: string): string {
  const chars = Array.from(escapeDisplayText(text));
  return chars.length > CARD_TEXT_MAX_CHARS ? `${chars.slice(0, CARD_TEXT_MAX_CHARS - 1).join('')}…` : chars.join('');
}

export function cardSubject(subject: string): string {
  return `"${cardText(subject).replace(/"/g, '\\"')}"`;
}

/**
 * Answering an approval card by voice.
 *
 * The card is read back in plain words and only an exact phrase for the card's verb approves it.
 * What the card shows is the server's own text: this file only chooses the words around it. The answer
 * goes back as the chat's own approval input for the same thread and tool call, so the usual replay and
 * `changed` checks apply. Cards that hold more than a person can safely check by ear stay on the screen.
 */
import type { Tier3Card } from '@truefoundry/trueforge-core/core';

import { wordsOf } from './echoGuard';

export type ApprovalVerb = 'send' | 'approve' | 'cancel';

const CONFIRM_PHRASES: Record<ApprovalVerb, { spoken: string; heard: string }> = {
  send: { spoken: 'yes, send it', heard: 'yes send it' },
  approve: { spoken: 'yes, approve', heard: 'yes approve' },
  cancel: { spoken: 'yes, cancel it', heard: 'yes cancel it' },
};

const VERB_WORD: Record<ApprovalVerb, string> = { send: 'send', approve: 'go ahead', cancel: 'cancel it' };

/** Longest message read aloud. A longer one cannot be checked by ear, so it is left for the screen. */
const MAX_SPOKEN_BODY_CHARS = 1200;

/**
 * Characters the speech engine says as written. Accents, other scripts, links, code and Markdown marks are
 * changed or dropped on the way to speech, so a card holding any of them is not read back by voice: a
 * "yes" must only ever approve what was heard in full.
 */
const SAYS_AS_WRITTEN = /^[A-Za-z0-9\s.,!?;:'"()%&+@=\u2014\u2026\u2018\u2019\u201c\u201d]*$/;
const LINK = /:\/\/|www\./i;
const LIST_MARK = /^\s*(?:[-*+>]|\d+[.)])\s/m;
/** A hyphen inside a word is spoken as a break; anywhere else (a minus, a range) it would be lost. */
const WORD_HYPHEN = /(?<=[A-Za-z])-(?=[A-Za-z])/g;
const DOLLAR_AMOUNT = /\$(?=\d)/g;

/** Text that itself says an answer phrase could be echoed back as the answer, so the screen settles it. */
function holdsAnAnswerPhrase(text: string): boolean {
  const said = ` ${wordsOf(text).join(' ')} `;
  return Object.values(CONFIRM_PHRASES).some(phrase => said.includes(` ${phrase.heard} `));
}

export function readsAsWritten(text: string): boolean {
  const plain = text.replace(WORD_HYPHEN, ' ').replace(DOLLAR_AMOUNT, '');
  return !LINK.test(text) && !LIST_MARK.test(text) && !plain.includes('-') && SAYS_AS_WRITTEN.test(plain);
}

export type VoiceApprovalPlan =
  | {
      kind: 'ask';
      verb: ApprovalVerb;
      /** What the person is told, in order. `body` is the card's own text; `instruction` tells how to answer. */
      segments: { text: string; role: 'body' | 'instruction' }[];
    }
  | { kind: 'typed_only' };

export interface PendingCard {
  card: Tier3Card | null | undefined;
  tier: 1 | 2 | 3 | undefined;
}

type FieldRule = 'spoken' | 'context' | 'empty' | 'shape';

/**
 * Every field of a card and what voice may do with it. A card is read aloud only when each field it
 * carries is listed here as read, harmless, empty or checked by its shape: a field added later is not
 * on the list, so a card carrying it stays on the screen until someone decides how it is read.
 */
export const CARD_FIELD_RULES: Record<keyof Tier3Card, FieldRule> = {
  plain_what: 'spoken',
  plain_why: 'context',
  cannot_be_undone: 'spoken',
  why_asked_again: 'context',
  destination: 'spoken',
  recipient: 'spoken',
  amount: 'empty',
  parsed_command: 'empty',
  outbound_text: 'empty',
  destination_host: 'empty',
  outbound_truncated: 'empty',
  outbound_plumbing_text: 'empty',
  email: 'shape',
  calendar_event: 'shape',
  schedule: 'shape',
  persona: 'empty',
  mail_new_recipients: 'empty',
  mail_draft: 'context',
};

const FIELD_RULES = new Map<string, FieldRule>(Object.entries(CARD_FIELD_RULES));

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === false || (Array.isArray(value) && value.length === 0);
}

function mailboxNames(mailboxes: { name: string; address: string }[]): string {
  const names = mailboxes.map(mailbox => {
    const name = mailbox.name.trim();
    // The address is read too, so a friendly name cannot stand in for a different address.
    return name === '' || name === mailbox.address ? mailbox.address : `${name} at ${mailbox.address}`;
  });
  if (names.length <= 1) {
    return names[0] ?? 'the recipient';
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

function verbFor(card: Tier3Card): ApprovalVerb {
  if (card.email?.action === 'send') {
    return 'send';
  }
  if (card.schedule?.action === 'delete') {
    return 'cancel';
  }
  return 'approve';
}

/** True when the card's one shape (mail, event or schedule) is a kind voice reads in full. */
function shapeIsReadable(card: Tier3Card): boolean {
  const shapes = [card.email, card.calendar_event, card.schedule].filter(shape => !isEmpty(shape));
  if (shapes.length > 1) {
    return false;
  }
  const { email, calendar_event: event, schedule } = card;
  if (email !== null && email !== undefined) {
    return (
      (email.action === 'send' || email.action === 'save') &&
      email.to.length > 0 &&
      email.bcc.length === 0 &&
      email.replaces === null &&
      email.body.length <= MAX_SPOKEN_BODY_CHARS
    );
  }
  if (event !== null && event !== undefined) {
    return (
      event.action === 'create' &&
      event.attendees.length === 0 &&
      !event.guests_emailed &&
      !event.one_of_repeating &&
      event.before === null
    );
  }
  if (schedule !== null && schedule !== undefined) {
    return schedule.action === 'delete';
  }
  return true;
}

/** True only for a card whose every field is listed, empty where it must be, and read in full. */
function canBeSettledByVoice({ card, tier }: { card: Tier3Card; tier: 1 | 2 | 3 | undefined }): boolean {
  // Tier 2 is a file write: its path and contents are more than a read-back can carry.
  if (tier !== 3) {
    return false;
  }
  for (const [key, value] of Object.entries(card)) {
    const rule = FIELD_RULES.get(key);
    if (rule === undefined || (rule === 'empty' && !isEmpty(value))) {
      return false;
    }
  }
  return shapeIsReadable(card);
}

/**
 * What to say for one waiting card, or `typed_only` when voice may not answer it. Voice answers
 * are also off for a whole transport (a phone line) through `voiceApprovalsAllowed`.
 */
export function planVoiceApproval({
  pending,
  voiceApprovalsAllowed,
}: {
  pending: readonly PendingCard[];
  voiceApprovalsAllowed: boolean;
}): VoiceApprovalPlan {
  const only = pending.length === 1 ? pending[0] : undefined;
  const card = only?.card;
  if (!voiceApprovalsAllowed || only === undefined || card === null || card === undefined) {
    return { kind: 'typed_only' };
  }
  if (!canBeSettledByVoice({ card, tier: only.tier })) {
    return { kind: 'typed_only' };
  }
  const verb = verbFor(card);
  const instruction = {
    text: `Say '${CONFIRM_PHRASES[verb].spoken}' to ${VERB_WORD[verb]}, or 'no'.`,
    role: 'instruction' as const,
  };
  const body = bodySegments(card);
  const spokenChars = body.reduce((sum, segment) => sum + segment.text.length, 0);
  if (
    spokenChars > MAX_SPOKEN_BODY_CHARS ||
    !body.every(segment => readsAsWritten(segment.text) && !holdsAnAnswerPhrase(segment.text))
  ) {
    return { kind: 'typed_only' };
  }
  return { kind: 'ask', verb, segments: [...body, instruction] };
}

function bodySegments(card: Tier3Card): { text: string; role: 'body' }[] {
  const say = (text: string): { text: string; role: 'body' } => ({ text, role: 'body' });
  const email = card.email;
  if (email !== null && email !== undefined) {
    const to = mailboxNames(email.to);
    const opening =
      email.action === 'send'
        ? `I'll send this ${email.reply_in_thread === null ? 'email' : 'reply'} to ${to}.`
        : `I'll save this email to ${to} as a draft. It will not be sent.`;
    return [
      say(opening),
      ...(email.cc.length > 0 ? [say(`Copying ${mailboxNames(email.cc)}.`)] : []),
      ...(email.reply_to === null ? [] : [say(`Replies will go to ${email.reply_to}.`)]),
      say(`The subject is: ${email.subject}`),
      say(`It says: ${email.body}`),
    ];
  }
  const event = card.calendar_event;
  if (event !== null && event !== undefined) {
    const place = event.location === '' ? '' : ` at ${event.location}`;
    return [
      say(`I'll add the event ${event.title} on ${event.when} for ${event.duration}${place}.`),
      ...(event.description === '' ? [] : [say(`Its description is: ${event.description}`)]),
    ];
  }
  const schedule = card.schedule;
  if (schedule !== null && schedule !== undefined) {
    return [say(`I'll stop the schedule ${schedule.name}, which runs ${schedule.when}. Its task is: ${schedule.task}`)];
  }
  const where = card.recipient ?? card.destination;
  return [
    say(card.plain_what),
    ...(where === null ? [] : [say(`It goes to ${where}.`)]),
    ...(card.cannot_be_undone === null ? [] : [say(card.cannot_be_undone)]),
  ];
}

export type SpokenAnswer = 'confirm' | 'deny' | 'other';

/** Only the exact phrase for the card's verb confirms, and only a plain "no" turns it down. */
export function classifyAnswer({ heard, verb }: { heard: string; verb: ApprovalVerb }): SpokenAnswer {
  // A question is not an answer, even in the right words.
  if (/[?\uff1f]\W*$/u.test(heard)) {
    return 'other';
  }
  const words = wordsOf(heard).join(' ');
  if (words === CONFIRM_PHRASES[verb].heard) {
    return 'confirm';
  }
  return words === 'no' ? 'deny' : 'other';
}

export const APPROVAL_LINES = {
  waiting: (verb: ApprovalVerb): string =>
    `That is still waiting for your answer. Say '${CONFIRM_PHRASES[verb].spoken}', or 'no', or answer it on the screen.`,
  leftForTheApp: "I've left it in the app for you to approve.",
  turnedDown: 'Okay. I did not do it.',
  done: (verb: ApprovalVerb): string =>
    verb === 'send' ? 'Done. I sent it.' : verb === 'cancel' ? 'Done. It is cancelled.' : 'Done.',
  changed: 'What was waiting no longer matches what I read to you, so I did nothing. Open the chat to look at it.',
  notAllowed: 'That is not allowed any more, so I did nothing. Open the chat to look at it.',
  expired: 'That ran out of time, so I did nothing. Ask me again.',
  couldNot: 'I could not finish that. Open the chat to see where it stands.',
  sayAgain: 'Wait a moment, then say that again.',
  signIn: 'Your sign-in ran out. Sign in again, then start voice mode.',
} as const;

/**
 * Answering an approval card by voice.
 *
 * The card is read back in plain words and only an exact phrase for the card's verb approves it.
 * What the card shows is the server's own text: this file only chooses the words around it. The answer
 * goes back as the chat's own approval input for the same thread and tool call, so the usual replay and
 * `changed` checks apply. Cards that hold more than a person can safely check by ear stay on the screen.
 * Whether the voice would say a read-back exactly as written is the voice service's call, made in the same
 * request that speaks it; this file holds no copy of those rules.
 */
import type { Tier3Card } from '@truefoundry/trueforge-core/core';

import { wordsOf } from './echoGuard';

export type ApprovalVerb = 'send' | 'approve' | 'delete';

const CONFIRM_PHRASES: Record<ApprovalVerb, { spoken: string; heard: string }> = {
  send: { spoken: 'yes, send it', heard: 'yes send it' },
  approve: { spoken: 'yes, approve', heard: 'yes approve' },
  delete: { spoken: 'yes, delete it', heard: 'yes delete it' },
};

const VERB_WORD: Record<ApprovalVerb, string> = { send: 'send', approve: 'go ahead', delete: 'delete it' };

/** Longest message read aloud. A longer one cannot be checked by ear, so it is left for the screen. */
const MAX_SPOKEN_BODY_CHARS = 1200;

/** Text that itself says an answer phrase could be echoed back as the answer, so the screen settles it. */
function holdsAnAnswerPhrase(text: string): boolean {
  const said = ` ${wordsOf(text).join(' ')} `;
  return Object.values(CONFIRM_PHRASES).some(phrase => said.includes(` ${phrase.heard} `));
}

export type VoiceApprovalPlan =
  | {
      kind: 'ask';
      verb: ApprovalVerb;
      /** The card's own text, one line per part. It goes to the voice as one text that must be said exactly. */
      body: string;
      /** How to answer. Said on its own, only once the body was made. */
      instruction: string;
    }
  | { kind: 'typed_only' };

export interface PendingCard {
  card: Tier3Card | null | undefined;
  tier: 1 | 2 | 3 | undefined;
}

type FieldRule = 'context' | 'empty' | 'shape';

/**
 * Every field of a card and what voice may do with it. A card is read aloud only when each field it
 * carries is listed here as context, empty or checked by its shape: a field added later is not
 * on the list, so a card carrying it stays on the screen until someone decides how it is read.
 * What a person hears is the shape, word for word. The card's own wording is `context`: it repeats the
 * shape, so anything it adds must be in the shape too. `destination` and `recipient` are further held to
 * the shape in `cardWordingMatchesShape`.
 */
export const CARD_FIELD_RULES: Record<keyof Tier3Card, FieldRule> = {
  plain_what: 'context',
  plain_why: 'context',
  cannot_be_undone: 'context',
  why_asked_again: 'context',
  destination: 'context',
  recipient: 'context',
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

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === false || (Array.isArray(value) && value.length === 0);
}

function mailboxNames(mailboxes: { name: string; address: string }[]): string {
  const names = mailboxes.map(mailbox => {
    const name = mailbox.name.trim();
    // The address is read too, so a friendly name cannot stand in for a different address.
    return name === '' || name === mailbox.address
      ? spokenAddress(mailbox.address)
      : `${name} at ${spokenAddress(mailbox.address)}`;
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
    return 'delete';
  }
  return 'approve';
}

type NestedRule = 'spoken' | 'checked' | 'empty';
type Email = NonNullable<Tier3Card['email']>;
type Mailbox = Email['to'][number];
type CalendarEvent = NonNullable<Tier3Card['calendar_event']>;
type Schedule = NonNullable<Tier3Card['schedule']>;

/**
 * Every field of the three card shapes, like `CARD_FIELD_RULES` one level down: `spoken` is read out,
 * `checked` is a choice that decides whether the card is readable at all, `empty` must carry nothing.
 * A field added to a shape is missing here, so the card stays on the screen until someone decides.
 * `reply_in_thread` is deliberately not read: the reply's own recipients, subject and body are, and the
 * message it answers stays on the screen.
 */
export const EMAIL_FIELD_RULES: Record<keyof Email, NestedRule> = {
  action: 'checked',
  to: 'spoken',
  cc: 'spoken',
  bcc: 'empty',
  subject: 'spoken',
  body: 'spoken',
  replaces: 'empty',
  reply_in_thread: 'checked',
  reply_to: 'spoken',
  from_name: 'spoken',
  name_left_off: 'spoken',
};
export const EVENT_FIELD_RULES: Record<keyof CalendarEvent, NestedRule> = {
  action: 'checked',
  calendar: 'spoken',
  title: 'spoken',
  when: 'spoken',
  time_zone: 'spoken',
  duration: 'spoken',
  location: 'spoken',
  description: 'spoken',
  attendees: 'empty',
  guests_emailed: 'empty',
  one_of_repeating: 'empty',
  before: 'empty',
  already_created: 'spoken',
  span_days: 'spoken',
};
export const SCHEDULE_FIELD_RULES: Record<keyof Schedule, NestedRule> = {
  action: 'checked',
  name: 'spoken',
  when: 'spoken',
  time_zone: 'spoken',
  task: 'spoken',
  runs_as: 'spoken',
  next_runs: 'empty',
};

/** The fields of one recipient: the name it is shown with and the address mail goes to. */
export const MAILBOX_FIELD_RULES: Record<keyof Mailbox, NestedRule> = { name: 'spoken', address: 'spoken' };

/** True when every field the value carries is listed, and each one listed as `empty` carries nothing. */
function fieldsAreListed({ shape, rules }: { shape: object; rules: Record<string, string> }): boolean {
  const listed = new Map(Object.entries(rules));
  return Object.entries(shape).every(([key, value]) => {
    const rule = listed.get(key);
    return rule !== undefined && (rule !== 'empty' || isEmpty(value));
  });
}

/**
 * With a shape set, the card's `destination` and `recipient` must say nothing the shape does not: empty, or
 * an address the mail goes to. Anything else could point somewhere the read-back never named.
 */
function cardWordingMatchesShape(card: Tier3Card): boolean {
  const addresses = (card.email?.to ?? []).map(mailbox => mailbox.address);
  return isEmpty(card.destination) && (isEmpty(card.recipient) || addresses.includes(card.recipient ?? ''));
}

/**
 * The wording around the card's fields. A short field (a title, subject or name) that holds one of these, a
 * sentence stop or a line break could pass for the fixed wording or start a new line, so it stays on the screen.
 */
const FIXED_WORDING =
  /\b(?:it says|the subject is|it goes on|copying|replies will go|sent as|left off|you already have|runs over|description is|task is|i'll (?:send|save|add|delete)|for good|dot|dash)\b/i;
const SENTENCE_BREAK = /[.!?\u2026]+(?:\s|$)|[\r\n\u2028\u2029\u0085]/u;

/** True when the field can sit inside the fixed wording without changing what the sentence says. */
const fitsInWording = (field: string): boolean => !SENTENCE_BREAK.test(field) && !FIXED_WORDING.test(field);

/** A zone name like Europe/Berlin, as words. */
const zoneWords = (zone: string): string => zone.replace(/[/_]/g, ' ');

/** `Etc/GMT+5` is five hours behind UTC, the way round people do not say it, so it is left for the screen. */
const isOffsetZone = (zone: string): boolean => /^Etc\/GMT[+-]/.test(zone);

/** "Fri Nov 6, 2:30 to 3:00 pm" as "Fri Nov 6 at 2:30 to 3:00 pm": a comma between a day and a time reads as two numbers. */
const spokenWhen = (when: string): string => when.replace(/(\d), (?=\d{1,2}:\d\d)/g, '$1 at ');

/** An address said so that every dot and hyphen is heard: "victor at my dash bank dot com". */
const spokenAddress = (address: string): string =>
  address.replace(/@/g, ' at ').replace(/\./g, ' dot ').replace(/-/g, ' dash ').replace(/ +/g, ' ').trim();

/**
 * What the card says, or undefined when voice may not answer it. A card with no mail, event or schedule
 * shape (a file write, a plan, anything generic) has nothing here that is read in full, so it is
 * left for the screen.
 */
function readableBody(card: Tier3Card): string[] | undefined {
  const { email, calendar_event: event, schedule } = card;
  const shapes = [email, event, schedule].filter(shape => !isEmpty(shape));
  if (shapes.length !== 1) {
    return undefined;
  }
  if (email !== null && email !== undefined) {
    if (
      !fieldsAreListed({ shape: email, rules: EMAIL_FIELD_RULES }) ||
      ![...email.to, ...email.cc].every(mailbox => fieldsAreListed({ shape: mailbox, rules: MAILBOX_FIELD_RULES })) ||
      email.from_name === undefined ||
      email.name_left_off === undefined ||
      (email.action !== 'send' && email.action !== 'save') ||
      email.to.length === 0 ||
      email.body.length > MAX_SPOKEN_BODY_CHARS ||
      ![email.subject, email.from_name ?? '', ...[...email.to, ...email.cc].map(mailbox => mailbox.name)].every(
        fitsInWording,
      )
    ) {
      return undefined;
    }
    const to = mailboxNames(email.to);
    const opening =
      email.action === 'send'
        ? `I'll send this ${email.reply_in_thread === null ? 'email' : 'reply'} to ${to}.`
        : `I'll save this email to ${to} as a draft. It will not be sent.`;
    return [
      opening,
      ...(email.cc.length > 0 ? [`Copying ${mailboxNames(email.cc)}.`] : []),
      ...(email.reply_to === null ? [] : [`Replies will go to ${spokenAddress(email.reply_to)}.`]),
      ...(email.from_name === null ? [] : [`It will be sent as ${email.from_name}.`]),
      ...(email.name_left_off ? ['The name was left off an address because it looked like an address.'] : []),
      `The subject is: ${email.subject}`,
      `It says: ${email.body}`,
    ];
  }
  if (event !== null && event !== undefined) {
    if (
      isOffsetZone(event.time_zone) ||
      !fieldsAreListed({ shape: event, rules: EVENT_FIELD_RULES }) ||
      event.already_created === undefined ||
      event.span_days === undefined ||
      event.action !== 'create' ||
      ![event.title, event.location, event.duration].every(fitsInWording)
    ) {
      return undefined;
    }
    const place = event.location === '' ? '' : ` at ${event.location}`;
    return [
      `I'll add the event ${event.title} on ${spokenWhen(event.when)}, ${zoneWords(event.time_zone)} time, for ${event.duration}${place}.`,
      `It goes on the calendar of ${spokenAddress(event.calendar)}.`,
      ...(event.already_created ? ['You already have this event.'] : []),
      ...(event.span_days > 1 ? [`This event runs over ${String(event.span_days)} days.`] : []),
      ...(event.description === '' ? [] : [`Its description is: ${event.description}`]),
    ];
  }
  if (schedule !== null && schedule !== undefined) {
    if (
      isOffsetZone(schedule.time_zone) ||
      !fieldsAreListed({ shape: schedule, rules: SCHEDULE_FIELD_RULES }) ||
      schedule.action !== 'delete' ||
      ![schedule.name, schedule.when, schedule.runs_as].every(fitsInWording)
    ) {
      return undefined;
    }
    return [
      `I'll delete the schedule ${schedule.name} for good. It runs ${schedule.when}, ${zoneWords(schedule.time_zone)} time, as ${schedule.runs_as}. Its task is: ${schedule.task}`,
    ];
  }
  return undefined;
}

/** True only for a tier 3 card whose every field is listed and empty where it must be. */
function canBeSettledByVoice({ card, tier }: { card: Tier3Card; tier: 1 | 2 | 3 | undefined }): boolean {
  // Tier 2 is a file write: its path and contents are more than a read-back can carry.
  if (tier !== 3) {
    return false;
  }
  return fieldsAreListed({ shape: card, rules: CARD_FIELD_RULES }) && cardWordingMatchesShape(card);
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
  const lines = readableBody(card);
  if (lines === undefined) {
    return { kind: 'typed_only' };
  }
  const body = lines.join('\n');
  if (body.length > MAX_SPOKEN_BODY_CHARS || holdsAnAnswerPhrase(body)) {
    return { kind: 'typed_only' };
  }
  return {
    kind: 'ask',
    verb,
    body,
    instruction: `Say '${CONFIRM_PHRASES[verb].spoken}' to ${VERB_WORD[verb]}, or 'no'.`,
  };
}

export type SpokenAnswer = 'confirm' | 'deny' | 'other';

/**
 * What a plain spoken answer looks like when written down: letters, spaces and commas, one closing stop or
 * "!", and closing quotes. Anything else (a question mark in any script, a trailing-off, a stop between
 * the words) is not an answer, so no list of marks has to be kept.
 */
const PLAIN_ANSWER = /^[\p{L}\s,]*[.!]?["'\u2019\u201d)\]]*\s*$/u;

/** Only the exact phrase for the card's verb confirms, and only a plain "no" turns it down. */
export function classifyAnswer({ heard, verb }: { heard: string; verb: ApprovalVerb }): SpokenAnswer {
  if (!PLAIN_ANSWER.test(heard)) {
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
    verb === 'send' ? 'Done. I sent it.' : verb === 'delete' ? 'Done. It is deleted.' : 'Done.',
  changed: 'What was waiting no longer matches what I read to you, so I did nothing. Open the chat to look at it.',
  notAllowed: 'That is not allowed any more, so I did nothing. Open the chat to look at it.',
  expired: 'That ran out of time, so I did nothing. Ask me again.',
  couldNot: 'I could not finish that. Open the chat to see where it stands.',
  sayAgain: 'Wait a moment, then say that again.',
  signIn: 'Your sign-in ran out. Sign in again, then start voice mode.',
} as const;

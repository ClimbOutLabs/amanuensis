import type { HeldActionOutcome } from '@truefoundry/trueforge-chat';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

import { errorCodeOf, statusCodeOfError } from './serverErrors.js';

/**
 * How the terminal shows and answers an action a turn holds for approval. The
 * words are the web app's words for the same cards and the same answers, so a
 * person who answers in either place reads the same thing. The card facts are
 * the server's own; nothing here invents a fact the server did not send.
 */

/** One action waiting for the person's answer, collected from the stream or read back from the tip turn. */
export interface PendingApproval {
  toolCallId: string;
  threadId: string;
  /** The server's plain-language card for this action, or null when the call carries none. */
  card: TrueForgeApi.Tier3Card | null;
  /** The tool's plain name from the chat, for a card that cannot name the action itself. */
  toolName: string | null;
  /** True when the server lets this call be allowed for good. */
  canAlwaysAllow: boolean;
  /** True when a scheduled run held the action. The run did not wait for an answer. */
  held: boolean;
  /** When a held action stops being answerable, or null when it does not expire. */
  expiresAt: string | null;
}

/** Builds the waiting action from one approval reference the server sent. */
export function pendingApprovalFromRef(options: {
  ref: TrueForgeApi.ApprovalToolCallRef;
  threadId: string;
  toolName: string | null;
}): PendingApproval {
  const { ref } = options;
  return {
    toolCallId: ref.id,
    threadId: options.threadId,
    card: ref.tier3Card ?? null,
    toolName: options.toolName,
    canAlwaysAllow: ref.canAlwaysAllow === true,
    held: ref.held === true,
    expiresAt: ref.expiresAt ?? null,
  };
}

const GENERIC_HEADLINE = 'Needs your OK';

function mailboxText(mailbox: TrueForgeApi.Tier3Mailbox): string {
  return mailbox.name === '' ? mailbox.address : `${mailbox.name} (${mailbox.address})`;
}

function mailboxListText(mailboxes: readonly TrueForgeApi.Tier3Mailbox[]): string {
  return mailboxes.map(mailbox => mailboxText(mailbox)).join(', ');
}

/** The people a card sends to, in plain words: the first name, then how many more. */
function recipientsText(recipients: readonly TrueForgeApi.Tier3Mailbox[]): string {
  const [first, ...rest] = recipients;
  if (first === undefined) {
    return 'no one';
  }
  const name = first.name === '' ? first.address : first.name;
  if (rest.length === 0) {
    return name;
  }
  return `${name} and ${String(rest.length)} more`;
}

function emailQuestion(email: TrueForgeApi.Tier3Email): string {
  if (email.action !== 'send') {
    return 'Save this draft?';
  }
  if (email.to.length === 0) {
    return email.replyInThread !== null ? 'Send this reply?' : 'Send this email?';
  }
  const to = recipientsText(email.to);
  return email.replyInThread !== null ? `Send this reply to ${to}?` : `Send this email to ${to}?`;
}

/**
 * The headline a card leads with: the server's copy when the card carries it.
 * A card saved before copy existed falls back to the question built from its
 * fields, or to the generic headline. Its stored plain_what is never the
 * headline, because an old saved card can carry identifiers in that sentence.
 */
export function approvalHeadline(card: TrueForgeApi.Tier3Card | null): string {
  if (card === null) {
    return GENERIC_HEADLINE;
  }
  if (card.copy !== null) {
    return card.copy.headline;
  }
  const { email, calendarEvent, schedule, persona, skill } = card;
  if (email !== null && email !== undefined) {
    return emailQuestion(email);
  }
  if (calendarEvent !== null && calendarEvent !== undefined) {
    return calendarEvent.action === 'create'
      ? `Add "${calendarEvent.title}" to your calendar?`
      : `Change "${calendarEvent.title}" in your calendar?`;
  }
  if (schedule !== null && schedule !== undefined) {
    return schedule.action === 'create'
      ? `Create the schedule "${schedule.name}"?`
      : `Delete the schedule "${schedule.name}"?`;
  }
  if (persona !== null && persona !== undefined) {
    return `Add the persona "${persona.name}"?`;
  }
  if (skill !== null && skill !== undefined) {
    return `Add the skill "${skill.name}"?`;
  }
  return GENERIC_HEADLINE;
}

/** The consequence line a card shows: the copy's consequence, or the older cannot-be-undone note. */
function cardConsequence(card: TrueForgeApi.Tier3Card): string | null {
  return card.copy !== null ? card.copy.consequence : card.cannotBeUndone;
}

/** The site an address goes to, or undefined when it is not a web address. */
function addressHost(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value) || !URL.canParse(value)) {
    return undefined;
  }
  return new URL(value).hostname;
}

/** True when the question names this site or address as a whole word, so a fact row would only repeat it. */
function questionNames(question: string, value: string): boolean {
  return [' ', '?', '.', ','].some(end => question.includes(` ${value}${end}`));
}

/** True when the exact request adds nothing the facts do not already show, such as a page's own address. */
function outboundRepeatsFacts(card: TrueForgeApi.Tier3Card, outbound: string): boolean {
  return card.destination !== null && (outbound === card.destination || outbound === `url: ${card.destination}`);
}

function factLines(card: TrueForgeApi.Tier3Card, headline: string): string[] {
  const lines: string[] = [];
  const { destination, destinationHost } = card;
  const hostOfDestination = destination === null ? undefined : addressHost(destination);
  if (destination !== null && !questionNames(headline, destination)) {
    lines.push(`${hostOfDestination === undefined ? 'Where' : 'Address'}: ${destination}`);
  }
  if (card.recipient !== null) {
    lines.push(`To: ${card.recipient}`);
  }
  if (card.amount !== null) {
    lines.push(`Amount: ${card.amount}`);
  }
  if (card.parsedCommand !== null) {
    lines.push(`Command: ${card.parsedCommand}`);
  }
  if (
    destinationHost !== null &&
    destinationHost !== destination &&
    destinationHost !== hostOfDestination &&
    !questionNames(headline, destinationHost)
  ) {
    lines.push(`Sends to: ${destinationHost}`);
  }
  return lines;
}

function calendarLines(event: TrueForgeApi.Tier3CalendarEvent): string[] {
  const lines: string[] = [];
  const { before } = event;
  if (before !== null) {
    lines.push('Now');
    lines.push(`Title: ${before.title}`);
    lines.push(`When: ${before.when}`);
    if (before.duration !== '') {
      lines.push(`Length: ${before.duration}`);
    }
    if (before.location !== '') {
      lines.push(`Where: ${before.location}`);
    }
  }
  lines.push(before === null ? 'Exactly what will be saved' : 'After the change');
  lines.push(`Calendar: Main calendar of ${event.calendar}`);
  lines.push(`Title: ${event.title}`);
  lines.push(`When: ${event.when}`);
  lines.push(`Time zone: ${event.timeZone}`);
  lines.push(`Length: ${event.duration}`);
  if (event.location !== '') {
    lines.push(`Where: ${event.location}`);
  }
  if (event.alreadyCreated === true) {
    lines.push('You already have this event.');
  }
  if (event.spanDays !== undefined && event.spanDays > 1) {
    lines.push(`This event runs over ${String(event.spanDays)} days.`);
  }
  if (event.oneOfRepeating) {
    lines.push('Repeats: Only this one event of the series changes');
  }
  lines.push(`Guests: ${event.attendees.length === 0 ? 'None' : event.attendees.join(', ')}`);
  if (event.attendees.length > 0) {
    lines.push(
      event.guestsEmailed
        ? 'Google will email every guest about this.'
        : 'Google will not email the guests about this.',
    );
  }
  if (event.description !== '') {
    lines.push('Description');
    lines.push(...event.description.split('\n'));
  }
  return lines;
}

function onNames(choices: readonly TrueForgeApi.Tier3ScheduleToolChoice[]): string {
  const names = choices.filter(choice => choice.on).map(choice => choice.name);
  return names.length === 0 ? 'None' : names.join(', ');
}

function onOff(value: boolean): string {
  return value ? 'On' : 'Off';
}

function scheduleLines(schedule: TrueForgeApi.Tier3Schedule): string[] {
  const lines: string[] = [];
  lines.push(`Name: ${schedule.name}`);
  lines.push(`When it runs: ${schedule.when} (${schedule.timeZone})`);
  lines.push(`Runs as: ${schedule.runsAs}`);
  if (schedule.action === 'create') {
    lines.push('Starts: As soon as you approve.');
  }
  if (schedule.nextRuns.length > 0) {
    lines.push('Next runs');
    lines.push(...schedule.nextRuns);
  }
  lines.push('What it will do each time');
  lines.push(...schedule.task.split('\n'));
  const tools = schedule.tools ?? null;
  if (tools !== null) {
    lines.push(`Connectors: ${onNames(tools.connectors)}`);
    lines.push(`Skills: ${onNames(tools.skills)}`);
    lines.push(`Run code: ${onOff(tools.runCode)}`);
    lines.push(`Memory: ${onOff(tools.memory)}`);
  }
  if (schedule.action === 'create') {
    lines.push(
      "While you're away it can only read and write to chat; anything risky is skipped and waits for your OK.",
    );
  }
  return lines;
}

function personaLines(persona: TrueForgeApi.Tier3Persona): string[] {
  const lines: string[] = [];
  lines.push(`Name: ${persona.name}`);
  lines.push(`For: ${persona.description}`);
  lines.push(`Answers with: ${persona.modelName}`);
  lines.push('Instructions');
  lines.push(...persona.instructions.split('\n'));
  return lines;
}

function skillLines(skill: TrueForgeApi.Tier3Skill): string[] {
  const lines: string[] = [];
  lines.push('What it does');
  lines.push(...skill.description.split('\n'));
  lines.push('Websites it can reach');
  const websites = skill.websites ?? [];
  if (websites.length === 0) {
    lines.push("None. It doesn't send requests to any website.");
  } else {
    lines.push(...websites);
    lines.push(
      "Adding it lets the skill reach these websites and no others. Aman can't see what these sites do with what the skill sends them. Any of them could pass your data on, even by email, so only add a skill you trust.",
    );
  }
  if (skill.canSend === true) {
    lines.push(
      'Aman blocks the email sites on this list. A skill can never send email. Email only goes out through Aman, and you approve each one.',
    );
  }
  if (skill.makesUpAddresses === true) {
    lines.push(
      "It also makes up some web addresses while it runs. Those stay blocked, and you'll be asked about each one.",
    );
  }
  lines.push('Where it comes from');
  lines.push(skill.source);
  lines.push(`Version: ${skill.version}`);
  if (skill.instructions !== null) {
    lines.push('Instructions');
    lines.push(...skill.instructions.split('\n'));
  }
  return lines;
}

function emailLines(card: TrueForgeApi.Tier3Card, email: TrueForgeApi.Tier3Email): string[] {
  const lines: string[] = [];
  if ((card.mailNewRecipients ?? []).length > 0) {
    // For a new address the server's sentence says that approving adds it. The fields do not.
    lines.push(card.plainWhat);
  }
  const consequence = cardConsequence(card);
  if (consequence !== null) {
    lines.push(consequence);
  }
  if (card.whyAskedAgain !== null) {
    lines.push(`You have seen this before: ${card.whyAskedAgain}`);
  }
  if (email.replyInThread !== null) {
    lines.push(`Reply in the thread, subject: ${email.replyInThread.subject}`);
    lines.push(`Reply in the thread, from: ${email.replyInThread.from}`);
  }
  if (typeof card.mailFrom === 'string' && card.mailFrom !== '') {
    lines.push(`From: ${card.mailFrom}`);
  }
  lines.push(`To: ${mailboxListText(email.to)}`);
  if (email.cc.length > 0) {
    lines.push(`Copy: ${mailboxListText(email.cc)}`);
  }
  if (email.bcc.length > 0) {
    lines.push(`Hidden copy: ${mailboxListText(email.bcc)}`);
  }
  if (email.fromName !== null && email.fromName !== undefined) {
    lines.push(`Sent as: ${email.fromName}`);
  }
  if (email.replyTo !== null && email.replyTo !== undefined) {
    lines.push(`Replies go to: ${email.replyTo}`);
  }
  lines.push(`Subject: ${email.subject === '' ? 'No subject' : email.subject}`);
  if (email.checkCode !== null && email.checkCode !== undefined) {
    lines.push(`Check code: ${email.checkCode}`);
  }
  if (email.nameLeftOff === true) {
    lines.push('The name was left off an address because it looked like an address.');
  }
  if (email.replaces !== null) {
    lines.push(`Replaces the saved draft “${email.replaces.subject}” to ${mailboxListText(email.replaces.to)}`);
  }
  const forwards = email.forwards ?? null;
  if (forwards === null) {
    lines.push('Message');
    if (email.body === '') {
      lines.push('This message has no text.');
    } else {
      lines.push(...email.body.split('\n'));
    }
  } else {
    if (email.body === '') {
      lines.push('No note is added.');
    } else {
      lines.push('Your note');
      lines.push(...email.body.split('\n'));
    }
    lines.push(`Forwarded message from ${forwards.from}, subject “${forwards.subject}”`);
    lines.push(...forwards.body.split('\n'));
    if (forwards.truncated) {
      lines.push('The forwarded message is longer than the part shown here. All of it is sent.');
    }
    lines.push(
      forwards.attachments.length === 0
        ? 'No files are sent with it.'
        : `Files sent with it: ${forwards.attachments.join(', ')}`,
    );
  }
  if (card.outboundText !== null) {
    lines.push('Also sent with this email');
    if (card.outboundTruncated) {
      lines.push('Part of what will be sent is not shown in full.');
    }
    lines.push(...card.outboundText.split('\n'));
  }
  return lines;
}

/**
 * Every line of the approval view for one waiting action, in the order the web
 * app's card shows them. Nothing is cut to fit a window: the view scrolls
 * through these lines, so the whole draft or action can always be read before
 * an answer is possible.
 */
export function approvalLines(approval: PendingApproval, assistantName: string): string[] {
  const { card } = approval;
  const headline = approvalHeadline(card);
  const lines: string[] = [headline];
  if (card === null) {
    if (approval.toolName !== null) {
      lines.push(`Tool: ${approval.toolName}`);
    }
    return lines;
  }
  const reason = card.copy?.reason ?? null;
  if (reason !== null) {
    lines.push(reason);
  }
  const email = card.email ?? null;
  if (email !== null) {
    lines.push(...emailLines(card, email));
  } else {
    if (card.whyAskedAgain !== null) {
      lines.push(card.whyAskedAgain);
    }
    lines.push(...factLines(card, headline));
    if (card.calendarEvent !== null && card.calendarEvent !== undefined) {
      lines.push(...calendarLines(card.calendarEvent));
    }
    if (card.schedule !== null && card.schedule !== undefined) {
      lines.push(...scheduleLines(card.schedule));
    }
    if (card.persona !== null && card.persona !== undefined) {
      lines.push(...personaLines(card.persona));
    }
    if (card.skill !== null && card.skill !== undefined) {
      lines.push(...skillLines(card.skill));
    }
    if (card.skillNetwork !== null && card.skillNetwork !== undefined) {
      lines.push(`Skill: ${card.skillNetwork.skillName}`);
      lines.push(`Sites it asks to reach: ${card.skillNetwork.hosts.join(', ')}`);
    }
    if (card.outboundText !== null && !outboundRepeatsFacts(card, card.outboundText)) {
      lines.push('Full request');
      if (card.outboundTruncated) {
        lines.push('Part of this is not shown in full. Check it before you approve.');
      }
      lines.push(...card.outboundText.split('\n'));
    }
    const consequence = cardConsequence(card);
    if (consequence !== null) {
      lines.push(consequence);
    }
  }
  if (card.plainWhy !== null) {
    lines.push(`${assistantName} says: ${card.plainWhy}`);
  }
  return lines;
}

/** True when the card approves a send to addresses not yet on the person's send list. */
export function isNewRecipientCard(card: TrueForgeApi.Tier3Card | null): boolean {
  return card !== null && (card.mailNewRecipients ?? []).length > 0;
}

/** The words on the approve choice: Add and send on a new-recipient card, Allow on every other card. */
export function approveChoiceLabel(card: TrueForgeApi.Tier3Card | null): string {
  if (isNewRecipientCard(card)) {
    return card?.mailDraft === true ? 'Add and save draft' : 'Add and send';
  }
  return 'Allow';
}

/**
 * The words on the no choice. A new-recipient card says what will not happen.
 * A card the server marks safe-first keeps its safe words: Don't send or Don't
 * save for mail, Keep it for a destructive action, Not now otherwise. Every
 * other card says Deny.
 */
export function denyChoiceLabel(card: TrueForgeApi.Tier3Card | null): string {
  if (isNewRecipientCard(card)) {
    return card?.mailDraft === true ? "Don't save" : "Don't send";
  }
  if (card?.safeChoice === true) {
    const email = card.email ?? null;
    if (email !== null) {
      return email.action === 'send' ? "Don't send" : "Don't save";
    }
    if (card.destructive === true) {
      return 'Keep it';
    }
    return 'Not now';
  }
  return 'Deny';
}

/** What an approved action reads once it has run, in the web app's outcome words. */
export const APPROVED_OUTCOME_TEXT: Record<HeldActionOutcome, string> = {
  done: 'Approved and done.',
  failed: 'Approved, but it failed. The details are in the chat.',
  unclear: 'Approved, but it is not clear whether it finished. Check the chat.',
  not_run: 'Approved, but it did not run, so nothing was done. Ask again in chat.',
};

/** What a denied action reads. Nothing was done. */
export const DENIED_TEXT = 'Denied. Nothing was done.';

/** The line for a held action whose time ran out before it was answered. */
export const HELD_EXPIRED_TEXT = 'Expired, nothing was done. Ask again in chat.';

/** The line for an approval whose request already ended. */
export const REQUEST_ENDED_LINE = 'This request ended. Ask again if you still need it.';

/** The line for an approval the chat moved on from before it was answered. */
export const STALE_APPROVAL_LINE =
  'The chat moved on before this was answered. Nothing was approved or run. Ask again if you still want it.';

const REFUSAL_TEXT: Record<string, string> = {
  held_action_expired: HELD_EXPIRED_TEXT,
  held_action_changed: 'This no longer matches what was held, so nothing was done. Ask again in chat.',
  held_action_not_allowed: 'This is not allowed any more, so nothing was done. Ask again in chat.',
  held_action_tool_gone: 'This tool is not available any more, so nothing was done. Ask again in chat.',
  held_action_sign_in: 'The connector needs you to sign in again first, so nothing was done. Sign in, then try again.',
};

const GENERIC_FAILURE = 'That did not go through. Try again in a moment.';

/** How answering an approval failed, in plain words. */
export type AnswerFailure =
  /** The action can no longer run. Nothing was done, and answering again will not help. */
  | { kind: 'refused'; message: string }
  /** The answer did not settle anything. The approval stays, and the person can answer again. */
  | { kind: 'retry'; message: string }
  /** The terminal key itself was refused. Pairing again is the fix. */
  | { kind: 'key-refused'; message: string };

/**
 * The plain message for a failed approval answer, matching how the web app
 * words the same failures. The server says what went wrong by status and
 * error code. Its own message text is never shown.
 */
export function describeAnswerFailure(error: unknown, assistantName: string): AnswerFailure {
  const status = statusCodeOfError(error);
  const code = errorCodeOf(error);
  if (status === 401) {
    return { kind: 'key-refused', message: "Aman no longer accepts this terminal's key." };
  }
  if (status === 409) {
    if (code === 'previous_turn_running') {
      return {
        kind: 'retry',
        message: `${assistantName} is still working on your last message. Wait for it to finish, or press Stop, then send again.`,
      };
    }
    if (code === 'turn_could_not_start') {
      return { kind: 'retry', message: 'That reply could not start, so nothing was done. Answer again.' };
    }
    if (code === 'stale_approval_continuation') {
      return { kind: 'refused', message: STALE_APPROVAL_LINE };
    }
    if (code === 'approval_request_ended') {
      return { kind: 'refused', message: REQUEST_ENDED_LINE };
    }
    const refusal = code === undefined ? undefined : REFUSAL_TEXT[code];
    if (refusal !== undefined) {
      return { kind: 'refused', message: refusal };
    }
    return {
      kind: 'refused',
      message: 'This was already answered, or the chat has moved on. Nothing more was done.',
    };
  }
  if (status === 403) {
    return { kind: 'refused', message: 'Only the person this chat belongs to can answer this.' };
  }
  if (status === 404 || status === 422) {
    return { kind: 'refused', message: 'This saved action is no longer available. Ask again in chat.' };
  }
  return { kind: 'retry', message: GENERIC_FAILURE };
}

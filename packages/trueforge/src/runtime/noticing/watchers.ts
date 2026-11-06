import { APPROVAL_EXPIRY_MINUTES } from '@truefoundry/trueforge-core/core/permissions/approvalExpiry';
import type { Logger } from 'winston';

import type { StuckMessage } from '../../db/noticingStore';
import type { AlwaysImportantSender, NoticingEvent, ReachSettings } from '../../schemas/reach';
import { checkSender } from './authenticationResults';
import { findDeadline, looksLikeBill, saysPaid } from './deadlines';
import {
  MailSourceBusyError,
  MessageUnreadableError,
  type CalendarEventInfo,
  type CalendarSource,
  type MailMessage,
  type MailSource,
  type MailWindowRead,
  type WaitingApproval,
} from './sources';

/** A bill is raised when it falls due within this long. */
export const BILL_WINDOW_MS = 3 * 86_400_000;
/** A bill due further off than this is not tracked. */
const BILL_TRACK_LIMIT_MS = 62 * 86_400_000;
/** The part of a message the watchers and the model read. */
const READ_CHARACTERS = 1500;
/** Calendar clashes are looked for this far ahead. */
const CLASH_WINDOW_MS = 24 * 3_600_000;
/** Most new messages one pass reads. */
const MAIL_PASS_LIMIT = 100;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function senderLabel(message: MailMessage): string {
  return message.from_name === null ? message.from_address : `${message.from_name} (${message.from_address})`;
}

function localTime({ at, timezone }: { at: Date; timezone: string }): string {
  try {
    return at.toLocaleString('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  } catch {
    return at.toISOString();
  }
}

function localDate({ at, timezone }: { at: Date; timezone: string }): string {
  try {
    return at.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' });
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** A message the mail server keeps failing on, or a stretch of mail it cannot list, is passed over after this many passes. */
export const MAX_STUCK_PASSES = 3;

/** A stretch of mail that cannot be listed is counted under its start, since no message is to blame. */
function listSliceKey(since: Date): string {
  return `list:${since.toISOString()}`;
}

/**
 * What one pass over new mail found. `track` are bills due later than the window, kept until they come near. When
 * `resume_from` is set, the next pass starts there. `stopped_by` is the failure that ended the pass early, and `stuck`
 * the message (or stretch of mail) it keeps failing on, to carry into the next pass.
 */
export interface MailFindings {
  raise: NoticingEvent[];
  track: NoticingEvent[];
  resume_from: Date | undefined;
  stuck: StuckMessage | undefined;
  stopped_by: { error: unknown } | undefined;
}

/** A window this short that still holds more than one pass reads is read whole, up to this many messages. */
const SHORTEST_WINDOW_MS = 4000;
const MOST_IN_SHORTEST_WINDOW = 500;

export interface MailWindow {
  messages: MailMessage[];
  resume_from: Date | undefined;
  /** Set when even the shortest window from `since` could not be listed: the error, and where that window ends. */
  unlistable?: { before: Date; error: unknown };
}

/**
 * The oldest mail since `since` that one pass can read, and where the next pass starts. The window is halved until
 * the mail in it fits, so every message before `resume_from` was read and none is skipped. A flood too big to read
 * even in the shortest window is passed over, except mail from `keep_from`, so a flood cannot hide that mail.
 * A list that fails for a reason other than a busy server is halved the same way, to find the stretch of mail that
 * fails: one message the source cannot list would otherwise stop every list that holds it.
 */
export async function readMailWindow({
  source,
  since,
  now,
  limit,
  keep_from,
  logger,
  out_of_time,
}: {
  source: MailSource;
  since: Date;
  now: Date;
  limit: number;
  keep_from: readonly string[];
  logger: Pick<Logger, 'warn'>;
  out_of_time: () => boolean;
}): Promise<MailWindow> {
  let before = now;
  for (;;) {
    if (out_of_time()) {
      return { messages: [], resume_from: since };
    }
    const short = before.getTime() - since.getTime() <= SHORTEST_WINDOW_MS;
    let read: MailWindowRead;
    try {
      read = await source.listNewMessages({ since, before, limit: short ? MOST_IN_SHORTEST_WINDOW : limit });
    } catch (error) {
      if (error instanceof MailSourceBusyError) {
        throw error;
      }
      if (short) {
        return { messages: [], resume_from: since, unlistable: { before, error } };
      }
      before = halfway({ since, before });
      continue;
    }
    if (read.read === 'all') {
      return { messages: read.messages, resume_from: before.getTime() === now.getTime() ? undefined : before };
    }
    if (read.read === 'oldest') {
      // Everything up to the newest message read was read. With none read, the next pass tries the same window.
      return { messages: read.messages, resume_from: read.messages.at(-1)?.received_at ?? since };
    }
    if (short) {
      return await readFlood({ source, since, before, keep_from, logger });
    }
    before = halfway({ since, before });
  }
}

function halfway({ since, before }: { since: Date; before: Date }): Date {
  return new Date(since.getTime() + Math.floor((before.getTime() - since.getTime()) / 2));
}

/** Hundreds of messages within a few seconds are a flood, not mail to tell anyone about. Only `keep_from` is read. */
async function readFlood({
  source,
  since,
  before,
  keep_from,
  logger,
}: {
  source: MailSource;
  since: Date;
  before: Date;
  keep_from: readonly string[];
  logger: Pick<Logger, 'warn'>;
}): Promise<{ messages: MailMessage[]; resume_from: Date }> {
  const window = { since: since.toISOString(), before: before.toISOString() };
  // Where no sender can be confirmed, mail from those senders is ordinary mail, so reading it is not worth a call.
  const kept =
    keep_from.length === 0 || source.trustedAuthenticationServers.length === 0
      ? undefined
      : await source.listNewMessages({ since, before, limit: MOST_IN_SHORTEST_WINDOW, from: keep_from });
  if (kept === undefined || kept.read === 'too_many') {
    logger.warn('Passed over a flood of mail that arrived within a few seconds', window);
    return { messages: [], resume_from: before };
  }
  // A flood is read once, so a read that ran out of time is not tried again: the rest of the flood is passed over too.
  logger.warn('Read only mail from always-important senders in a flood of mail that arrived within a few seconds', {
    ...window,
    whole: kept.read === 'all',
  });
  return { messages: kept.messages, resume_from: before };
}

/**
 * Mail from someone the person marked always important, when the mail server vouched for the sender, and bills or
 * deadlines named in any new mail. A message from an always-important address that the server did not vouch for is
 * handled as ordinary mail: it can still be a bill, but only as a note.
 *
 * A failed read is one of three kinds. A message the source can never read is passed over at once. A busy or
 * unreachable server, or a read that ran out of time, stops the pass at that message and never counts against it. Any
 * other failure may be about the message or about the server, so it counts as a failed pass for the message only when
 * a read of a later message worked after it. A message that fails `MAX_STUCK_PASSES` counted passes is passed over. The
 * next pass starts at the earliest message not read, so no failure holds up mail for good and none loses what the
 * messages before it found. A pass that runs out of time stops there, without counting anything.
 */
export async function watchMail({
  source,
  settings,
  since,
  now,
  logger,
  stuck,
  out_of_time,
}: {
  source: MailSource;
  settings: ReachSettings;
  since: Date;
  now: Date;
  logger: Pick<Logger, 'warn'>;
  /** The message or stretch of mail the last pass failed on, when it did. */
  stuck: StuckMessage | undefined;
  /** Whether the pass has used the time it has, so it stops cleanly before its connection ends. */
  out_of_time: () => boolean;
}): Promise<MailFindings> {
  const always = new Map(settings.always_important.map(sender => [sender.address, sender]));
  const window = await readMailWindow({
    source,
    since,
    now,
    limit: MAIL_PASS_LIMIT,
    keep_from: [...always.keys()],
    logger,
    out_of_time,
  });
  if (window.unlistable !== undefined) {
    return passOverUnlistable({
      since,
      before: window.unlistable.before,
      error: window.unlistable.error,
      stuck,
      logger,
    });
  }
  const { messages } = window;
  const findings = { raise: new Array<NoticingEvent>(), track: new Array<NoticingEvent>() };
  // A count from an earlier pass carries on only while its message is still in the window.
  let carried = stuck !== undefined && messages.some(message => message.id === stuck.message_id) ? stuck : undefined;
  // The first message the next pass must read again, if any.
  let open: MailMessage | undefined;
  // A failure not yet known to be about its message: it is confirmed by the next message whose read worked.
  let unconfirmed: { message: MailMessage; error: unknown } | undefined;
  // A confirmed failure that has not reached the limit: it is the message the next pass starts at.
  let held: { failed: StuckMessage; error: unknown } | undefined;
  let stoppedBy: { error: unknown } | undefined;
  let passedOver = 0;

  for (const message of messages) {
    if (out_of_time()) {
      open ??= message;
      break;
    }
    try {
      const found = await findInMessage({ source, message, settings, always, now, logger });
      findings.raise.push(...found.raise);
      findings.track.push(...found.track);
      carried = carried?.message_id === message.id ? undefined : carried;
      if (found.served && unconfirmed !== undefined) {
        // A read worked after the failure, so the failure is about its message.
        const failed = {
          message_id: unconfirmed.message.id,
          passes: carried?.message_id === unconfirmed.message.id ? carried.passes + 1 : 1,
        };
        // After one message was passed over, the next to fail with proof of a working server is passed over after a
        // single pass, so many bad messages cannot hold up the rest for long.
        if (failed.passes >= (passedOver > 0 ? 1 : MAX_STUCK_PASSES)) {
          passedOver += 1;
          logger.warn('Passed over a mail the mail server kept failing on', {
            message_id: failed.message_id,
            passes: failed.passes,
            error: causeText(unconfirmed.error),
          });
          carried = carried?.message_id === failed.message_id ? undefined : carried;
          open = open === unconfirmed.message ? undefined : open;
        } else {
          held = { failed, error: unconfirmed.error };
        }
        unconfirmed = undefined;
      }
    } catch (error) {
      if (error instanceof MessageUnreadableError) {
        logger.warn('Passed over a mail that could not be read', { message_id: message.id, error: causeText(error) });
        carried = carried?.message_id === message.id ? undefined : carried;
        continue;
      }
      open ??= message;
      // A busy server, or a second unclear failure with no working read between, says nothing about either message.
      if (error instanceof MailSourceBusyError || unconfirmed !== undefined || held !== undefined) {
        stoppedBy = { error };
        break;
      }
      unconfirmed = { message, error };
    }
  }
  const lastFailure = unconfirmed ?? held;
  stoppedBy ??= lastFailure === undefined ? undefined : { error: lastFailure.error };
  return {
    ...findings,
    // Messages come oldest first where dates are arrival times. Elsewhere the sender's Date can sit later than the
    // true arrival, so only the start of the window is safe to read from again.
    resume_from: open === undefined ? window.resume_from : source.datesAreArrival ? open.received_at : since,
    stuck: held?.failed ?? carried,
    stopped_by: stoppedBy,
  };
}

/** A stretch of mail that cannot be listed is counted like a message, and passed over after the same passes. */
function passOverUnlistable({
  since,
  before,
  error,
  stuck,
  logger,
}: {
  since: Date;
  before: Date;
  error: unknown;
  stuck: StuckMessage | undefined;
  logger: Pick<Logger, 'warn'>;
}): MailFindings {
  const key = listSliceKey(since);
  const passes = stuck?.message_id === key ? stuck.passes + 1 : 1;
  if (passes < MAX_STUCK_PASSES) {
    return {
      raise: [],
      track: [],
      resume_from: since,
      stuck: { message_id: key, passes },
      stopped_by: { error },
    };
  }
  logger.warn('Passed over mail that the mail server could not list', {
    since: since.toISOString(),
    before: before.toISOString(),
    passes,
    error: causeText(error),
  });
  return { raise: [], track: [], resume_from: before, stuck: undefined, stopped_by: undefined };
}

function causeText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.cause instanceof Error ? error.cause.message : error.message;
}

async function findInMessage({
  source,
  message,
  settings,
  always,
  now,
  logger,
}: {
  source: MailSource;
  message: MailMessage;
  settings: ReachSettings;
  always: ReadonlyMap<string, AlwaysImportantSender>;
  now: Date;
  logger: Pick<Logger, 'warn'>;
}): Promise<Pick<MailFindings, 'raise' | 'track'> & { served: boolean }> {
  const found: Pick<MailFindings, 'raise' | 'track'> & { served: boolean } = { raise: [], track: [], served: false };
  /** Reads a message's text, and notes that the server answered. */
  const readText = async (item: MailMessage): Promise<string> => {
    const text = await source.readText(item);
    found.served = true;
    return text;
  };
  const listed = always.get(message.from_address.toLowerCase());
  const verified =
    listed !== undefined &&
    checkSender({
      from_address: message.from_address,
      headers: message.authentication_results,
      trusted_servers: source.trustedAuthenticationServers,
    }).verified;
  if (listed !== undefined && verified) {
    const text = clip(await readText(message), READ_CHARACTERS);
    const who = listed.name ?? message.from_name ?? message.from_address;
    found.raise.push({
      id: `mail_always:${message.id}`,
      kind: 'mail_always',
      evidence: 'verified_sender',
      summary: clip(`New mail from ${who}: ${message.subject}`, 300),
      facts: [`From: ${senderLabel(message)}`, `Subject: ${message.subject}`, `Start of the message: ${text}`].join(
        '\n',
      ),
      matched: `${who} is on your always-important list and the mail server confirmed the sender.`,
      link: null,
      mail_ref: { message_id: message.id, thread_id: message.thread_id },
      occurred_at: message.received_at.toISOString(),
      due_at: null,
    });
  }
  const bill = await billFrom({ readText, message, settings, verified, now });
  if (bill === undefined) {
    return found;
  }
  // A thread that cannot be checked says nothing about the message itself, so the bill is kept to be checked again
  // with the tracked bills, and is raised once it is close to due.
  const paid = await billIsPaid({ source, event: bill }).then(
    value => {
      found.served = true;
      return value;
    },
    (error: unknown) => {
      logger.warn('Could not check whether a bill was paid; it is checked again later', {
        message_id: message.id,
        error: causeText(error),
      });
      return undefined;
    },
  );
  if (paid === true) {
    return found;
  }
  if (
    paid === undefined ||
    (bill.due_at !== null && new Date(bill.due_at).getTime() - now.getTime() > BILL_WINDOW_MS)
  ) {
    found.track.push(bill);
  } else if (found.raise.length === 0) {
    // Mail already raised for its sender is not raised a second time as a bill.
    found.raise.push(bill);
  }
  return found;
}

async function billFrom({
  readText,
  message,
  settings,
  verified,
  now,
}: {
  readText: (message: MailMessage) => Promise<string>;
  message: MailMessage;
  settings: ReachSettings;
  verified: boolean;
  now: Date;
}): Promise<NoticingEvent | undefined> {
  if (!looksLikeBill(`${message.subject}\n${message.snippet}`)) {
    return undefined;
  }
  const text = clip(await readText(message), READ_CHARACTERS * 2);
  const due = findDeadline({
    text: `${message.subject}\n${text}`,
    received_at: message.received_at,
    timezone: settings.timezone,
  });
  if (due === undefined || due.getTime() < now.getTime() || due.getTime() - now.getTime() > BILL_TRACK_LIMIT_MS) {
    return undefined;
  }
  const subject = clip(message.subject, 120);
  return {
    id: `bill_due:${message.id}`,
    kind: 'bill_due',
    evidence: verified ? 'verified_sender' : 'content',
    summary: clip(`A bill or deadline is due ${localDate({ at: due, timezone: settings.timezone })}: ${subject}`, 300),
    facts: [
      `From: ${senderLabel(message)}`,
      `Subject: ${message.subject}`,
      `Due: ${due.toISOString()}`,
      `Start of the message: ${clip(text, READ_CHARACTERS)}`,
    ].join('\n'),
    matched: 'A message names this date as a due date, and nothing later says it was paid.',
    link: null,
    mail_ref: { message_id: message.id, thread_id: message.thread_id },
    occurred_at: message.received_at.toISOString(),
    due_at: due.toISOString(),
  };
}

/** Whether anything after the bill's message in its thread says it was paid. */
export async function billIsPaid({ source, event }: { source: MailSource; event: NoticingEvent }): Promise<boolean> {
  if (event.mail_ref === null) {
    return false;
  }
  const later = await source.laterInThread({
    id: event.mail_ref.message_id,
    thread_id: event.mail_ref.thread_id,
    received_at: new Date(event.occurred_at),
  });
  return later.some(saysPaid);
}

/** Clashes in the next 24 hours, and events with a place that start within the person's travel lead time. */
export async function watchCalendar({
  source,
  settings,
  now,
}: {
  source: CalendarSource;
  settings: ReachSettings;
  now: Date;
}): Promise<NoticingEvent[]> {
  const leadMs = settings.travel_lead_minutes * 60_000;
  const horizon = Math.max(CLASH_WINDOW_MS, leadMs);
  const events = await source.listEvents({ from: now, to: new Date(now.getTime() + horizon) });
  const found: NoticingEvent[] = [];
  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id));
  for (let i = 0; i < sorted.length; i += 1) {
    const first = sorted[i];
    if (first === undefined) {
      continue;
    }
    for (let j = i + 1; j < sorted.length; j += 1) {
      const second = sorted[j];
      if (second === undefined || second.start.getTime() >= first.end.getTime()) {
        break;
      }
      const overlapStart = Math.max(first.start.getTime(), second.start.getTime());
      if (overlapStart < now.getTime() || overlapStart > now.getTime() + CLASH_WINDOW_MS) {
        continue;
      }
      found.push(clashEvent({ first, second, timezone: settings.timezone }));
    }
    if (isTravel({ event: first, now, leadMs })) {
      found.push(travelEvent({ event: first, timezone: settings.timezone }));
    }
  }
  return found;
}

function clashEvent({
  first,
  second,
  timezone,
}: {
  first: CalendarEventInfo;
  second: CalendarEventInfo;
  timezone: string;
}): NoticingEvent {
  const [a, b] = [first, second].sort((x, y) => x.id.localeCompare(y.id));
  const left = a ?? first;
  const right = b ?? second;
  return {
    id: `calendar_clash:${left.id}@${left.start.toISOString()}:${right.id}@${right.start.toISOString()}`,
    kind: 'calendar_clash',
    evidence: first.own && second.own ? 'own' : 'content',
    summary: clip(
      `"${clip(first.title, 60)}" at ${localTime({ at: first.start, timezone })} overlaps "${clip(second.title, 60)}" at ${localTime({ at: second.start, timezone })}.`,
      300,
    ),
    facts: [
      `Event one: ${clip(first.title, 120)}, ${first.start.toISOString()} to ${first.end.toISOString()}`,
      `Event two: ${clip(second.title, 120)}, ${second.start.toISOString()} to ${second.end.toISOString()}`,
    ].join('\n'),
    matched: 'Two events on your calendar overlap in the next 24 hours.',
    link: null,
    mail_ref: null,
    occurred_at: new Date(Math.max(first.start.getTime(), second.start.getTime())).toISOString(),
    due_at: null,
  };
}

/** A place worth travelling to: it is written down, and it is not a video link. */
function hasPlace(location: string | null): location is string {
  return location !== null && location.trim() !== '' && !/^(https?:\/\/|www\.)/i.test(location.trim());
}

function isTravel({ event, now, leadMs }: { event: CalendarEventInfo; now: Date; leadMs: number }): boolean {
  const until = event.start.getTime() - now.getTime();
  return hasPlace(event.location) && until > 0 && until <= leadMs;
}

function travelEvent({ event, timezone }: { event: CalendarEventInfo; timezone: string }): NoticingEvent {
  return {
    id: `travel:${event.id}@${event.start.toISOString()}`,
    kind: 'travel',
    evidence: event.own ? 'own' : 'content',
    summary: clip(
      `"${clip(event.title, 80)}" starts at ${localTime({ at: event.start, timezone })}. Time to head out.`,
      300,
    ),
    facts: [
      `Event: ${clip(event.title, 120)}`,
      `Starts: ${event.start.toISOString()}`,
      `Place: ${clip(event.location ?? '', 160)}`,
    ].join('\n'),
    matched: 'An event with a place starts within your travel lead time.',
    link: null,
    mail_ref: null,
    occurred_at: event.start.toISOString(),
    due_at: null,
  };
}

/** One person's open requests that have waited longer than the time they chose. */
export function watchApprovals({
  waiting,
  settings,
  now,
}: {
  waiting: readonly WaitingApproval[];
  settings: ReachSettings;
  now: Date;
}): NoticingEvent[] {
  const limitMs = settings.approval_wait_minutes * 60_000;
  const expiryMs = APPROVAL_EXPIRY_MINUTES * 60_000;
  // A request that has waited past its expiry is closed when the person opens the chat, so there is nothing to ask.
  return waiting
    .filter(item => {
      const waited = now.getTime() - item.waiting_since.getTime();
      return waited >= limitMs && waited < expiryMs;
    })
    .map(item => {
      const minutes = Math.max(1, Math.round((now.getTime() - item.waiting_since.getTime()) / 60_000));
      return {
        id: `approval_waiting:${item.session_id}:${item.approval_id}`,
        kind: 'approval_waiting',
        evidence: 'own',
        summary: `Something has been waiting for your ok for about ${String(minutes)} minutes. It closes after ${String(APPROVAL_EXPIRY_MINUTES)}.`,
        facts: `A request for the person's ok has waited about ${String(minutes)} minutes.`,
        matched: `An approval has waited longer than the ${String(settings.approval_wait_minutes)} minutes you chose.`,
        link: { type: 'approval', session_id: item.session_id, approval_id: item.approval_id },
        mail_ref: null,
        occurred_at: item.waiting_since.toISOString(),
        due_at: null,
      } satisfies NoticingEvent;
    });
}

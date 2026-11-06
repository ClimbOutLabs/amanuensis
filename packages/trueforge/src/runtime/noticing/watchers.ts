import { APPROVAL_EXPIRY_MINUTES } from '@truefoundry/trueforge-core/core/permissions/approvalExpiry';

import type { NoticingEvent, ReachSettings } from '../../schemas/reach';
import { checkSender } from './authenticationResults';
import { findDeadline, looksLikeBill, saysPaid } from './deadlines';
import type { CalendarEventInfo, CalendarSource, MailMessage, MailSource, WaitingApproval } from './sources';

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

/**
 * What one pass over new mail found. `track` are bills due later than the window, kept until they come near. When
 * `read_until` is set, there was more mail than one pass reads, and the next pass carries on from that time.
 */
export interface MailFindings {
  raise: NoticingEvent[];
  track: NoticingEvent[];
  read_until: Date | undefined;
}

/**
 * Mail from someone the person marked always important, when the mail server vouched for the sender, and bills or
 * deadlines named in any new mail. A message from an always-important address that the server did not vouch for is
 * handled as ordinary mail: it can still be a bill, but only as a note.
 */
export async function watchMail({
  source,
  settings,
  since,
  now,
}: {
  source: MailSource;
  settings: ReachSettings;
  since: Date;
  now: Date;
}): Promise<MailFindings> {
  const { messages, truncated } = await source.listNewMessages({ since, limit: MAIL_PASS_LIMIT });
  const always = new Map(settings.always_important.map(sender => [sender.address, sender]));
  const newest = messages.at(-1)?.received_at;
  const findings: MailFindings = { raise: [], track: [], read_until: truncated ? newest : undefined };
  for (const message of messages) {
    const listed = always.get(message.from_address.toLowerCase());
    const check =
      listed === undefined
        ? undefined
        : checkSender({
            from_address: message.from_address,
            headers: message.authentication_results,
            trusted_servers: source.trustedAuthenticationServers,
          });
    const verified = check?.verified === true;
    if (listed !== undefined && verified) {
      const text = clip(await source.readText(message), READ_CHARACTERS);
      const who = listed.name ?? message.from_name ?? message.from_address;
      findings.raise.push({
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
    const bill = await billFrom({ source, message, settings, verified, now });
    if (bill !== undefined && !(await billIsPaid({ source, event: bill }))) {
      (bill.due_at !== null && new Date(bill.due_at).getTime() - now.getTime() > BILL_WINDOW_MS
        ? findings.track
        : findings.raise
      ).push(bill);
    }
  }
  return findings;
}

async function billFrom({
  source,
  message,
  settings,
  verified,
  now,
}: {
  source: MailSource;
  message: MailMessage;
  settings: ReachSettings;
  verified: boolean;
  now: Date;
}): Promise<NoticingEvent | undefined> {
  if (!looksLikeBill(`${message.subject}\n${message.snippet}`)) {
    return undefined;
  }
  const text = clip(await source.readText(message), READ_CHARACTERS * 2);
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

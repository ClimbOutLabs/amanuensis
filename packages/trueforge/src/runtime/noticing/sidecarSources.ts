import { extractErrorLogFields, RemoteMCP } from '@truefoundry/trueforge-core/core';
import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import { deliveredMailboxOf } from '@truefoundry/trueforge-core/core/email/gmail/mailbox';
import {
  accountNamesOfResult,
  emailsOfResult,
} from '@truefoundry/trueforge-core/core/email/mailConnector/mailToolResults';
import {
  MAIL_ACCOUNT_LIST_TOOL_NAME,
  MAIL_CONNECTOR_NAME,
  MAIL_CONTENT_TOOL_NAME,
  MAIL_LIST_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import { isRecord } from '@truefoundry/trueforge-core/core/util/records';
import { createHash } from 'node:crypto';
import type { Logger } from 'winston';
import { z } from 'zod';

import type { PersonOwner } from '../../db/personOwner';
import {
  MailLoginFailedError,
  MailSourceBusyError,
  MailTooSlowError,
  MessageUnreadableError,
  type CalendarEventInfo,
  type CalendarSource,
  type CursorMailSource,
  type CursorMessage,
  type CursorRead,
  type MailAccess,
  type MailMessage,
  type MailRef,
  type NoticingSourceProvider,
  type NoticingSources,
} from './sources';

/** Calls one tool on a sidecar and returns its result as the MCP client gives it. */
export type CallSidecarTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Longest one watcher pass may keep a sidecar session open; the client ends the session after this. */
const SIDECAR_SESSION_MS = 4 * 60_000;
const TEXT_CHARACTERS = 3000;
/** Longest one calendar call may take. The client cancels a call that runs over, so none is left running. */
const CALENDAR_CALL_MS = 30_000;
/**
 * Longest one mail call may take. Listing searches whole days of a mailbox, which a slow server can take a while
 * over, so mail has more time than the calendar. The connector gives up on its own after about a minute.
 */
const MAIL_CALL_MS = 75_000;

/** The sidecar answered a tool call with an error. `reply` is its own words, for the log and for telling errors apart. */
export class SidecarToolError extends Error {
  readonly reply: string;

  constructor({ server, tool, reply }: { server: string; tool: string; reply: string }) {
    super(`The ${server} connector could not run ${tool}.`);
    this.name = 'SidecarToolError';
    this.reply = reply;
  }
}

/** The result of a tool call, or the sidecar's error when it answered with one. */
export function toolResultOf({ server, tool, result }: { server: string; tool: string; result: unknown }): unknown {
  if (!isRecord(result) || result['isError'] !== true) {
    return result;
  }
  const content = result['content'];
  const reply = (Array.isArray(content) ? content : [])
    .map((block: unknown) => (isRecord(block) ? text(block['text']) : undefined))
    .filter((line): line is string => line !== undefined)
    .join(' ');
  throw new SidecarToolError({ server, tool, reply });
}

/** Whether the connector said, as the error itself or as its cause, something its reply matches. */
function replySays({ error, pattern }: { error: unknown; pattern: RegExp }): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof SidecarToolError && pattern.test(current.reply)) {
      return true;
    }
  }
  return false;
}

/** Whether the connector could not log in to the mail account. */
function saysLoginFailed(error: unknown): boolean {
  return replySays({ error, pattern: /not connected|login failed|authentication failed|invalid credentials/i });
}

/** Replies that say the mail server or the connection to it is out of reach, not anything about a message. */
function saysUnavailable(error: unknown): boolean {
  return saysLoginFailed(error) || replySays({ error, pattern: /timed out|timeout|transport/i });
}

const LATER_MESSAGES = 10;
const EVENTS_PER_PASS = 100;

/** A sidecar's tools through the same remote client a connector uses. Read tools only are ever called here. */
function sidecarTools({
  name,
  url,
  logger,
  callMs,
}: {
  name: string;
  url: string;
  logger: Logger;
  callMs: number;
}): CallSidecarTool {
  const remote = new RemoteMCP({
    name,
    id: name,
    url,
    headers: {},
    logger,
    requestTimeoutMs: callMs,
    connectTimeoutMs: 30_000,
    signal: AbortSignal.timeout(SIDECAR_SESSION_MS),
    refuseRedirects: true,
  });
  return async (tool, args) => {
    const response = await remote.callTool({ name: tool, arguments: args });
    if (!('result' in response)) {
      throw new Error(`The ${name} connector asked for sign-in.`);
    }
    return toolResultOf({ server: name, tool, result: response.result });
  };
}

/** A subject with its reply and forward prefixes removed, so a reply finds the mail it answers. */
export function bareSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|aw|sv)\s*:\s*)+/i, '').trim();
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The sidecar gives the Date the sender wrote, not when the mail arrived. The server picked the mail by arrival, so
 * it arrived inside `arrived`, and a written Date outside that span (late, early or garbled) is moved to its edge.
 */
function toMailMessage({
  email,
  arrived,
}: {
  email: unknown;
  arrived: { from: Date; to: Date };
}): MailMessage | undefined {
  if (!isRecord(email)) {
    return undefined;
  }
  const id = text(email['email_id']);
  const sender = text(email['sender']);
  const written = new Date(text(email['date']) ?? '').getTime();
  const latest = arrived.to.getTime() - 1;
  const date = new Date(Number.isNaN(written) ? latest : Math.min(Math.max(written, arrived.from.getTime()), latest));
  if (id === undefined || sender === undefined) {
    return undefined;
  }
  const from = deliveredMailboxOf(sender);
  if (from.address === '') {
    return undefined;
  }
  const subject = text(email['subject']) ?? '';
  return {
    id,
    // The sidecar gives no thread, so the subject stands in for one when a later reply is looked for.
    thread_id: bareSubject(subject) === '' ? null : bareSubject(subject),
    from_address: from.address.toLowerCase(),
    from_name: from.name === '' ? null : from.name,
    subject,
    snippet: '',
    received_at: date,
    // The mail sidecar does not pass on the receiving server's checks, so no sender can be vouched for.
    authentication_results: [],
  };
}

/**
 * The id of an IMAP message in the app: its UID with the mailbox's UIDVALIDITY, since a renumbered mailbox gives the
 * same UID to another message. Events are keyed on it, so new mail is never mistaken for old.
 */
export function imapMessageId({ uidvalidity, uid }: { uidvalidity: number; uid: number }): string {
  return `imap:${String(uidvalidity)}:${String(uid)}`;
}

const IMAP_MESSAGE_ID = /^imap:(\d+):(\d+)$/;

/**
 * What events about an IMAP message are named by: its Message-ID with its sender, Date header and subject, none of
 * which change when the mailbox is renumbered. A message that copies another's Message-ID, or a sender that reuses
 * one, still makes its own event. Hashed, since headers are free text of any length.
 */
function messageKey(parts: { message_id: string; from_address: string; date: string | null; subject: string }): string {
  const hashed = JSON.stringify([parts.message_id, parts.from_address, parts.date, parts.subject]);
  return `mid:${createHash('sha256').update(hashed).digest('hex').slice(0, 32)}`;
}

/** The UID the Email connector's tools take for a message id. */
function connectorIdOf(id: string): string {
  return IMAP_MESSAGE_ID.exec(id)?.[2] ?? id;
}

/** The UIDVALIDITY a message id was numbered under, or undefined for an id that carries none. */
function uidvalidityOf(id: string): number | undefined {
  const found = IMAP_MESSAGE_ID.exec(id)?.[1];
  return found === undefined ? undefined : Number(found);
}

/** One request to the mail sidecar's account agent for the mail after a cursor, answered as the app reads it. */
export type ListAfterAgent = (request: {
  uidvalidity: number | null;
  last_uid: number | null;
  dated_to_uid: number | null;
  dated_since: string | null;
  since: string;
  limit: number;
}) => Promise<CursorRead>;

const AgentMessageSchema = z.object({
  uid: z.number().int().positive(),
  internal_date: z.string(),
  from_address: z.string().min(1),
  from_name: z.string().nullable(),
  subject: z.string(),
  message_id: z.string().nullish(),
  date: z.string().nullish(),
});

const AgentReplySchema = z.object({
  uidvalidity: z.number().int().nonnegative(),
  last_uid: z.number().int().nonnegative(),
  dated_to_uid: z.number().int().nonnegative().nullable(),
  dated_since: z.string().nullable(),
  more: z.boolean(),
  skipped: z.number().int().nonnegative(),
  messages: z.array(z.unknown()),
});

const AgentErrorSchema = z.object({ error: z.string() });

const AgentMailboxSchema = z.object({ uidvalidity: z.number().int().nonnegative() });

/** The inbox's UIDVALIDITY now, from the mail sidecar's account agent. */
export type MailboxValidity = () => Promise<number>;

/** One call to the account agent, its failures told apart in the same words as a mail source's. */
async function askAgent({
  url,
  fetchImpl,
  path,
  request,
}: {
  url: string;
  fetchImpl: typeof fetch | undefined;
  path: '/list_after' | '/mailbox';
  /** The JSON body to post; without one the call is a GET. */
  request?: unknown;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await (fetchImpl ?? fetch)(`${url}${path}`, {
      ...(request === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }),
      signal: AbortSignal.timeout(MAIL_CALL_MS),
      redirect: 'error',
    });
  } catch (error) {
    throw error instanceof Error && error.name === 'TimeoutError'
      ? new MailTooSlowError({ cause: error })
      : new MailSourceBusyError({ cause: error });
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = AgentErrorSchema.safeParse(body);
    const word = failure.success ? failure.data.error : 'unknown';
    if (word === 'login_failed') {
      throw new MailLoginFailedError({ cause: new Error('The Email connector could not log in.') });
    }
    throw word === 'unavailable'
      ? new MailSourceBusyError({ cause: new Error('The mail server could not be reached.') })
      : new Error(`The mail agent could not read the mailbox (${word}).`);
  }
  return body;
}

export function imapMailboxValidity({
  url,
  fetchImpl,
}: {
  url: string;
  fetchImpl: typeof fetch | undefined;
}): MailboxValidity {
  return async () => AgentMailboxSchema.parse(await askAgent({ url, fetchImpl, path: '/mailbox' })).uidvalidity;
}

/**
 * The account agent's list of mail after a cursor. A message the agent sent that does not read as a message is counted
 * as skipped, and the cursor is already past it.
 */
export function imapAgent({ url, fetchImpl }: { url: string; fetchImpl: typeof fetch | undefined }): ListAfterAgent {
  return async request => {
    const reply = AgentReplySchema.parse(await askAgent({ url, fetchImpl, path: '/list_after', request }));
    let skipped = reply.skipped;
    const messages: CursorMessage[] = [];
    for (const raw of reply.messages) {
      const message = AgentMessageSchema.safeParse(raw);
      const arrived = message.success ? new Date(message.data.internal_date) : undefined;
      if (!message.success || arrived === undefined || Number.isNaN(arrived.getTime())) {
        skipped += 1;
        continue;
      }
      const { uid, from_address, from_name, subject, message_id, date } = message.data;
      const bare = bareSubject(subject);
      messages.push({
        id: imapMessageId({ uidvalidity: reply.uidvalidity, uid }),
        uid,
        key:
          message_id === null || message_id === undefined
            ? undefined
            : messageKey({ message_id, from_address: from_address.toLowerCase(), date: date ?? null, subject }),
        // The mail has no thread, so the subject stands in for one when a later reply is looked for.
        thread_id: bare === '' ? null : bare,
        from_address: from_address.toLowerCase(),
        from_name,
        subject,
        snippet: '',
        received_at: arrived,
        // The agent does not pass on the receiving server's checks, so no sender can be vouched for.
        authentication_results: [],
      });
    }
    const datedSince = reply.dated_since === null ? undefined : new Date(reply.dated_since);
    return {
      messages,
      skipped,
      cursor: {
        uidvalidity: reply.uidvalidity,
        last_uid: reply.last_uid,
        dated:
          reply.dated_to_uid === null || datedSince === undefined || Number.isNaN(datedSince.getTime())
            ? undefined
            : { to_uid: reply.dated_to_uid, since: datedSince },
      },
      more: reply.more,
    };
  };
}

/**
 * The Email sidecar (IMAP) as a mail source. Its tools give no Authentication-Results, so an always-important sender
 * is never verified here and its mail is read as ordinary mail. Bills and deadlines still work.
 */
export function sidecarMailSource({
  call,
  account,
  agent,
  validity,
}: {
  call: CallSidecarTool;
  account: string;
  agent: ListAfterAgent;
  validity: MailboxValidity;
}): CursorMailSource {
  /** The inbox's UIDVALIDITY, asked once per source and taken from every list, so many bills cost one call. */
  let current: Promise<number> | undefined;
  const currentValidity = (): Promise<number> => {
    current ??= validity().catch((error: unknown) => {
      current = undefined;
      throw error;
    });
    return current;
  };
  /**
   * Calls a tool. A dropped or abandoned call, the session ending, and a reply that says the connector ran out of time,
   * lost the connection or could not log in say the server is busy. The connector's other errors pass on as they are,
   * since they may be about the message.
   */
  const asked = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      return await call(tool, args);
    } catch (error) {
      if (error instanceof SidecarToolError && !saysUnavailable(error)) {
        throw error;
      }
      throw saysLoginFailed(error)
        ? new MailLoginFailedError({ cause: error })
        : new MailSourceBusyError({ cause: error });
    }
  };
  /** The bodies of the messages the connector could fetch. It reports the ones it could not as success, so they are just missing. */
  const bodiesOf = async (ids: readonly string[]): Promise<{ id: string; body: string }[]> => {
    const result = await asked(MAIL_CONTENT_TOOL_NAME, {
      account_name: account,
      email_ids: ids,
      mailbox: 'INBOX',
      mark_as_read: false,
    });
    return emailsOfResult(result).flatMap(email => {
      const id = isRecord(email) ? text(email['email_id']) : undefined;
      return isRecord(email) && id !== undefined
        ? [{ id, body: (text(email['body']) ?? '').slice(0, TEXT_CHARACTERS) }]
        : [];
    });
  };
  return {
    trustedAuthenticationServers: [],
    async listAfter({ cursor, since, limit, out_of_time }) {
      if (out_of_time()) {
        throw new MailTooSlowError({ cause: new Error('The pass ran out of time.') });
      }
      const reply = await agent({
        uidvalidity: cursor?.uidvalidity ?? null,
        last_uid: cursor?.last_uid ?? null,
        dated_to_uid: cursor?.dated?.to_uid ?? null,
        dated_since: cursor?.dated?.since.toISOString() ?? null,
        since: since.toISOString(),
        limit,
      });
      current = Promise.resolve(reply.cursor.uidvalidity);
      return reply;
    },
    async readText(message) {
      const [found] = await bodiesOf([connectorIdOf(message.id)]).catch((error: unknown) => {
        // The connector refuses a body over its size limit the same way every time.
        throw error instanceof SidecarToolError && /limit_exceeded/i.test(error.reply)
          ? new MessageUnreadableError({ cause: error })
          : error;
      });
      // A deleted message and a dropped connection both leave it missing, and which it was cannot be told, so this is
      // a failure that may clear.
      if (found === undefined) {
        throw new Error('The Email connector could not fetch the message.');
      }
      return found.body;
    },
    async laterInThread(ref: MailRef) {
      if (ref.thread_id === null) {
        return [];
      }
      // The bill is told apart from its replies by its UID, which names another message once the mailbox is
      // renumbered, so a bill from another numbering is never checked against the mail now there.
      const numbered = uidvalidityOf(ref.id);
      if (numbered === undefined || numbered !== (await currentValidity())) {
        throw new MessageUnreadableError({
          cause: new Error('The mailbox was renumbered since this bill was seen, so its thread cannot be checked.'),
        });
      }
      const result = await asked(MAIL_LIST_TOOL_NAME, {
        account_name: account,
        mailbox: 'INBOX',
        subject: ref.thread_id,
        since: ref.received_at.toISOString(),
        page: 1,
        page_size: LATER_MESSAGES,
        order: 'asc',
      });
      const ids = emailsOfResult(result)
        .map(email => toMailMessage({ email, arrived: { from: ref.received_at, to: new Date() } }))
        .filter((message): message is MailMessage => message !== undefined && message.id !== connectorIdOf(ref.id))
        .map(message => message.id);
      // A reply the connector cannot fetch is left out, so a stranger who joins a thread cannot hide a payment.
      return ids.length === 0 ? [] : (await bodiesOf(ids)).map(item => item.body);
    },
  };
}

/** An ISO time with an offset or Z. A time with neither says no instant, so it is left out. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function instantOf(time: unknown): Date | undefined {
  if (!isRecord(time) || time['all_day'] === true) {
    return undefined;
  }
  const value = text(time['value']);
  if (value === undefined || !INSTANT.test(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toEventInfo(event: unknown): CalendarEventInfo | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const id = text(event['id']);
  const start = instantOf(event['start']);
  const end = instantOf(event['end']);
  const attendees: unknown[] = Array.isArray(event['attendees']) ? event['attendees'] : [];
  const self = attendees.find(guest => isRecord(guest) && guest['is_self'] === true);
  const answer = isRecord(self) ? String(self['status']).toUpperCase() : undefined;
  const declined = answer === 'DECLINED';
  const organizer = event['organizer'];
  if (id === undefined || start === undefined || end === undefined || declined) {
    return undefined;
  }
  if (String(event['status']).toUpperCase() === 'CANCELLED') {
    return undefined;
  }
  return {
    id,
    title: text(event['summary']) ?? 'An event',
    start,
    end,
    location: text(event['location']) ?? null,
    // The stored invite says who organised it and who accepted, in words its sender wrote, so only an event with
    // no one on it at all is surely the person's own.
    own: (organizer === undefined || organizer === null) && attendees.length === 0,
  };
}

/** The Calendar sidecar (CalDAV) as a calendar source: timed events that are still on. */
export function sidecarCalendarSource({ call }: { call: CallSidecarTool }): CalendarSource {
  return {
    async listEvents({ from, to }) {
      const result = await call('list_events', {
        from: from.toISOString(),
        to: to.toISOString(),
        limit: EVENTS_PER_PASS,
      });
      const content = isRecord(result) ? result['structuredContent'] : undefined;
      const events = isRecord(content) && Array.isArray(content['events']) ? content['events'] : [];
      return events.map(toEventInfo).filter((event): event is CalendarEventInfo => event !== undefined);
    },
  };
}

/**
 * The instance's own mail and calendar sidecars. They hold one mailbox and one calendar for the whole instance, so
 * they belong to the instance owner only. Anyone else gets mail and calendar noticing only from their own Google
 * connection. The owner's own Google connection is used first where there is one.
 */
export function createSidecarNoticingSources({
  mailUrl,
  mailAgentUrl,
  calendarUrl,
  primary,
  instanceOwner,
  logger,
}: {
  mailUrl: string | undefined;
  /** The mail sidecar's account agent, which lists new mail. Without it the shared mailbox is not watched. */
  mailAgentUrl: string | undefined;
  calendarUrl: string | undefined;
  primary: NoticingSourceProvider;
  /** Who the shared connectors belong to, or undefined when the instance names no owner. */
  instanceOwner: PersonOwner | undefined;
  logger: Logger;
}): NoticingSourceProvider {
  /** The shared mail connector, told apart as not set up (no account) or set up but out of reach. */
  async function mailFromSidecar({ url, agentUrl }: { url: string; agentUrl: string }): Promise<MailAccess> {
    try {
      const call = sidecarTools({ name: MAIL_CONNECTOR_NAME, url, logger, callMs: MAIL_CALL_MS });
      const [account] = accountNamesOfResult(await call(MAIL_ACCOUNT_LIST_TOOL_NAME, {}));
      return account === undefined
        ? { status: 'none' }
        : {
            status: 'ready',
            source: sidecarMailSource({
              call,
              account,
              agent: imapAgent({ url: agentUrl, fetchImpl: undefined }),
              validity: imapMailboxValidity({ url: agentUrl, fetchImpl: undefined }),
            }),
            kind: 'email_connector',
          };
    } catch (error) {
      logger.warn('The Email sidecar could not be reached for noticing', extractErrorLogFields(error));
      return {
        status: 'unreachable',
        error: saysLoginFailed(error) ? new MailLoginFailedError({ cause: error }) : error,
        kind: 'email_connector',
      };
    }
  }
  return {
    async listOwners() {
      const listed = await primary.listOwners();
      return instanceOwner === undefined || (mailUrl === undefined && calendarUrl === undefined)
        ? listed
        : [...listed, instanceOwner];
    },
    async sourcesFor(owner: PersonOwner): Promise<NoticingSources> {
      const own = await primary.sourcesFor(owner);
      if (owner.tenant_id !== instanceOwner?.tenant_id || owner.created_by !== instanceOwner.created_by) {
        return own;
      }
      // The person's own Google login wins. The shared connector is read only when Google gives no mail at all, so a
      // login that has to be redone is shown instead of being hidden by another mailbox.
      return {
        mail:
          own.mail.status !== 'none' || mailUrl === undefined || mailAgentUrl === undefined
            ? own.mail
            : await mailFromSidecar({ url: mailUrl, agentUrl: mailAgentUrl }),
        calendar:
          own.calendar.status !== 'none' || calendarUrl === undefined
            ? own.calendar
            : {
                status: 'ready',
                source: sidecarCalendarSource({
                  call: sidecarTools({ name: CALDAV_SERVER_NAME, url: calendarUrl, logger, callMs: CALENDAR_CALL_MS }),
                }),
              },
      };
    },
  };
}

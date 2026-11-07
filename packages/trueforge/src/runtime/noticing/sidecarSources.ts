import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
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
import type { Logger } from 'winston';

import type { PersonOwner } from '../../db/personOwner';
import {
  MailLoginFailedError,
  MailSourceBusyError,
  MailTooSlowError,
  MessageUnreadableError,
  type CalendarEventInfo,
  type CalendarSource,
  type MailAccess,
  type MailMessage,
  type MailRef,
  type MailSource,
  type NoticingSourceProvider,
  type NoticingSources,
} from './sources';
import { SHORTEST_WINDOW_MS } from './watchers';

/** Calls one tool on a sidecar and returns its result as the MCP client gives it. */
export type CallSidecarTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Longest one watcher pass may keep a sidecar session open; the client ends the session after this. */
const SIDECAR_SESSION_MS = 4 * 60_000;
const TEXT_CHARACTERS = 3000;
/** The most the sidecar lists in one call. */
const PAGE_SIZE = 100;
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

/** Whether the connector gave up on a call by its own time limit. */
function saysTimedOut(error: unknown): boolean {
  return replySays({ error, pattern: /timed out|timeout/i });
}

/** Whether the connector could not log in to the mail account. */
function saysLoginFailed(error: unknown): boolean {
  return replySays({ error, pattern: /not connected|login failed|authentication failed|invalid credentials/i });
}

/** Replies that say the mail server or the connection to it is out of reach, not anything about a message. */
function saysUnavailable(error: unknown): boolean {
  return saysLoginFailed(error) || replySays({ error, pattern: /timed out|timeout|transport/i });
}

/** Whether an error, or one it was caused by, is the MCP client giving up on a call that took too long. */
function isCallTimeout(error: unknown): boolean {
  const timedOut: number = ErrorCode.RequestTimeout;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof McpError && current.code === timedOut) {
      return true;
    }
  }
  return false;
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
 * The Email sidecar (IMAP) as a mail source. Its tools give no Authentication-Results, so an always-important sender
 * is never verified here and its mail is read as ordinary mail. Bills and deadlines still work.
 */
export function sidecarMailSource({ call, account }: { call: CallSidecarTool; account: string }): MailSource {
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
    datesAreArrival: false,
    async listNewMessages({ since, before, limit, from, out_of_time, whole }) {
      // The sidecar picks and orders mail by the server's arrival time, which is what the window means. The Date a
      // sender wrote can be late or early, so it is never used to pick or order. A window longer than a few seconds
      // is read in one call. A short one may be read page by page, where mail deleted meanwhile can shift a page and
      // hide one message of those few seconds, which is accepted.
      const size = Math.min(limit + 1, PAGE_SIZE);
      const short = before.getTime() - since.getTime() <= SHORTEST_WINDOW_MS;
      const listed: unknown[] = [];
      let skipped = 0;
      for (const address of from ?? [undefined]) {
        const page = async (input: { page: number; size: number }): Promise<unknown[]> =>
          emailsOfResult(
            await asked(MAIL_LIST_TOOL_NAME, {
              account_name: account,
              mailbox: 'INBOX',
              since: since.toISOString(),
              before: before.toISOString(),
              ...(address === undefined ? {} : { from_address: address }),
              page: input.page,
              page_size: input.size,
              order: 'asc',
            }).catch((error: unknown) => {
              throw isCallTimeout(error) || saysTimedOut(error) ? new MailTooSlowError({ cause: error }) : error;
            }),
          );
        let emails: unknown[];
        let byPage = short;
        try {
          emails = await page({ page: 1, size });
        } catch (error) {
          if (error instanceof MailSourceBusyError || !short || whole === true) {
            throw error;
          }
          // The connector fetches headers only for the messages on the page it lists, and fails the whole page when
          // one message's headers do not parse. In a few seconds of mail, one message at a time finds the one.
          const found = await listOneByOne({ page, error, limit, out_of_time });
          emails = found.emails;
          skipped += found.skipped;
          byPage = false;
        }
        // A few seconds of mail may hold more than one page. Longer windows are too big to read once a page is full.
        for (let number = 2; byPage && emails.length >= size && emails.length <= limit; number += 1) {
          if (out_of_time()) {
            throw new MailTooSlowError({ cause: new Error('The pass ran out of time.') });
          }
          const more = await page({ page: number, size });
          emails.push(...more);
          if (more.length < size) {
            break;
          }
        }
        if (emails.length >= size && (!short || emails.length > limit)) {
          return { read: 'too_many' };
        }
        listed.push(...emails);
        if (listed.length > limit) {
          return { read: 'too_many' };
        }
      }
      return {
        read: 'all',
        messages: listed
          .map(email => toMailMessage({ email, arrived: { from: since, to: before } }))
          .filter((message): message is MailMessage => message !== undefined),
        ...(skipped > 0 ? { skipped } : {}),
      };
    },
    async readText(message) {
      const [found] = await bodiesOf([message.id]).catch((error: unknown) => {
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
        .filter((message): message is MailMessage => message !== undefined && message.id !== ref.id)
        .map(message => message.id);
      // A reply the connector cannot fetch is left out, so a stranger who joins a thread cannot hide a payment.
      return ids.length === 0 ? [] : (await bodiesOf(ids)).map(item => item.body);
    },
  };
}

/** The most messages a few seconds of mail may lose to one-by-one listing before the stretch counts as unlistable. */
const MOST_SKIPPED_ONE_BY_ONE = 20;
/** Pages that fail this many times in a row with none working before them say the account is failing, not a message. */
const MOST_BAD_IN_A_ROW = 6;

/**
 * Messages in a few seconds of mail are listed one per page, so only a message the connector cannot list is lost. A
 * page that fails is tried once more before its message is left out. Once any page has worked, the rest are listed
 * however many fail, so mail around a few bad headers is still read.
 */
async function listOneByOne({
  page,
  error,
  limit,
  out_of_time,
}: {
  page: (input: { page: number; size: number }) => Promise<unknown[]>;
  error: unknown;
  limit: number;
  out_of_time: () => boolean;
}): Promise<{ emails: unknown[]; skipped: number }> {
  const emails: unknown[] = [];
  let skipped = 0;
  let inARow = 0;
  const pageTwice = async (number: number): Promise<unknown[]> => {
    try {
      return await page({ page: number, size: 1 });
    } catch (first) {
      if (first instanceof MailSourceBusyError) {
        throw first;
      }
      if (out_of_time()) {
        throw new MailTooSlowError({ cause: first });
      }
      return await page({ page: number, size: 1 });
    }
  };
  for (let number = 1; emails.length <= limit; number += 1) {
    if (out_of_time()) {
      throw new MailTooSlowError({ cause: error });
    }
    try {
      const [email] = await pageTwice(number);
      if (email === undefined) {
        break;
      }
      emails.push(email);
      inARow = 0;
    } catch (pageError) {
      if (pageError instanceof MailSourceBusyError) {
        throw pageError;
      }
      skipped += 1;
      inARow += 1;
      // Pages that all fail are the account or the server, not one message, and so are too many bad ones.
      if ((emails.length === 0 && inARow >= MOST_BAD_IN_A_ROW) || skipped > MOST_SKIPPED_ONE_BY_ONE) {
        throw error;
      }
    }
  }
  return { emails, skipped };
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
  calendarUrl,
  primary,
  instanceOwner,
  logger,
}: {
  mailUrl: string | undefined;
  calendarUrl: string | undefined;
  primary: NoticingSourceProvider;
  /** Who the shared connectors belong to, or undefined when the instance names no owner. */
  instanceOwner: PersonOwner | undefined;
  logger: Logger;
}): NoticingSourceProvider {
  /** The shared mail connector, told apart as not set up (no account) or set up but out of reach. */
  async function mailFromSidecar(url: string): Promise<MailAccess> {
    try {
      const call = sidecarTools({ name: MAIL_CONNECTOR_NAME, url, logger, callMs: MAIL_CALL_MS });
      const [account] = accountNamesOfResult(await call(MAIL_ACCOUNT_LIST_TOOL_NAME, {}));
      return account === undefined
        ? { status: 'none' }
        : { status: 'ready', source: sidecarMailSource({ call, account }), kind: 'email_connector' };
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
        mail: own.mail.status !== 'none' || mailUrl === undefined ? own.mail : await mailFromSidecar(mailUrl),
        calendar:
          own.calendar ??
          (calendarUrl === undefined
            ? undefined
            : sidecarCalendarSource({
                call: sidecarTools({ name: CALDAV_SERVER_NAME, url: calendarUrl, logger, callMs: CALENDAR_CALL_MS }),
              })),
      };
    },
  };
}

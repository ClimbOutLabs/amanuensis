import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { extractErrorLogFields, RemoteMCP } from '@truefoundry/trueforge-core/core';
import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import { deliveredMailboxOf } from '@truefoundry/trueforge-core/core/email/gmail/mailbox';
import {
  accountNamesOfResult,
  emailsOfResult,
  failedIdsOfResult,
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
  MailSourceBusyError,
  MailTooSlowError,
  type CalendarEventInfo,
  type CalendarSource,
  type MailMessage,
  type MailRef,
  type MailSource,
  type NoticingSourceProvider,
  type NoticingSources,
} from './sources';

/** Calls one tool on a sidecar and returns its result as the MCP client gives it. */
export type CallSidecarTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Longest one watcher pass may keep a sidecar session open. */
const SIDECAR_SESSION_MS = 4 * 60_000;
const TEXT_CHARACTERS = 3000;
/** The most the sidecar lists in one call. */
const PAGE_SIZE = 100;
/** Longest one calendar call may take. The client cancels a call that runs over, so none is left running. */
const CALENDAR_CALL_MS = 30_000;
/**
 * Longest one mail call may take. Listing searches whole days of a mailbox, which a slow server can take a while
 * over, so mail has more time than the calendar. The connector gives up on its own after about a minute. A list, a
 * body read and a thread read at this limit still fit inside the session.
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

/** Whether the connector gave up on a call by its own time limit. */
function saysTimedOut(error: unknown): boolean {
  return error instanceof SidecarToolError && /timed out|timeout/i.test(error.reply);
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
  /** Calls a tool. The connector's own errors pass on as they are; a dropped or abandoned call says the server is busy. */
  const asked = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      return await call(tool, args);
    } catch (error) {
      throw error instanceof SidecarToolError ? error : new MailSourceBusyError({ cause: error });
    }
  };
  const bodiesOf = async (ids: readonly string[]): Promise<{ id: string; body: string }[]> => {
    const result = await asked(MAIL_CONTENT_TOOL_NAME, {
      account_name: account,
      email_ids: ids,
      mailbox: 'INBOX',
      mark_as_read: false,
    });
    // The connector reads each message on its own and reports the ones it could not fetch, a deleted message and a
    // dropped connection alike, as success. Which of the two it was cannot be told, so it is a failure that may clear.
    const bodies = emailsOfResult(result).flatMap(email => {
      const id = isRecord(email) ? text(email['email_id']) : undefined;
      return isRecord(email) && id !== undefined
        ? [{ id, body: (text(email['body']) ?? '').slice(0, TEXT_CHARACTERS) }]
        : [];
    });
    if (failedIdsOfResult(result).length > 0 || ids.some(id => !bodies.some(item => item.id === id))) {
      throw new Error('The Email connector could not fetch the message.');
    }
    return bodies;
  };
  return {
    trustedAuthenticationServers: [],
    datesAreArrival: false,
    async listNewMessages({ since, before, limit, from }) {
      // The sidecar picks and orders mail by the server's arrival time, which is what the window means. The Date a
      // sender wrote can be late or early, so it is never used to pick or order. A window is read in one call, so
      // mail deleted while it is read can never shift a page and hide a message.
      const size = Math.min(limit + 1, PAGE_SIZE);
      const listed: unknown[] = [];
      for (const address of from ?? [undefined]) {
        const result = await asked(MAIL_LIST_TOOL_NAME, {
          account_name: account,
          mailbox: 'INBOX',
          since: since.toISOString(),
          before: before.toISOString(),
          ...(address === undefined ? {} : { from_address: address }),
          page: 1,
          page_size: size,
          order: 'asc',
        }).catch((error: unknown) => {
          throw isCallTimeout(error) || saysTimedOut(error) ? new MailTooSlowError({ cause: error }) : error;
        });
        const emails = emailsOfResult(result);
        // A full list may have more behind it, so the window is too big to read in one call.
        if (emails.length >= size) {
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
      };
    },
    async readText(message) {
      return (await bodiesOf([message.id]))[0]?.body ?? '';
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
  async function mailFromSidecar(
    url: string,
  ): Promise<
    { status: 'ready'; source: MailSource } | { status: 'not_set_up' } | { status: 'unreachable'; error: unknown }
  > {
    try {
      const call = sidecarTools({ name: MAIL_CONNECTOR_NAME, url, logger, callMs: MAIL_CALL_MS });
      const [account] = accountNamesOfResult(await call(MAIL_ACCOUNT_LIST_TOOL_NAME, {}));
      return account === undefined
        ? { status: 'not_set_up' }
        : { status: 'ready', source: sidecarMailSource({ call, account }) };
    } catch (error) {
      logger.warn('The Email sidecar could not be reached for noticing', extractErrorLogFields(error));
      return { status: 'unreachable', error };
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
      const shared = own.mail !== undefined || mailUrl === undefined ? undefined : await mailFromSidecar(mailUrl);
      return {
        mail: own.mail ?? (shared?.status === 'ready' ? shared.source : undefined),
        mail_unreachable: shared?.status === 'unreachable' ? { error: shared.error } : undefined,
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

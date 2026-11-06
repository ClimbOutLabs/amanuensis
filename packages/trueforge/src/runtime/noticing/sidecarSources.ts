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

import type { NoticingOwner } from '../../db/noticingStore';
import type {
  CalendarEventInfo,
  CalendarSource,
  MailMessage,
  MailRef,
  MailSource,
  NoticingSourceProvider,
  NoticingSources,
} from './sources';

/** Calls one tool on a sidecar and returns its result as the MCP client gives it. */
export type CallSidecarTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Longest one watcher pass may keep a sidecar session open. */
const SIDECAR_SESSION_MS = 4 * 60_000;
const TEXT_CHARACTERS = 3000;
const PAGE_SIZE = 100;
const LATER_MESSAGES = 10;
const EVENTS_PER_PASS = 100;

/** A sidecar's tools through the same remote client a connector uses. Read tools only are ever called here. */
function sidecarTools({ name, url, logger }: { name: string; url: string; logger: Logger }): CallSidecarTool {
  const remote = new RemoteMCP({
    name,
    id: name,
    url,
    headers: {},
    logger,
    requestTimeoutMs: 30_000,
    connectTimeoutMs: 30_000,
    signal: AbortSignal.timeout(SIDECAR_SESSION_MS),
    refuseRedirects: true,
  });
  return async (tool, args) => {
    const response = await remote.callTool({ name: tool, arguments: args });
    if (!('result' in response)) {
      throw new Error(`The ${name} connector asked for sign-in.`);
    }
    return response.result;
  };
}

/** A subject with its reply and forward prefixes removed, so a reply finds the mail it answers. */
export function bareSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|aw|sv)\s*:\s*)+/i, '').trim();
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** `listed_by` stands in for a Date the sender left out or garbled, since the server listed the mail before it. */
function toMailMessage({ email, listed_by }: { email: unknown; listed_by: Date }): MailMessage | undefined {
  if (!isRecord(email)) {
    return undefined;
  }
  const id = text(email['email_id']);
  const sender = text(email['sender']);
  const written = new Date(text(email['date']) ?? '');
  const date = Number.isNaN(written.getTime()) ? listed_by : written;
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
  const bodiesOf = async (ids: readonly string[]): Promise<string[]> => {
    const result = await call(MAIL_CONTENT_TOOL_NAME, {
      account_name: account,
      email_ids: ids,
      mailbox: 'INBOX',
      mark_as_read: false,
    });
    return emailsOfResult(result).flatMap(email => {
      const body = isRecord(email) ? text(email['body']) : undefined;
      return body === undefined ? [] : [body.slice(0, TEXT_CHARACTERS)];
    });
  };
  return {
    trustedAuthenticationServers: [],
    async listNewMessages({ since, before, limit }) {
      // The sidecar picks and orders mail by the server's arrival time, which is what the window means. The Date a
      // sender wrote can be late or early, so it is never used to pick or order.
      const listed: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const result = await call(MAIL_LIST_TOOL_NAME, {
          account_name: account,
          mailbox: 'INBOX',
          since: since.toISOString(),
          before: before.toISOString(),
          page,
          page_size: PAGE_SIZE,
          order: 'asc',
        });
        const emails = emailsOfResult(result);
        listed.push(...emails);
        if (listed.length > limit) {
          return { read: 'too_many' };
        }
        if (emails.length < PAGE_SIZE) {
          break;
        }
      }
      return {
        read: 'all',
        messages: listed
          .map(email => toMailMessage({ email, listed_by: before }))
          .filter((message): message is MailMessage => message !== undefined),
      };
    },
    async readText(message) {
      return (await bodiesOf([message.id]))[0] ?? '';
    },
    async laterInThread(ref: MailRef) {
      if (ref.thread_id === null) {
        return [];
      }
      const result = await call(MAIL_LIST_TOOL_NAME, {
        account_name: account,
        mailbox: 'INBOX',
        subject: ref.thread_id,
        since: ref.received_at.toISOString(),
        page: 1,
        page_size: LATER_MESSAGES,
        order: 'asc',
      });
      const ids = emailsOfResult(result)
        .map(email => toMailMessage({ email, listed_by: ref.received_at }))
        .filter((message): message is MailMessage => message !== undefined && message.id !== ref.id)
        .map(message => message.id);
      return ids.length === 0 ? [] : bodiesOf(ids);
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
  instanceOwner: NoticingOwner | undefined;
  logger: Logger;
}): NoticingSourceProvider {
  async function mailFromSidecar(url: string): Promise<MailSource | undefined> {
    try {
      const call = sidecarTools({ name: MAIL_CONNECTOR_NAME, url, logger });
      const [account] = accountNamesOfResult(await call(MAIL_ACCOUNT_LIST_TOOL_NAME, {}));
      return account === undefined ? undefined : sidecarMailSource({ call, account });
    } catch (error) {
      logger.warn('The Email sidecar could not be reached for noticing', extractErrorLogFields(error));
      return undefined;
    }
  }
  return {
    async listOwners() {
      const listed = await primary.listOwners();
      return instanceOwner === undefined || (mailUrl === undefined && calendarUrl === undefined)
        ? listed
        : [...listed, instanceOwner];
    },
    async sourcesFor(owner: NoticingOwner): Promise<NoticingSources> {
      const own = await primary.sourcesFor(owner);
      if (owner.tenant_id !== instanceOwner?.tenant_id || owner.created_by !== instanceOwner.created_by) {
        return own;
      }
      return {
        mail: own.mail ?? (mailUrl === undefined ? undefined : await mailFromSidecar(mailUrl)),
        calendar:
          own.calendar ??
          (calendarUrl === undefined
            ? undefined
            : sidecarCalendarSource({ call: sidecarTools({ name: CALDAV_SERVER_NAME, url: calendarUrl, logger }) })),
      };
    },
  };
}

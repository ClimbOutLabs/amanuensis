import { CalendarApi, type CalendarApiPort } from '@truefoundry/trueforge-core/core/calendar/CalendarApi';
import {
  GmailApi,
  LIST_DEADLINE_MS,
  mapSkippingMissing,
  type GmailApiPort,
} from '@truefoundry/trueforge-core/core/email/gmail/gmailApi';
import type { GmailMessage } from '@truefoundry/trueforge-core/core/email/gmail/gmailWire';
import { deliveredMailboxOf } from '@truefoundry/trueforge-core/core/email/gmail/mailbox';
import { headerOf, rawHeaderOf, readBody } from '@truefoundry/trueforge-core/core/email/gmail/message';
import { GoogleAccessTokens } from '@truefoundry/trueforge-core/core/google/GoogleAccessTokens';
import { GoogleApiError } from '@truefoundry/trueforge-core/core/google/errors';
import { grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';
import type { Logger } from 'winston';
import { z } from 'zod';

import type { IGoogleConnectionStore } from '../../db/googleConnectionStore';
import type { PersonOwner } from '../../db/personOwner';
import {
  MessageUnreadableError,
  type CalendarEventInfo,
  type CalendarSource,
  type MailMessage,
  type MailRef,
  type MailSource,
  type NoticingSourceProvider,
} from './sources';

/** The server whose Authentication-Results Gmail writes into every message it receives. */
const GMAIL_AUTHENTICATION_SERVERS = ['mx.google.com'];
const TEXT_CHARACTERS = 3000;
const MESSAGE_IDS_PER_PAGE = 100;
const EVENTS_PER_PASS = 100;

/**
 * Runs one read of a message. A gone message (404), one Gmail refuses as asked (400) or one whose reply does not
 * parse can never be read, so it is marked as such; anything else, such as a rate limit or an outage, is thrown as is
 * so the pass stops and tries again later.
 */
async function readingMessage<T>({ message_id, read }: { message_id: string; read: () => Promise<T> }): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const aboutTheMessage =
      error instanceof GoogleApiError &&
      (error.status === 404 || error.status === 400 || error.cause instanceof z.ZodError);
    throw aboutTheMessage ? new MessageUnreadableError({ message_id, cause: error }) : error;
  }
}

function headerValues({ message, name }: { message: GmailMessage; name: string }): string[] {
  const wanted = name.toLowerCase();
  return (message.payload?.headers ?? [])
    .filter(header => header.name.toLowerCase() === wanted)
    .map(header => header.value.replace(/\r?\n[ \t]+/g, ' '));
}

/** Gmail's list is the person's inbox; mail they wrote or drafted is not news to them. */
function isIncoming(message: GmailMessage): boolean {
  const labels = message.labelIds ?? [];
  return labels.includes('INBOX') && !labels.includes('SENT') && !labels.includes('DRAFT');
}

function toMailMessage(message: GmailMessage): MailMessage | undefined {
  const payload = message.payload;
  const internal = Number(message.internalDate);
  if (payload === undefined || !Number.isFinite(internal)) {
    return undefined;
  }
  const from = deliveredMailboxOf(rawHeaderOf({ part: payload, name: 'From' }));
  if (from.address === '') {
    return undefined;
  }
  return {
    id: message.id,
    thread_id: message.threadId,
    from_address: from.address.toLowerCase(),
    from_name: from.name === '' ? null : from.name,
    subject: headerOf({ message, name: 'Subject', maxChars: 300 }),
    snippet: message.snippet ?? '',
    received_at: new Date(internal),
    authentication_results: headerValues({ message, name: 'Authentication-Results' }),
  };
}

/** Senders named in one Gmail search, so a long always-important list never makes one search too long to send. */
const SENDERS_PER_SEARCH = 25;

/**
 * The searches to run: one for the whole window, or one per group of senders. An address with a quote or a
 * backslash cannot be written into a search safely, so it is left out.
 */
function senderGroups(from: readonly string[] | undefined): (readonly string[] | undefined)[] {
  if (from === undefined) {
    return [undefined];
  }
  const safe = from.filter(address => !/["\\]/.test(address));
  const groups: string[][] = [];
  for (let at = 0; at < safe.length; at += SENDERS_PER_SEARCH) {
    groups.push(safe.slice(at, at + SENDERS_PER_SEARCH));
  }
  return groups;
}

/** Gmail as a mail source, read with the person's own Google login and read-only calls. */
export function gmailMailSource(
  api: Pick<GmailApiPort, 'listMessages' | 'getMessageHeaders' | 'getMessage' | 'getThread'>,
): MailSource {
  return {
    trustedAuthenticationServers: GMAIL_AUTHENTICATION_SERVERS,
    async listNewMessages({ since, before, limit, from }) {
      // Gmail's search takes whole seconds, so it is asked for a little more and the window is cut exactly here.
      const after = Math.floor(since.getTime() / 1000) - 1;
      const until = Math.ceil(before.getTime() / 1000) + 1;
      const window = `in:inbox after:${String(after)} before:${String(until)}`;
      const ids = new Set<string>();
      for (const senders of senderGroups(from)) {
        const query =
          senders === undefined ? window : `${window} {${senders.map(address => `from:"${address}"`).join(' ')}}`;
        let pageToken: string | undefined;
        do {
          const list = await api.listMessages({ query, maxResults: MESSAGE_IDS_PER_PAGE, pageToken });
          for (const id of list.messageIds) {
            ids.add(id);
          }
          pageToken = list.nextPageToken;
          if (ids.size > limit) {
            return { read: 'too_many' };
          }
        } while (pageToken !== undefined);
      }
      // Gmail lists the newest first. Reading the oldest first means a read of the whole window that runs out of
      // time has every message up to where it stopped.
      const { results, notReached } = await mapSkippingMissing({
        items: [...ids].reverse(),
        work: id => api.getMessageHeaders(id),
        deadlineMs: LIST_DEADLINE_MS,
      });
      const messages = results
        .filter(isIncoming)
        .map(toMailMessage)
        .filter(
          (message): message is MailMessage =>
            message !== undefined &&
            message.received_at.getTime() >= since.getTime() &&
            message.received_at.getTime() < before.getTime(),
        )
        .sort((a, b) => a.received_at.getTime() - b.received_at.getTime());
      return notReached > 0 ? { read: 'oldest', messages } : { read: 'all', messages };
    },
    async readText(message) {
      const full = await readingMessage({ message_id: message.id, read: () => api.getMessage(message.id) });
      return readBody({ message: full, maxChars: TEXT_CHARACTERS }).body;
    },
    async laterInThread(ref: MailRef) {
      if (ref.thread_id === null) {
        return [];
      }
      const threadId = ref.thread_id;
      const thread = await readingMessage({
        message_id: ref.id,
        read: () => api.getThread({ threadId, format: 'full' }),
      });
      return (thread.messages ?? [])
        .filter(message => Number(message.internalDate) > ref.received_at.getTime())
        .map(message => readBody({ message, maxChars: TEXT_CHARACTERS }).body);
    },
  };
}

/** Google Calendar as a calendar source: the primary calendar's timed events that are still on. */
export function googleCalendarSource({
  api,
  timeZone,
}: {
  api: Pick<CalendarApiPort, 'listEvents'>;
  timeZone: string;
}): CalendarSource {
  return {
    async listEvents({ from, to }) {
      const page = await api.listEvents({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        query: undefined,
        maxResults: EVENTS_PER_PASS,
        pageToken: undefined,
        timeZone,
      });
      const events: CalendarEventInfo[] = [];
      for (const event of page.events) {
        const start = event.start?.dateTime;
        const end = event.end?.dateTime;
        const attendees = event.attendees ?? [];
        const answer = attendees.find(guest => guest.self === true)?.responseStatus;
        const declined = answer === 'declined';
        if (event.status === 'cancelled' || declined || start === undefined || end === undefined) {
          continue;
        }
        events.push({
          id: event.id,
          title: event.summary ?? 'An event',
          start: new Date(start),
          end: new Date(end),
          location: event.location ?? null,
          // An invite from outside can name the person as its organizer and mark them accepted, so an event that
          // names them as organizer counts only when they made it, or someone they share with made it with no one
          // else on it. Otherwise their own accept counts, or an event with no organizer and no guests.
          own:
            event.organizer?.self === true
              ? event.creator?.self === true || (event.creator !== undefined && attendees.length === 0)
              : answer === 'accepted' || (event.organizer === undefined && attendees.length === 0),
        });
      }
      return events;
    },
  };
}

/** The time zone a person's own Google Calendar is kept in, when they connected it. */
export function googleCalendarTimezoneFor({
  connections,
  fetchImpl,
}: {
  connections: IGoogleConnectionStore;
  fetchImpl: typeof fetch | undefined;
}): (owner: PersonOwner) => Promise<string | undefined> {
  return async owner => {
    const record = await connections.get(owner);
    if (record?.status !== 'connected' || !grantedFeatures(record.granted_scopes).includes('calendar_read')) {
      return undefined;
    }
    const tokens = new GoogleAccessTokens({ now: undefined, connections, owner, fetchImpl });
    return (await new CalendarApi({ sleep: undefined, tokens, fetchImpl }).calendarTimeZone()) ?? undefined;
  };
}

/** The people with a working Google login, and their mail and calendar as far as they allowed. */
export function createGoogleNoticingSources({
  connections,
  fetchImpl,
  logger,
}: {
  connections: IGoogleConnectionStore;
  fetchImpl: typeof fetch | undefined;
  logger: Logger;
}): NoticingSourceProvider {
  return {
    async listOwners() {
      return await connections.listConnectedOwners();
    },
    async sourcesFor(owner: PersonOwner) {
      const record = await connections.get(owner);
      if (record?.status !== 'connected') {
        return { mail: undefined, calendar: undefined };
      }
      const features = grantedFeatures(record.granted_scopes);
      const tokens = new GoogleAccessTokens({ now: undefined, connections, owner, fetchImpl });
      const calendarApi = features.includes('calendar_read')
        ? new CalendarApi({ sleep: undefined, tokens, fetchImpl })
        : undefined;
      const timeZone =
        calendarApi === undefined ? 'UTC' : ((await calendarApi.calendarTimeZone().catch(() => null)) ?? 'UTC');
      logger.debug('Opened Google for a noticing pass', {
        has_mail: features.includes('gmail_read'),
        has_calendar: calendarApi !== undefined,
      });
      return {
        mail: features.includes('gmail_read')
          ? gmailMailSource(new GmailApi({ sleep: undefined, tokens, fetchImpl }))
          : undefined,
        calendar: calendarApi === undefined ? undefined : googleCalendarSource({ api: calendarApi, timeZone }),
      };
    },
  };
}

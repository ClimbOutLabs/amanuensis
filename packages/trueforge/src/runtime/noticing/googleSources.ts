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
import { grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';
import type { Logger } from 'winston';

import type { IGoogleConnectionStore } from '../../db/googleConnectionStore';
import type { NoticingOwner } from '../../db/noticingStore';
import type {
  CalendarEventInfo,
  CalendarSource,
  MailMessage,
  MailRef,
  MailSource,
  NoticingSourceProvider,
} from './sources';

/** The server whose Authentication-Results Gmail writes into every message it receives. */
const GMAIL_AUTHENTICATION_SERVERS = ['mx.google.com'];
const TEXT_CHARACTERS = 3000;
const THREADS_PER_PASS = 50;
const THREAD_IDS_PER_PAGE = 100;
/** Most thread ids one pass lists. A pass reads back a day at most, so this is rarely reached. */
const MAX_THREAD_IDS = 500;
const EVENTS_PER_PASS = 100;

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

function toMailMessage(message: GmailMessage, thread_id: string): MailMessage | undefined {
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
    thread_id,
    from_address: from.address.toLowerCase(),
    from_name: from.name === '' ? null : from.name,
    subject: headerOf({ message, name: 'Subject', maxChars: 300 }),
    snippet: message.snippet ?? '',
    received_at: new Date(internal),
    authentication_results: headerValues({ message, name: 'Authentication-Results' }),
  };
}

/** Gmail as a mail source, read with the person's own Google login and read-only calls. */
export function gmailMailSource(api: Pick<GmailApiPort, 'listThreads' | 'getThread' | 'getMessage'>): MailSource {
  return {
    trustedAuthenticationServers: GMAIL_AUTHENTICATION_SERVERS,
    async listNewMessages({ since, limit }) {
      const query = `in:inbox after:${String(Math.floor(since.getTime() / 1000))}`;
      const threadIds: string[] = [];
      let pageToken: string | undefined;
      do {
        const list = await api.listThreads({ query, maxResults: THREAD_IDS_PER_PAGE, pageToken });
        threadIds.push(...list.threadIds);
        pageToken = list.nextPageToken;
      } while (pageToken !== undefined && threadIds.length < MAX_THREAD_IDS);
      // Gmail lists the newest threads first. The oldest are read first, so a pass that cannot read everything
      // leaves only newer mail for the next one.
      const oldest = threadIds.slice(-THREADS_PER_PASS);
      const { results } = await mapSkippingMissing({
        items: oldest,
        work: threadId => api.getThread({ threadId, format: 'metadata' }),
        deadlineMs: LIST_DEADLINE_MS,
      });
      const messages = results
        .flatMap(thread => (thread.messages ?? []).filter(isIncoming).map(message => toMailMessage(message, thread.id)))
        .filter(
          (message): message is MailMessage =>
            message !== undefined && message.received_at.getTime() >= since.getTime(),
        )
        .sort((a, b) => a.received_at.getTime() - b.received_at.getTime());
      return {
        messages: messages.slice(0, limit),
        truncated: pageToken !== undefined || threadIds.length > oldest.length || messages.length > limit,
      };
    },
    async readText(message) {
      return readBody({ message: await api.getMessage(message.id), maxChars: TEXT_CHARACTERS }).body;
    },
    async laterInThread(ref: MailRef) {
      if (ref.thread_id === null) {
        return [];
      }
      const thread = await api.getThread({ threadId: ref.thread_id, format: 'full' });
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
          own:
            event.organizer?.self === true ||
            answer === 'accepted' ||
            (event.organizer === undefined && attendees.length === 0),
        });
      }
      return events;
    },
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
    async sourcesFor(owner: NoticingOwner) {
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

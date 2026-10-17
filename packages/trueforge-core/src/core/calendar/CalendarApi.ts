/** Google Calendar's REST API (v3), called directly with the user's own login. Reads only. */
import type { GoogleAccessTokens } from '../google/GoogleAccessTokens';
import { GoogleRestClient, type GoogleRestProduct } from '../google/restClient';
import { CalendarEventSchema, CalendarZoneSchema, EventListSchema, type CalendarEvent } from './calendarWire';

const CALENDAR: GoogleRestProduct = {
  name: 'Google Calendar',
  baseUrl: 'https://www.googleapis.com/calendar/v3/calendars/primary',
  apiOffMessage:
    "The Google Calendar API isn't turned on in your Google project. Open Settings, Connectors, Google, follow step 2 for Calendar, then try again.",
  scopeMessage:
    "Google hasn't given Aman permission to read your calendar. Open Settings, Connectors, Google and connect Calendar.",
  notFoundMessage: 'Google Calendar has no such event.',
  tooLargeMessage: 'Google Calendar sent back more than Aman will read at once. Ask for a shorter range.',
};

interface EventPage {
  events: CalendarEvent[];
  nextPageToken: string | undefined;
}

export class CalendarApi {
  readonly #rest: GoogleRestClient;

  constructor(input: {
    tokens: GoogleAccessTokens;
    fetchImpl: typeof fetch | undefined;
    /** Replaceable so tests do not wait. */
    sleep: ((ms: number) => Promise<void>) | undefined;
  }) {
    this.#rest = new GoogleRestClient({
      product: CALENDAR,
      tokens: input.tokens,
      fetchImpl: input.fetchImpl,
      sleep: input.sleep,
    });
  }

  /**
   * Events in the range, with repeating events already unfolded into the occurrences that fall inside it.
   * Times come back in `timeZone`; all-day events come back as plain dates.
   */
  async listEvents(input: {
    timeMin: string;
    timeMax: string;
    query: string | undefined;
    maxResults: number;
    pageToken: string | undefined;
    timeZone: string;
  }): Promise<EventPage> {
    const list = await this.#rest.parsed(EventListSchema, {
      body: undefined,
      method: 'GET',
      path: '/events',
      query: {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        q: input.query,
        maxResults: input.maxResults,
        pageToken: input.pageToken,
        timeZone: input.timeZone,
        singleEvents: true,
        orderBy: 'startTime',
      },
    });
    return { events: list.items ?? [], nextPageToken: list.nextPageToken };
  }

  async getEvent(input: { eventId: string; timeZone: string }): Promise<CalendarEvent> {
    return await this.#rest.parsed(CalendarEventSchema, {
      body: undefined,
      query: { timeZone: input.timeZone },
      method: 'GET',
      path: `/events/${encodeURIComponent(input.eventId)}`,
    });
  }

  /** The calendar's own time zone, for a user whose device did not say which one theirs is. Null when Google names none. */
  async calendarTimeZone(): Promise<string | null> {
    const page = await this.#rest.parsed(CalendarZoneSchema, {
      body: undefined,
      method: 'GET',
      path: '/events',
      query: { maxResults: 1, timeMin: new Date().toISOString(), fields: 'timeZone' },
    });
    return page.timeZone ?? null;
  }
}

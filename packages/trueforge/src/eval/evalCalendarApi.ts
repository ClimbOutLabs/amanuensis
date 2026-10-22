/**
 * The Calendar calls answered from the eval calendar fixture. Events a run creates or changes live in
 * memory only; nothing is written to a calendar and no network call is made.
 */
import type { CalendarApiPort } from '@truefoundry/trueforge-core/core/calendar/CalendarApi';
import type { CalendarEvent } from '@truefoundry/trueforge-core/core/calendar/calendarWire';
import type { EventTimeWrite, EventWriteRequest } from '@truefoundry/trueforge-core/core/calendar/eventWrite';

import { EvalFixtureError } from './evalFixtureError';
import type { CalendarFixture } from './fixtures';

function noSuchEvent(): EvalFixtureError {
  return new EvalFixtureError('Google Calendar has no such event.');
}

/** Naive local times in the fixture are read as UTC so the comparison does not depend on the server's zone. */
function toInstant(value: string): number {
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  return Date.parse(hasOffset ? value : `${value}Z`);
}

function eventTime(time: EventTimeWrite | undefined): CalendarEvent['start'] {
  if (time === undefined) {
    return undefined;
  }
  return {
    ...(time.date === null ? {} : { date: time.date }),
    ...(time.dateTime === null ? {} : { dateTime: time.dateTime }),
    ...(time.timeZone === null ? {} : { timeZone: time.timeZone }),
  };
}

export class EvalCalendarApi implements CalendarApiPort {
  readonly #timeZone: string;
  readonly #events = new Map<string, CalendarEvent>();
  #counter = 0;

  constructor(input: { calendar: CalendarFixture }) {
    this.#timeZone = input.calendar.time_zone;
    for (const event of input.calendar.events) {
      this.#events.set(event.id, {
        id: event.id,
        etag: `"etag-${event.id}"`,
        status: 'confirmed',
        summary: event.title,
        location: event.location,
        start: { dateTime: event.start, timeZone: event.time_zone },
        end: { dateTime: event.end, timeZone: event.time_zone },
        attendees: event.attendees.map(email => ({ email })),
      });
    }
  }

  insertEvent(request: EventWriteRequest): Promise<CalendarEvent> {
    this.#counter += 1;
    const id = `event-eval-${String(this.#counter)}`;
    const event: CalendarEvent = {
      id,
      etag: `"etag-${id}"`,
      status: 'confirmed',
      summary: request.body.summary,
      location: request.body.location,
      description: request.body.description,
      start: eventTime(request.body.start),
      end: eventTime(request.body.end),
      attendees: request.body.attendees,
    };
    this.#events.set(id, event);
    return Promise.resolve(event);
  }

  patchEvent(request: EventWriteRequest & { event_id: string }): Promise<CalendarEvent> {
    const existing = this.#events.get(request.event_id);
    if (existing === undefined) {
      return Promise.reject(noSuchEvent());
    }
    const { body } = request;
    const updated: CalendarEvent = {
      ...existing,
      etag: `"etag-${existing.id}-${String(this.#counter)}"`,
      summary: body.summary ?? existing.summary,
      location: body.location ?? existing.location,
      description: body.description ?? existing.description,
      start: body.start === undefined ? existing.start : eventTime(body.start),
      end: body.end === undefined ? existing.end : eventTime(body.end),
      attendees: body.attendees ?? existing.attendees,
    };
    this.#events.set(updated.id, updated);
    return Promise.resolve(updated);
  }

  /** Events whose time overlaps the range, earliest first. Recurrence is not modelled in the fixture. */
  listEvents(input: {
    timeMin: string;
    timeMax: string;
    query: string | undefined;
    maxResults: number;
    pageToken: string | undefined;
    timeZone: string;
  }) {
    const from = toInstant(input.timeMin);
    const to = toInstant(input.timeMax);
    const needle = input.query?.trim().toLowerCase() ?? '';
    const matches = [...this.#events.values()]
      .filter(event => {
        const start = toInstant(event.start?.dateTime ?? event.start?.date ?? '');
        const end = toInstant(event.end?.dateTime ?? event.end?.date ?? '');
        const overlaps = start < to && end > from;
        return overlaps && (needle === '' || JSON.stringify(event).toLowerCase().includes(needle));
      })
      .sort((left, right) => toInstant(left.start?.dateTime ?? '') - toInstant(right.start?.dateTime ?? ''));
    return Promise.resolve({ events: matches.slice(0, input.maxResults), nextPageToken: undefined });
  }

  getEvent(input: { eventId: string; timeZone: string }): Promise<CalendarEvent> {
    const event = this.#events.get(input.eventId);
    return event === undefined ? Promise.reject(noSuchEvent()) : Promise.resolve(event);
  }

  calendarTimeZone(): Promise<string | null> {
    return Promise.resolve(this.#timeZone);
  }
}

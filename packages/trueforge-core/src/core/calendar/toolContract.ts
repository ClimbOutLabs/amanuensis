/**
 * Canonical owner of the Google Calendar tool contract: names, parameter schemas and annotations. Writes add or
 * change one event and always ask; there is no delete.
 */
import { z } from 'zod';
import { visible } from '../email/gmail/toolContract';
import { isRealDate } from '../util/calendarDay';
import { isValidTimezone } from '../util/clientTimezone';

export const CALENDAR_SERVER_ID = 'google_calendar';

export const LIST_EVENTS_TOOL_NAME = 'list_events';
export const GET_EVENT_TOOL_NAME = 'get_event';

export const CREATE_EVENT_TOOL_NAME = 'create_event';
export const UPDATE_EVENT_TOOL_NAME = 'update_event';

export const CALENDAR_READ_TOOL_NAMES = [LIST_EVENTS_TOOL_NAME, GET_EVENT_TOOL_NAME] as const;
const CALENDAR_WRITE_TOOL_NAMES = [CREATE_EVENT_TOOL_NAME, UPDATE_EVENT_TOOL_NAME] as const;

export function isCalendarReadToolName(tool_name: string): boolean {
  return CALENDAR_READ_TOOL_NAMES.some(name => name === tool_name);
}

export function isCalendarWriteToolName(tool_name: string): boolean {
  return CALENDAR_WRITE_TOOL_NAMES.some(name => name === tool_name);
}

const MAX_RESULTS_CAP = 100;
const DEFAULT_MAX_RESULTS = 25;

/** Longest span one list may cover; a wider question is asked in pieces. */
export const MAX_RANGE_DAYS = 400;

/** A day (`2026-10-19`) read in the user's time zone, or an exact moment with its offset (`2026-10-19T09:00:00-03:00`). */
const Moment = z.union([
  z.string().refine(isRealDate, { message: 'Use a real date like 2026-10-19' }),
  z.iso.datetime({ offset: true }),
]);

export const ListEventsSchema = z
  .object({
    time_min: Moment.describe('Start of the range. A date starts that day.'),
    time_max: Moment.describe('End of the range. A date includes that whole day.'),
    query: z.string().max(256).optional().describe('Words to look for in the title, description, location or guests.'),
    max_results: z.number().int().min(1).max(MAX_RESULTS_CAP).default(DEFAULT_MAX_RESULTS),
    page_token: z.string().max(512).optional(),
  })
  .strict();

const EventId = z.string().min(1).max(256);

export const GetEventSchema = z.object({ event_id: EventId }).strict();

/** A wall-clock time with no offset, read in the event's time zone. */
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/** A day (`2026-10-19`) for an all-day event, or a local time (`2026-10-19T09:00`) for a timed one. */
const EventMoment = z.union([
  z.string().refine(isRealDate, { message: 'Use a real date like 2026-10-19' }),
  z.string().refine(text => isRealDate(LOCAL_TIME.exec(text)?.[1] ?? ''), {
    message: 'Use a local time like 2026-10-19T09:00, with no offset',
  }),
]);

/** The date and the hour and minute of a local time; undefined for a plain date. */
export function parseLocalTime(text: string): { date: string; hour: number; minute: number } | undefined {
  const match = LOCAL_TIME.exec(text);
  return match === null ? undefined : { date: match[1] ?? '', hour: Number(match[2]), minute: Number(match[3]) };
}

const TimeZone = z.string().max(64).refine(isValidTimezone, { message: 'Use a real time zone like America/New_York' });

const MAX_ATTENDEES = 50;

/** Who Google emails about the change: every guest, or no one. Never left to Google's default. */
const SendUpdates = z.enum(['all', 'none']);

const EventFieldsShape = {
  title: visible(z.string().trim().min(1).max(300)),
  time_zone: TimeZone.optional().describe("IANA zone the times are in. Leave out to use the user's own."),
  location: visible(z.string().max(500)).optional(),
  description: visible(z.string().max(8000)).optional(),
};

export const CreateEventSchema = z
  .object({
    ...EventFieldsShape,
    start: EventMoment.describe('A date for an all-day event, or a local time like 2026-10-19T09:00.'),
    end: EventMoment.describe("An all-day event's last day, or the local time it ends."),
    attendees: z.array(visible(z.email())).max(MAX_ATTENDEES).optional(),
    send_updates: SendUpdates.optional().describe(
      'Required with attendees: "all" has Google email them the invite now, "none" adds them without an email.',
    ),
  })
  .strict()
  .refine(input => (input.attendees ?? []).length === 0 || input.send_updates !== undefined, {
    message: 'Adding guests makes Google email them. Set send_updates to "all" or "none".',
  });

export const UpdateEventSchema = z
  .object({
    event_id: EventId,
    title: EventFieldsShape.title.optional(),
    time_zone: EventFieldsShape.time_zone,
    location: EventFieldsShape.location,
    description: EventFieldsShape.description,
    start: EventMoment.optional().describe('New start. Leave out end to keep the length.'),
    end: EventMoment.optional(),
    send_updates: SendUpdates.optional().describe(
      'Required when the event has guests: "all" emails them the change, "none" does not.',
    ),
  })
  .strict()
  .refine(
    input =>
      input.title !== undefined ||
      input.start !== undefined ||
      input.end !== undefined ||
      input.location !== undefined ||
      input.description !== undefined,
    { message: 'Say what to change: title, start, end, location or description.' },
  );

export type CreateEventInput = z.infer<typeof CreateEventSchema>;
export type UpdateEventInput = z.infer<typeof UpdateEventSchema>;

/** Event text is attacker-controlled (an invite can be sent by anyone), so every read is open-world. */
export const CALENDAR_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;
export const CALENDAR_WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

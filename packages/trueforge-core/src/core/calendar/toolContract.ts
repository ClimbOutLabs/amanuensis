/**
 * Canonical owner of the Google Calendar tool contract: names, parameter schemas and annotations. Read-only by
 * design: there is no write tool, so a scheduled run and a chat hold the same tools.
 */
import { z } from 'zod';

export const CALENDAR_SERVER_ID = 'google_calendar';

export const LIST_EVENTS_TOOL_NAME = 'list_events';
export const GET_EVENT_TOOL_NAME = 'get_event';

export const CALENDAR_READ_TOOL_NAMES = [LIST_EVENTS_TOOL_NAME, GET_EVENT_TOOL_NAME] as const;

export function isCalendarReadToolName(tool_name: string): boolean {
  return CALENDAR_READ_TOOL_NAMES.some(name => name === tool_name);
}

const MAX_RESULTS_CAP = 100;
const DEFAULT_MAX_RESULTS = 25;

/** Longest span one list may cover; a wider question is asked in pieces. */
export const MAX_RANGE_DAYS = 400;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether the text is a real calendar day, so 2026-02-30 is refused instead of rolling into March. */
export function isRealDate(text: string): boolean {
  const match = DATE_ONLY.exec(text);
  if (match === null) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

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

export const GetEventSchema = z.object({ event_id: z.string().min(1).max(256) }).strict();

/** Event text is attacker-controlled (an invite can be sent by anyone), so every read is open-world. */
export const CALENDAR_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;

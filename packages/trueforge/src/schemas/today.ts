import { z } from '@hono/zod-openapi';

/**
 * One calendar event on the person's day, from whichever calendar account it came from.
 * Times are ISO 8601; an all-day event's `start_at` and `end_at` are plain dates.
 */
export const TodayCalendarEventSchema = z
  .object({
    day: z
      .enum(['today', 'tomorrow'])
      .describe("Which day the event falls on: the person's local day, or the next morning's first event."),
    start_at: z.string().describe('When the event starts: an ISO 8601 instant, or a plain date for an all-day event.'),
    end_at: z
      .string()
      .nullable()
      .describe('When the event ends, in the same form as `start_at`; null when the source gives no end.'),
    title: z.string().describe('The event title as the calendar holds it.'),
    location: z.string().nullable().describe('Where the event happens, or null when the event names no place.'),
    all_day: z.boolean().describe('True when the event runs all day rather than at a set time.'),
    source: z.enum(['google', 'caldav']).describe('Which kind of calendar account the event came from.'),
    calendar_account_id: z.string().describe('The account the event came from: its sign-in address.'),
  })
  .openapi('TodayCalendarEvent');

/** One reminder whose time has come: due today or overdue, still waiting to be seen to. */
export const TodayDueReminderSchema = z
  .object({
    reminder_id: z.string().describe('The reminder schedule id.'),
    title: z.string().describe('What the reminder says.'),
    due_at: z.string().describe('When the reminder was due, as an ISO 8601 instant.'),
    session_id: z
      .string()
      .nullable()
      .describe('The Reminders chat the reminder lands in, or null when that chat does not exist yet.'),
  })
  .openapi('TodayDueReminder');

/** One action waiting for the person's OK: held by a run, or an approval a chat is paused on. */
export const TodayNeedsOkItemSchema = z
  .object({
    held_action_id: z.string().describe('The waiting tool call id.'),
    title: z.string().describe('What the action would do, in the plain words of its card.'),
    origin: z.string().describe('Where the action came from: the chat title, or the schedule name for a run.'),
    session_id: z.string().describe('The chat that holds the action, where it is answered.'),
  })
  .openapi('TodayNeedsOkItem');

/** The right rail's Home view: the day read from stored state, never from a model turn. */
export const TodaySchema = z
  .object({
    calendar: z
      .array(TodayCalendarEventSchema)
      .nullable()
      .describe(
        "The local day's events from every connected calendar account. Once every timed event on the " +
          "day has finished, the next morning's first event is added, marked as tomorrow's. Null, not " +
          'an empty list, when no calendar is connected.',
      ),
    free_after: z
      .string()
      .nullable()
      .describe('The first time after now with no event until the end of the day, or null when the day stays busy.'),
    due: z.array(TodayDueReminderSchema).describe('Reminders due today or overdue, earliest first.'),
    needs_ok: z.array(TodayNeedsOkItemSchema).describe('Actions waiting for the person, oldest first.'),
    needs_ok_more: z
      .boolean()
      .describe(
        'True when more actions are waiting than the list shows: the scan has caps, and it says so when one cuts.',
      ),
    carrying: z.number().int().nonnegative().describe('How many schedules are switched on for the person.'),
    as_of: z.string().describe('The server time this view was read at, as an ISO 8601 instant.'),
  })
  .openapi('Today');

export const GetTodayRequestQuerySchema = z
  .object({
    client_timezone: z
      .string()
      .optional()
      .describe("The person's IANA time zone, which sets the local day. Read as UTC when absent or unknown."),
  })
  .openapi('GetTodayRequestQuery');

export const GetTodayResponseSchema = z.object({ data: TodaySchema }).openapi('GetTodayResponse');

export type TodayCalendarEvent = z.infer<typeof TodayCalendarEventSchema>;
export type TodayDueReminder = z.infer<typeof TodayDueReminderSchema>;
export type TodayNeedsOkItem = z.infer<typeof TodayNeedsOkItemSchema>;
export type Today = z.infer<typeof TodaySchema>;
export type GetTodayRequestQuery = z.infer<typeof GetTodayRequestQuerySchema>;

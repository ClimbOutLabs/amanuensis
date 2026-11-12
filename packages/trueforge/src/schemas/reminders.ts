import { z } from '@hono/zod-openapi';

/** Wire ISO-8601 instant on a response. Always UTC with milliseconds, like every other timestamp the server emits. */
const IsoTimestamp = z.iso.datetime().openapi({ type: 'string', format: 'date-time' });

const NullableIsoTimestamp = z.iso
  .datetime()
  .nullable()
  .openapi({ type: ['string', 'null'], format: 'date-time' });

/**
 * Where a reminder stands. `upcoming`: still to come. `paused`: set but held, so it will not fire.
 * `reminded`: its time came and it was delivered. `missed`: its time came and it did not go through.
 */
export const ReminderStateSchema = z.enum(['upcoming', 'paused', 'reminded', 'missed']).openapi('ReminderState');

/** One reminder the signed-in person set, with everything the reminders view shows about it. */
export const ReminderItemSchema = z
  .object({
    id: z.string(),
    what: z.string().describe('What the reminder is for, in the words it was set with.'),
    timezone: z.string().describe('The IANA time zone the reminder times are read in.'),
    repeats: z.boolean().describe('True when the reminder runs again on a repeating timing.'),
    timing: z.string().describe('When it runs, in plain words.'),
    state: ReminderStateSchema,
    next_due_at: NullableIsoTimestamp.describe('When it is next due, or null when nothing is queued.'),
    last_reminded_at: NullableIsoTimestamp.describe('When it last reached the person, or null if it never has.'),
    last_due_at: NullableIsoTimestamp.describe('When its latest past time was due, or null if none has passed.'),
    set_at: IsoTimestamp.describe('When the reminder was set.'),
    persona_name: z.string().describe('The persona the reminder was set with.'),
    session_id: z
      .string()
      .nullable()
      .describe('The chat the reminder was set in, or null when it was set elsewhere or that chat is gone.'),
  })
  .strict()
  .openapi('ReminderItem');

export const RemindersPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50).describe('Most schedules to read for this page.'),
    page_token: z.string().optional().describe('Token from the previous page; omit for the first page.'),
  })
  .openapi('ListRemindersRequestQuery');

export const ListRemindersResponseSchema = z
  .object({
    data: z.array(ReminderItemSchema),
    next_page_token: z
      .string()
      .optional()
      .describe('Pass as page_token to get more reminders; absent on the last page.'),
  })
  .strict()
  .openapi('ListRemindersResponse');

export type ReminderState = z.infer<typeof ReminderStateSchema>;
export type ReminderItem = z.infer<typeof ReminderItemSchema>;

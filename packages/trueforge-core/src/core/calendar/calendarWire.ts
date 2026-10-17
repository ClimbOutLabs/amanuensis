/** The parts of Google Calendar's REST responses Aman reads. Fields Google may leave out are optional. */
import { z } from 'zod';

const EventTimeSchema = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});
export type EventTime = z.infer<typeof EventTimeSchema>;

const AttendeeSchema = z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
  responseStatus: z.string().optional(),
  self: z.boolean().optional(),
  organizer: z.boolean().optional(),
  optional: z.boolean().optional(),
});

export const CalendarEventSchema = z.object({
  id: z.string(),
  /** Changes whenever the event does, so a change can be bound to the version that was shown. */
  etag: z.string().optional(),
  status: z.string().optional(),
  eventType: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: EventTimeSchema.optional(),
  end: EventTimeSchema.optional(),
  recurringEventId: z.string().optional(),
  recurrence: z.array(z.string()).optional(),
  organizer: z
    .object({ email: z.string().optional(), displayName: z.string().optional(), self: z.boolean().optional() })
    .optional(),
  attendees: z.array(AttendeeSchema).optional(),
  attendeesOmitted: z.boolean().optional(),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const EventListSchema = z.object({
  items: z.array(CalendarEventSchema).optional(),
  nextPageToken: z.string().optional(),
  timeZone: z.string().optional(),
});

export const CalendarZoneSchema = z.object({ timeZone: z.string().optional() });

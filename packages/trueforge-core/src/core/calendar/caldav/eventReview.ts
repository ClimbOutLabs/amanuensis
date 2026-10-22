import { z } from 'zod';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** What a person needs to recognize an event on a card: its title and when it starts. */
export interface CaldavEventReview {
  id: string;
  title: string | null;
  when: string | null;
  /** Who organizes the event, by name or address; null when neither can be read. */
  organizer: string | null;
  /** Who is invited, by name or address, in the order the event lists them. Null when the list cannot be read. */
  attendees: string[] | null;
}

const GuestSchema = z.looseObject({
  name: z.string().optional(),
  email: z.string().optional(),
});

const TimeValueSchema = z.object({
  value: z.string(),
  tzid: z.string().optional(),
  all_day: z.boolean(),
});

export type CaldavTimeValue = z.infer<typeof TimeValueSchema>;

/** Only the fields the card shows. Everything else in a get_event answer is ignored. */
const GetEventResultSchema = z.object({
  event: z.looseObject({
    summary: z.string().optional(),
    start: TimeValueSchema.optional(),
    organizer: GuestSchema.optional(),
    attendees: z.array(GuestSchema).optional(),
    recurring: z.boolean().optional(),
  }),
});

const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Reads a time as a person would say it, from the digits the server sent. The offset is not
 * converted, so the time shown is the time the event was written in.
 */
export function formatCaldavWhen(start: CaldavTimeValue): string | null {
  const dateTime = ISO_DATE_TIME.exec(start.value);
  const bareDate = BARE_DATE.exec(start.value);
  const parts = dateTime ?? bareDate;
  if (parts === null) {
    return null;
  }
  const [, year, month, day] = parts;
  const monthIndex = Number(month) - 1;
  const monthName = MONTHS[monthIndex];
  if (monthName === undefined) {
    return null;
  }
  const date = `${String(Number(day))} ${monthName} ${String(year)}`;
  if (start.all_day || dateTime === null) {
    return `${date}, all day`;
  }
  const time = `${String(dateTime[4])}:${String(dateTime[5])}`;
  return start.tzid === undefined ? `${date}, ${time}` : `${date}, ${time} (${start.tzid})`;
}

/**
 * The title and time of one event, from a get_event answer. A missing or unreadable title or
 * time becomes null, so the card can say so instead of guessing.
 */
export function caldavEventReviewFrom({ id, result }: { id: string; result: unknown }): CaldavEventReview {
  const parsed = GetEventResultSchema.safeParse(result);
  if (!parsed.success) {
    return { id, title: null, when: null, organizer: null, attendees: null };
  }
  const { summary, start, organizer, attendees, recurring } = parsed.data.event;
  const title = summary === undefined || summary.trim() === '' ? null : summary;
  return {
    id,
    title,
    when: start === undefined ? null : formatCaldavWhen(start),
    organizer: organizerName(organizer),
    attendees: guestListOf({ attendees, recurring }),
  };
}

/**
 * A parsed event with no ATTENDEE lines has no guests. A repeating series keeps its guest list unknown,
 * because one date in it may have guests that the series answer does not list.
 */
function guestListOf({
  attendees,
  recurring,
}: {
  attendees: z.infer<typeof GuestSchema>[] | undefined;
  recurring: boolean | undefined;
}): string[] | null {
  if (attendees !== undefined) {
    return attendees.map(guestName);
  }
  return recurring === true ? null : [];
}

function organizerName(guest: z.infer<typeof GuestSchema> | undefined): string | null {
  return guest === undefined ? null : readableGuest(guest);
}

/** Shown for an invited entry with no readable name or address, so it is still counted. */
const UNNAMED_GUEST = 'a guest with no name or address';

function guestName(guest: z.infer<typeof GuestSchema>): string {
  return readableGuest(guest) ?? UNNAMED_GUEST;
}

function readableGuest(guest: z.infer<typeof GuestSchema>): string | null {
  const name = [guest.name, guest.email].find(text => text !== undefined && text.trim() !== '');
  return name ?? null;
}

import { z } from 'zod';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** What a person needs to recognize an event on a card: its title and when it starts. */
export interface CaldavEventReview {
  id: string;
  title: string | null;
  when: string | null;
}

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
  const date = `${Number(day)} ${monthName} ${year}`;
  if (start.all_day || dateTime === null) {
    return `${date}, all day`;
  }
  const time = `${dateTime[4]}:${dateTime[5]}`;
  return start.tzid === undefined ? `${date}, ${time}` : `${date}, ${time} (${start.tzid})`;
}

/**
 * The title and time of one event, from a get_event answer. A missing or unreadable title or
 * time becomes null, so the card can say so instead of guessing.
 */
export function caldavEventReviewFrom({ id, result }: { id: string; result: unknown }): CaldavEventReview {
  const parsed = GetEventResultSchema.safeParse(result);
  if (!parsed.success) {
    return { id, title: null, when: null };
  }
  const { summary, start } = parsed.data.event;
  const title = summary === undefined || summary.trim() === '' ? null : summary;
  return { id, title, when: start === undefined ? null : formatCaldavWhen(start) };
}

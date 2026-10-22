/**
 * Eval-mode fixtures: the invented inbox and calendar the token eval reads when `AMAN_EVAL_MODE` is on.
 * Loaded once per process so a mail draft or calendar write made in one turn is still there in the next.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import configuration from '../config';
import { EvalCalendarApi } from './evalCalendarApi';
import { EvalGmailApi } from './evalGmailApi';

const InboxMessageSchema = z.object({
  from: z.string(),
  to: z.string().optional(),
  sent: z.string(),
  subject: z.string().optional(),
  body: z.string(),
});

const InboxThreadSchema = z.object({
  id: z.string(),
  subject: z.string(),
  messages: z.array(InboxMessageSchema).min(1),
});

const InboxFixtureSchema = z.object({
  mailbox_owner: z.object({ name: z.string(), email: z.string() }),
  threads: z.array(InboxThreadSchema),
});
export type InboxFixture = z.infer<typeof InboxFixtureSchema>;

const CalendarEventFixtureSchema = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  time_zone: z.string(),
  location: z.string(),
  attendees: z.array(z.string()),
});

const CalendarFixtureSchema = z.object({
  calendar_owner: z.string(),
  time_zone: z.string(),
  events: z.array(CalendarEventFixtureSchema),
});
export type CalendarFixture = z.infer<typeof CalendarFixtureSchema>;

export interface EvalSources {
  readonly mailOwner: string;
  readonly timeZone: string;
  readonly gmail: EvalGmailApi;
  readonly calendar: EvalCalendarApi;
}

function readFixture<T>({ dir, name, schema }: { dir: string; name: string; schema: z.ZodType<T> }): T {
  const file = path.join(dir, name);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`The eval fixture ${name} could not be read. Check that ${file} exists and is valid JSON.`, {
      cause: error,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`The eval fixture ${name} does not match its format. Check the file against the fixture schema.`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Reads both fixtures from `dir` and builds the sources that share their in-memory state. */
export function buildEvalSources(dir: string): EvalSources {
  const inbox = readFixture({ dir, name: 'inbox.json', schema: InboxFixtureSchema });
  const calendar = readFixture({ dir, name: 'calendar.json', schema: CalendarFixtureSchema });
  return {
    mailOwner: inbox.mailbox_owner.email,
    timeZone: calendar.time_zone,
    gmail: new EvalGmailApi({ inbox }),
    calendar: new EvalCalendarApi({ calendar }),
  };
}

let sources: EvalSources | undefined;

/** The eval sources for this process. Throws when a fixture is missing or does not match its format. */
export function evalSources(): EvalSources {
  sources ??= buildEvalSources(configuration.EVAL_FIXTURE_DIR);
  return sources;
}

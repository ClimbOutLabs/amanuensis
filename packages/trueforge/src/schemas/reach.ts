import { z } from '@hono/zod-openapi';

import { DeliveryLevelSchema, DeliveryLinkSchema } from './deliveries';
import { TimezoneSchema } from './schedule';

/**
 * The kinds of event the assistant watches for. A person ticks a kind for calls, and each kind has the highest level
 * it may ever reach. Stored as plain text, so a later part can add a kind without a migration.
 */
export const NoticingKindSchema = z
  .enum(['mail_always', 'calendar_clash', 'travel', 'bill_due', 'approval_waiting'])
  .describe('A kind of event the assistant watches for.')
  .openapi('NoticingKind');

export type NoticingKind = z.infer<typeof NoticingKindSchema>;

/** Every kind, in the order the Settings page lists them. */
export const NOTICING_KINDS: readonly NoticingKind[] = NoticingKindSchema.options;

/** A request for the person's ok closes itself after 30 minutes, so the wait to speak up stays well inside that. */
const APPROVAL_WAIT_MIN_MINUTES = 5;
const APPROVAL_WAIT_MAX_MINUTES = 20;

const ClockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 21:00.')
  .describe('A clock time as HH:MM, 24-hour.');

export const AlwaysImportantSenderSchema = z
  .object({
    address: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Use a full email address like dana@example.com.')
      .describe('The sender address, lower case.'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('What the person calls them. Left out when they gave no name.'),
    source: z
      .enum(['settings', 'memory'])
      .describe('Whether the person typed this sender or accepted it from a memory suggestion.'),
    added_at: z.string().describe('When the person added this sender, ISO 8601 UTC.'),
  })
  .openapi('AlwaysImportantSender');

export const QuietHoursSchema = z
  .object({
    enabled: z.boolean().describe('Whether calls are held back during quiet hours.'),
    start: ClockTimeSchema.describe('When quiet hours start, in the time zone below.'),
    end: ClockTimeSchema.describe('When quiet hours end, in the time zone below.'),
  })
  .openapi('QuietHours');

/** The channels a person can switch. In-app is always on; push is per device and kept with the device. */
export const ReachChannelsSchema = z
  .object({
    texts: z.boolean().describe('Whether texts may be used. Off until text messages are set up.'),
    calls: z.boolean().describe('Whether phone calls may be used. Off until phone calls are set up.'),
  })
  .openapi('ReachChannels');

/** Whether the background checks run for someone who has not switched them on or off. */
export const NOTICING_ON_BY_DEFAULT = false;

export const ReachSettingsSchema = z
  .object({
    noticing_on: z
      .boolean()
      .default(NOTICING_ON_BY_DEFAULT)
      .describe(
        'Whether the assistant checks mail, the calendar and waiting approvals in the background. Reminders work either way.',
      ),
    channels: ReachChannelsSchema,
    always_important: z
      .array(AlwaysImportantSenderSchema)
      .max(200)
      .describe('Senders whose mail the assistant tells the person about, once the mail server vouches for them.'),
    dismissed_suggestions: z
      .array(z.string().max(254))
      .max(500)
      .describe('Addresses the person turned down as always-important, so they are not suggested again.'),
    call_kinds: z
      .array(NoticingKindSchema)
      .max(NOTICING_KINDS.length)
      .describe('The kinds of event the person allows a phone call for. Empty means none.'),
    call_for_urgent_reminders: z.boolean().describe('Whether a reminder marked urgent may call.'),
    quiet_hours: QuietHoursSchema,
    timezone: TimezoneSchema,
    max_nudges_per_day: z
      .number()
      .int()
      .min(0)
      .max(50)
      .describe('Most nudges in one day. Past it, events become notes.'),
    min_hours_between_calls: z.number().int().min(1).max(72).describe('Fewest hours between two calls.'),
    travel_lead_minutes: z
      .number()
      .int()
      .min(15)
      .max(24 * 60)
      .describe('How long before an event with a place the person wants to hear about leaving.'),
    approval_wait_minutes: z
      .number()
      .int()
      .min(APPROVAL_WAIT_MIN_MINUTES)
      .max(APPROVAL_WAIT_MAX_MINUTES)
      .describe('How long an approval may wait before the assistant says so. A request expires after 30 minutes.'),
  })
  .describe('How the person wants to be reached. Quiet hours and "today" are read in `timezone`.')
  .openapi('ReachSettings');

export type ReachSettings = z.infer<typeof ReachSettingsSchema>;
export type AlwaysImportantSender = z.infer<typeof AlwaysImportantSenderSchema>;

/** What a new install starts with: quiet. Nothing is ticked for calls and no text or call channel is on. */
export function defaultReachSettings(timezone: string): ReachSettings {
  return {
    noticing_on: NOTICING_ON_BY_DEFAULT,
    channels: { texts: false, calls: false },
    always_important: [],
    dismissed_suggestions: [],
    call_kinds: [],
    call_for_urgent_reminders: false,
    quiet_hours: { enabled: true, start: '21:00', end: '08:00' },
    timezone,
    max_nudges_per_day: 5,
    min_hours_between_calls: 6,
    travel_lead_minutes: 90,
    approval_wait_minutes: 15,
  };
}

export const ReachChannelAvailabilitySchema = z
  .object({
    available: z.boolean().describe('Whether this channel can be used on this server now.'),
    note: z.string().describe('A plain-words line about the channel, shown beside its switch.'),
  })
  .openapi('ReachChannelAvailability');

export const ReachAvailabilitySchema = z
  .object({ texts: ReachChannelAvailabilitySchema, calls: ReachChannelAvailabilitySchema })
  .openapi('ReachAvailability');

export type ReachAvailability = z.infer<typeof ReachAvailabilitySchema>;

export const MailProblemKindSchema = z
  .enum(['too_slow', 'google_sign_in', 'email_password', 'other'])
  .describe(
    'Why mail could not be checked: the mail server answered too slowly, Google needs signing in again, the shared Email connector could not log in, or something else went wrong.',
  )
  .openapi('MailProblemKind');

export type MailProblemKind = z.infer<typeof MailProblemKindSchema>;

export const MailSourceKindSchema = z
  .enum(['google', 'email_connector'])
  .describe('Where mail is read from: the person’s own Google login, or the shared Email connector.')
  .openapi('MailSourceKind');

export type MailSourceKind = z.infer<typeof MailSourceKindSchema>;

export const MailProblemSchema = z
  .object({
    since: z.string().describe('When mail checks first failed, with none succeeding since, ISO 8601 UTC.'),
    kind: MailProblemKindSchema,
  })
  .openapi('MailProblem');

export const CalendarProblemKindSchema = z
  .enum(['google_sign_in', 'other'])
  .describe('Why the calendar could not be checked: Google needs signing in again, or something else went wrong.')
  .openapi('CalendarProblemKind');

export type CalendarProblemKind = z.infer<typeof CalendarProblemKindSchema>;

export const CalendarProblemSchema = z
  .object({
    since: z.string().describe('When calendar checks first failed, with none succeeding since, ISO 8601 UTC.'),
    kind: CalendarProblemKindSchema,
  })
  .openapi('CalendarProblem');

export const ReachViewSchema = z
  .object({
    settings: ReachSettingsSchema,
    saved: z.boolean().describe('False until the person saves once. While false, the settings are the quiet defaults.'),
    availability: ReachAvailabilitySchema,
    max_levels: z
      .record(NoticingKindSchema, DeliveryLevelSchema)
      .describe('The highest level each kind of event can ever reach, whatever the model says.'),
    mail_problem: MailProblemSchema.nullable().describe(
      'Set when mail has not been checked for about an hour. Null when mail checks work.',
    ),
    calendar_problem: CalendarProblemSchema.nullable().describe(
      'Set when the calendar has not been checked for about an hour. Null when calendar checks work.',
    ),
    mail_source: MailSourceKindSchema.nullable().describe(
      'Where mail is read from. Null until mail has been checked once.',
    ),
  })
  .openapi('ReachView');

export const GetReachResponseSchema = z.object({ data: ReachViewSchema }).openapi('GetReachResponse');

export const UpdateReachRequestSchema = z.object({ settings: ReachSettingsSchema }).openapi('UpdateReachRequest');

export const ReachSuggestionSchema = z
  .object({
    address: z.string().describe('A sender address found in a memory.'),
    memory: z.string().describe('The memory it came from, so the person can judge it.'),
  })
  .openapi('ReachSuggestion');

export type ReachSuggestion = z.infer<typeof ReachSuggestionSchema>;

export const ListReachSuggestionsResponseSchema = z
  .object({
    data: z.array(ReachSuggestionSchema).describe('Senders memory suggests. Nothing is added until accepted.'),
  })
  .openapi('ListReachSuggestionsResponse');

export const ReachTestChannelSchema = z
  .enum(['in_app', 'push', 'text', 'call'])
  .describe('The channel to try.')
  .openapi('ReachTestChannel');

export const TestReachChannelRequestSchema = z
  .object({ channel: ReachTestChannelSchema })
  .openapi('TestReachChannelRequest');

export const TestReachChannelResponseSchema = z
  .object({
    data: z
      .object({
        delivery_id: z.string().describe('The test item, now in the feed.'),
        devices_reached: z.number().int().min(0).describe('Devices a push notice went to.'),
      })
      .openapi('ReachTestResult'),
  })
  .openapi('TestReachChannelResponse');

export const NoticingWatcherSchema = z.enum(['mail', 'calendar', 'approvals']).openapi('NoticingWatcher');

/** The body of the internal pass the controller asks the server to run. */
export const RunNoticingRequestSchema = z.object({ watcher: NoticingWatcherSchema }).openapi('RunNoticingRequest');

export const RunNoticingResultSchema = z
  .object({
    owners: z.number().int().min(0).describe('People checked.'),
    raised: z.number().int().min(0).describe('New events turned into notes or nudges.'),
  })
  .openapi('RunNoticingResult');

export type RunNoticingResult = z.infer<typeof RunNoticingResultSchema>;

export const RunNoticingResponseSchema = z.object({ data: RunNoticingResultSchema }).openapi('RunNoticingResponse');

export type NoticingWatcher = z.infer<typeof NoticingWatcherSchema>;

/**
 * How far an event's evidence can be trusted. `own` comes from the person's own data (their calendar, their waiting
 * approvals). `verified_sender` is mail from someone on their always-important list that the mail server vouched for.
 * `content` is only what some text said, such as a due date in a bill: it can raise a note, never a nudge or a call.
 */
export const NoticingEvidenceSchema = z.enum(['own', 'verified_sender', 'content']);

export type NoticingEvidence = z.infer<typeof NoticingEvidenceSchema>;

/** Enough to find a mail event's message again, so a tracked bill can be checked later for a "paid". */
export const NoticingMailRefSchema = z.object({
  message_id: z.string().min(1),
  thread_id: z.string().min(1).nullable(),
});

/** One thing a watcher found. The id is stable, so the same thing found twice is raised once. */
export const NoticingEventSchema = z.object({
  id: z.string().min(1).max(512),
  kind: NoticingKindSchema,
  evidence: NoticingEvidenceSchema,
  /** The plain sentence used when no model is called, and the fallback when the model's message cannot be used. */
  summary: z.string().min(1).max(500),
  /** What the model reads, as data: trimmed facts about the event. */
  facts: z.string().max(4000),
  /** Why this event matched, in plain words. */
  matched: z.string().min(1).max(300),
  /** Where the delivery leads. */
  link: DeliveryLinkSchema.nullable(),
  mail_ref: NoticingMailRefSchema.nullable(),
  occurred_at: z.string(),
  due_at: z.string().nullable(),
});

export type NoticingEvent = z.infer<typeof NoticingEventSchema>;

/** The model's answer for one event. The level is only a request: the person's rules decide what happens. */
export const NoticingVerdictSchema = z.object({
  level: DeliveryLevelSchema,
  reason: z.string().trim().min(1).max(300),
  message: z.string().trim().min(1).max(300),
});

export type NoticingVerdict = z.infer<typeof NoticingVerdictSchema>;

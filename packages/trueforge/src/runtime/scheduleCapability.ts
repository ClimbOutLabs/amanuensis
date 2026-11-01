import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type {
  AgentCapability,
  AgentTracing,
  InstructionBuilder,
  ReminderLine,
  SentinelHostContext,
  Tier3Schedule,
} from '@truefoundry/trueforge-core/core';
import {
  classifyHostToolCall,
  defineTool,
  extractErrorLogFields,
  LocalToolMCP,
  type ToolDefinition,
} from '@truefoundry/trueforge-core/core';
import type { ApprovalDecision } from '@truefoundry/trueforge-core/core/events/schema';
import { stampSentinelDecision } from '@truefoundry/trueforge-core/core/mcp/ToolSet';
import type { ToolBundleName } from '@truefoundry/trueforge-core/core/runtime/toolBundleCatalog';
import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import {
  CANCEL_REMINDER_TOOL_NAME,
  CREATE_SCHEDULE_TOOL_NAME,
  DELETE_SCHEDULE_TOOL_NAME,
  isReminderToolName,
  isScheduleWriteToolName,
  LIST_REMINDERS_TOOL_NAME,
  LIST_SCHEDULES_TOOL_NAME,
  PAUSE_SCHEDULE_TOOL_NAME,
  RESUME_SCHEDULE_TOOL_NAME,
  SCHEDULE_SERVER_ID,
  SET_REMINDER_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/schedules/toolContract';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import { z } from 'zod';
import type { AgentRecord } from '../db/agentStore';
import { ScheduleNameConflictError, type IScheduleStore, type ScheduleRecord } from '../db/scheduleStore';
import type { WithTransaction } from '../db/transaction';
import { NameSchema } from '../schemas/common';
import {
  InvalidCronError,
  RunAtSchema,
  ScheduleManifestSchema,
  ScheduleTaskSchema,
  TimezoneSchema,
  type ScheduleKind,
  type ScheduleManifest,
  type ScheduleStatus,
} from '../schemas/schedule';
import { ChatAssistantUnavailableError, type ChatAssistant } from './chatAssistant';
import { firstRunAfter, nextTriggerAfter, validateManifest } from './cron';
import { errorResult, jsonResult, plainIssues } from './toolResults';

/** Cron day-of-week order: index 0 is Sunday. */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const WeekdaySchema = z.enum(WEEKDAYS);

export const CreateScheduleToolSchema = z
  .object({
    name: NameSchema,
    task: ScheduleTaskSchema.optional(),
    morning_brief: z
      .boolean()
      .optional()
      .describe('True for a morning brief. The brief instructions are filled in for you, so leave task out.'),
    repeat: z
      .enum(['daily', 'weekdays', 'weekly'])
      .optional()
      .describe('daily, weekdays (Monday to Friday), or weekly on the given days.'),
    days: z.array(WeekdaySchema).optional().describe('Days for a weekly schedule.'),
    time: z.string().optional().describe('24-hour local time, like 08:00.'),
    time_zone: TimezoneSchema.optional(),
  })
  .strict();

export const ScheduleRefToolSchema = z
  .object({ schedule: z.string().trim().min(1).describe('Schedule name or id.') })
  .strict();

const ListSchedulesToolSchema = z.object({}).strict();

export const SetReminderToolSchema = z
  .object({
    what: z.string().trim().min(1).max(300).describe('Words to show when due.'),
    at: RunAtSchema.describe('Due time, ISO 8601 with offset. A repeat keeps its time of day.'),
    repeat: z.enum(['daily', 'weekdays', 'weekly']).optional(),
    days: z.array(WeekdaySchema).optional(),
  })
  .strict();

export const CancelReminderToolSchema = z
  .object({ reminder: z.string().trim().min(1).describe('Id or exact words.') })
  .strict();

export type CreateScheduleToolInput = z.infer<typeof CreateScheduleToolSchema>;
type ScheduleRefToolInput = z.infer<typeof ScheduleRefToolSchema>;
export type SetReminderToolInput = z.infer<typeof SetReminderToolSchema>;
type CancelReminderToolInput = z.infer<typeof CancelReminderToolSchema>;

/** Keys the host adds to an approved call: what the card was settled on, so a later change ends the approval. */
const APPROVED_ZONE_KEY = 'resolved_time_zone';
const APPROVED_RUNS_AS_KEY = 'resolved_runs_as';
const APPROVED_SCHEDULE_KEY = 'resolved_schedule_id';

const NOT_APPROVED = 'Nothing was changed because the user has not approved it. Ask again if they still want it.';

/** How many schedules one lookup reads; a user with more is told to use the Schedules page. */
const SCHEDULE_LOOKUP_LIMIT = 500;
const SCHEDULE_PAGE_SIZE = 100;

/** What a schedule tool needs from the host for one chat turn. */
export interface ScheduleTurnContext {
  store: IScheduleStore<unknown>;
  withTransaction: WithTransaction<unknown>;
  tenant_id: string;
  /** The person in the chat; schedules are created as, listed for and changed only by them. */
  owner: CreatedBySubject;
  /** A schedule made here always runs as this chat's own assistant. */
  chatAssistant: ChatAssistant;
  /** Who a saved schedule runs as, in plain words. */
  runsAs: (schedule: ScheduleRecord) => Promise<string>;
  logger: Logger;
}

/** The store a host hands to chat turns where schedules run. */
export type ScheduleStoreAccess = Pick<ScheduleTurnContext, 'store' | 'withTransaction'>;

interface ScheduleToolSetOptions extends ScheduleTurnContext {
  tracing: AgentTracing;
  /** The user's IANA time zone from their device; absent, the model must name one. */
  timeZone: string | undefined;
  sentinel: SentinelHostContext;
  now: () => Date;
}

type Prepared<T> = { ok: true; value: T } | { ok: false; message: string };

interface PreparedCreate {
  approved: Record<string, unknown>;
  review: Tier3Schedule;
  manifest: ScheduleManifest;
}

interface PreparedDelete {
  approved: Record<string, unknown>;
  review: Tier3Schedule;
  schedule: ScheduleRecord;
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function clock({ hour, minute }: { hour: number; minute: number }): string {
  const period = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(h12)}:${pad2(minute)} ${period}`;
}

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

function joinedWithAnd(items: readonly string[]): string {
  if (items.length <= 2) {
    return items.join(' and ');
  }
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** When a schedule runs, in plain words, for the shapes the Schedules page and these tools make. */
export function describeScheduleTiming(cron: string): string {
  const [minuteRaw, hourRaw, dayOfMonth, month, dayOfWeek] = cron.trim().split(/\s+/);
  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  const custom = `On a custom timing (${cron})`;
  if (dayOfMonth !== '*' || month !== '*' || !/^\d+$/.test(minuteRaw ?? '')) {
    return custom;
  }
  if (hourRaw === '*' && dayOfWeek === '*') {
    return `Every hour at :${pad2(minute)}`;
  }
  if (!/^\d+$/.test(hourRaw ?? '')) {
    return custom;
  }
  const at = clock({ hour, minute });
  if (dayOfWeek === '*') {
    return `Every day at ${at}`;
  }
  if (dayOfWeek === '1-5') {
    return `Every weekday at ${at}`;
  }
  if (dayOfWeek !== undefined && /^\d(?:,\d)*$/.test(dayOfWeek)) {
    const names = dayOfWeek.split(',').map(day => capitalized(WEEKDAYS[Number(day) % 7] ?? day));
    return `Every ${joinedWithAnd(names)} at ${at}`;
  }
  return custom;
}

/** When a schedule runs, in plain words: one time for a one-time schedule, else its repeating timing. */
export function describeManifestTiming(manifest: Pick<ScheduleManifest, 'cron' | 'run_at' | 'timezone'>): string {
  if (manifest.run_at !== null) {
    return `Once, on ${formatRunTime({ at: new Date(manifest.run_at), timezone: manifest.timezone })}`;
  }
  return manifest.cron === null ? 'At no set time' : describeScheduleTiming(manifest.cron);
}

/** How many upcoming runs the create card lists. */
const PREVIEW_RUNS = 3;

/** A schedule name in plain words: "morning-brief" reads "Morning brief". */
export function plainScheduleName(name: string): string {
  return capitalized(name.replace(/-/g, ' '));
}

/** The next few trigger times strictly after `from`. */
function upcomingRuns(input: { cron: string; timezone: string; from: Date; count: number }): Date[] {
  const runs: Date[] = [];
  let from = input.from;
  for (let i = 0; i < input.count; i++) {
    from = nextTriggerAfter({ cron: input.cron, timezone: input.timezone, from });
    runs.push(from);
  }
  return runs;
}

/** One instant in the schedule's own zone, in plain words, e.g. "Monday, October 19 at 8:00 AM". */
export function formatRunTime(input: { at: Date; timezone: string }): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(input.at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('weekday')}, ${part('month')} ${part('day')} at ${part('hour')}:${part('minute')} ${part('dayPeriod')}`;
}

/** The cron a clear recurrence makes, or the question to ask the user when the timing is vague. */
export function cronFromRecurrence(
  input: Pick<CreateScheduleToolInput, 'repeat' | 'days' | 'time'>,
): { ok: true; cron: string } | { ok: false; question: string } {
  if (input.repeat === undefined) {
    return {
      ok: false,
      question: 'How often should it run: every day, every weekday, or on certain days of the week?',
    };
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.time?.trim() ?? '');
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (match === null || hour > 23 || minute > 59) {
    return { ok: false, question: 'What time of day should it run?' };
  }
  const at = `${String(minute)} ${String(hour)} * *`;
  if (input.repeat === 'daily') {
    return { ok: true, cron: `${at} *` };
  }
  if (input.repeat === 'weekdays') {
    return { ok: true, cron: `${at} 1-5` };
  }
  const days = [...new Set((input.days ?? []).map(day => WEEKDAYS.indexOf(day)))].sort((a, b) => a - b);
  if (days.length === 0) {
    return { ok: false, question: 'Which days of the week should it run?' };
  }
  return { ok: true, cron: `${at} ${days.length === 7 ? '*' : days.join(',')}` };
}

/**
 * Older tool lists offered an `agent` field. A schedule always runs as this chat's assistant, so a stray one is
 * dropped and the person still gets the card.
 */
function withoutRetiredAgent(params: CallToolRequest['params']): CallToolRequest['params'] {
  if (params.name !== CREATE_SCHEDULE_TOOL_NAME || params.arguments === undefined || !('agent' in params.arguments)) {
    return params;
  }
  return {
    ...params,
    arguments: Object.fromEntries(Object.entries(params.arguments).filter(([key]) => key !== 'agent')),
  };
}

/**
 * Schedules for the person in one chat, over the same store and limits as the Schedules page. Creating or deleting
 * always shows a card first; listing, pausing and resuming run without asking.
 */
export class ScheduleToolSet extends LocalToolMCP {
  readonly name = SCHEDULE_SERVER_ID;
  readonly displayName = 'Schedules';
  protected override readonly bundle: ToolBundleName = 'schedules';
  readonly #options: ScheduleToolSetOptions;
  readonly #tools: ToolDefinition[];

  constructor(options: ScheduleToolSetOptions) {
    super({ tracing: options.tracing });
    this.#options = options;
    this.#tools = [
      defineTool({
        name: CREATE_SCHEDULE_TOOL_NAME,
        description:
          "The only way to make a recurring task; it runs as the assistant here. For a plain reminder use set_reminder instead. Never say it is scheduled unless this succeeded. Ask first if how often or when is unclear. Times use the user's time zone. Morning brief: set morning_brief, not task. The user approves a card first.",
        schema: CreateScheduleToolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: (input, approval) => this.#create({ input, approval }),
      }),
      defineTool({
        name: LIST_SCHEDULES_TOOL_NAME,
        description:
          "List the user's schedules: name, when each runs, whether it is active or paused, and its next run.",
        schema: ListSchedulesToolSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
        handler: () => this.#list(),
      }),
      defineTool({
        name: PAUSE_SCHEDULE_TOOL_NAME,
        description: 'Pause a schedule by name or id so it stops running until resumed. Runs without asking.',
        schema: ScheduleRefToolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: input => this.#setStatus({ input, status: 'paused' }),
      }),
      defineTool({
        name: RESUME_SCHEDULE_TOOL_NAME,
        description: 'Resume a paused schedule by name or id so it runs again from its next time. Runs without asking.',
        schema: ScheduleRefToolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: input => this.#setStatus({ input, status: 'active' }),
      }),
      defineTool({
        name: DELETE_SCHEDULE_TOOL_NAME,
        description: 'Delete a schedule by name or id, for good. The user approves a card first.',
        schema: ScheduleRefToolSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        handler: (input, approval) => this.#delete({ input, approval }),
      }),
      defineTool({
        name: SET_REMINDER_TOOL_NAME,
        description:
          'Set a reminder for the user. It only reaches them and needs no approval. For work you should do, use create_schedule.',
        schema: SetReminderToolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: input => this.#setReminder(input),
      }),
      defineTool({
        name: LIST_REMINDERS_TOOL_NAME,
        description: 'List upcoming reminders.',
        schema: ListSchedulesToolSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
        handler: () => this.#listReminders(),
      }),
      defineTool({
        name: CANCEL_REMINDER_TOOL_NAME,
        description: 'Cancel a reminder.',
        schema: CancelReminderToolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: input => this.#cancelReminder(input),
      }),
    ];
  }

  protected getTools(): ToolDefinition[] {
    return this.#tools;
  }

  override callTool(...[params, ...rest]: Parameters<LocalToolMCP['callTool']>): ReturnType<LocalToolMCP['callTool']> {
    return super.callTool(withoutRetiredAgent(params), ...rest);
  }

  /**
   * The host classifies every call. A create or delete card is built from what the host would really save or
   * remove, and what it was settled on joins the approved call so a later change needs a new approval.
   */
  override async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<Awaited<ReturnType<LocalToolMCP['toolCallInfo']>>> {
    const call = withoutRetiredAgent(params);
    const info = await super.toolCallInfo(call, resolveUnderlyingTool);
    // A preview while the call streams in has no arguments yet: classifying it would only repeat side effects (an audit row, a live read).
    if (resolveUnderlyingTool === false) {
      return info;
    }
    const prepared = isScheduleWriteToolName(call.name) ? await this.#prepareWrite(call) : undefined;
    if (prepared !== undefined && !prepared.ok) {
      // Not a permission wall: the model can fix the call or ask the user. A policy block would count toward
      // the turn's "tool not allowed here" stop.
      return { ...info, pre_dispatch_failure: { kind: 'pre_dispatch_failed', message: prepared.message } };
    }
    const reminder = isReminderToolName(call.name) ? await this.#reminderLine(call) : undefined;
    const decision = await classifyHostToolCall({
      sentinel: this.#options.sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: {
        tool_name: call.name,
        canonical_params: prepared?.value.approved ?? call.arguments ?? {},
        tool_type: 'truefoundry-system',
        mcp_server_name: SCHEDULE_SERVER_ID,
        mcp_hints: {
          read_only_hint: info.read_only_hint,
          destructive_hint: info.destructive_hint,
          open_world_hint: info.open_world_hint,
        },
        ...(prepared === undefined ? {} : { schedule_write: prepared.value.review }),
        ...(reminder === undefined ? {} : { reminder }),
      },
    });
    return {
      ...info,
      ...stampSentinelDecision({ decision }),
      ...(prepared === undefined ? {} : { mint_canonical_params: prepared.value.approved }),
    };
  }

  /** Re-settles a create or delete at dispatch, so an approval ends when what it covered changed. */
  async liveMintParams(params: CallToolRequest['params']): Promise<Record<string, unknown> | undefined> {
    if (!isScheduleWriteToolName(params.name)) {
      return undefined;
    }
    const prepared = await this.#prepareWrite(withoutRetiredAgent(params));
    if (!prepared.ok) {
      throw new Error(prepared.message);
    }
    return prepared.value.approved;
  }

  async #prepareWrite(
    params: CallToolRequest['params'],
  ): Promise<Prepared<{ approved: Record<string, unknown>; review: Tier3Schedule }>> {
    if (params.name === CREATE_SCHEDULE_TOOL_NAME) {
      return this.#prepareCreate(params.arguments ?? {});
    }
    return this.#prepareDelete(params.arguments ?? {});
  }

  #prepareCreate(args: Record<string, unknown>): Prepared<PreparedCreate> {
    const parsed = CreateScheduleToolSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: `Nothing was saved. ${plainIssues(parsed.error)} Fix this and try again.` };
    }
    const input = parsed.data;
    const timing = cronFromRecurrence(input);
    if (!timing.ok) {
      return {
        ok: false,
        message: `Nothing was saved because the timing is not clear. Ask the user: ${timing.question}`,
      };
    }
    if (input.morning_brief === true && input.task !== undefined) {
      return {
        ok: false,
        message: 'Nothing was saved because a morning brief sets its own task. Leave task out and try again.',
      };
    }
    const task = input.morning_brief === true ? MORNING_BRIEF_PROMPT : input.task;
    if (task === undefined) {
      return {
        ok: false,
        message: 'Nothing was saved because the schedule has no task. Ask the user what it should do.',
      };
    }
    const timezone = input.time_zone ?? this.#options.timeZone;
    if (timezone === undefined || !TimezoneSchema.safeParse(timezone).success) {
      return {
        ok: false,
        message: 'Nothing was saved because the time zone is not known. Ask the user which time zone they are in.',
      };
    }
    const manifest = ScheduleManifestSchema.parse({
      task,
      cron: timing.cron,
      run_at: null,
      timezone,
      status: 'active',
      kind: 'task',
    });
    const now = this.#options.now();
    try {
      validateManifest(manifest, now);
    } catch (error) {
      if (error instanceof InvalidCronError) {
        return {
          ok: false,
          message: 'Nothing was saved because that timing cannot run. Ask the user for another time.',
        };
      }
      throw error;
    }
    const { chatAssistant } = this.#options;
    return {
      ok: true,
      value: {
        approved: { ...args, [APPROVED_ZONE_KEY]: timezone, [APPROVED_RUNS_AS_KEY]: chatAssistant.approval_key },
        review: {
          action: 'create',
          name: plainScheduleName(input.name),
          when: describeScheduleTiming(timing.cron),
          time_zone: timezone,
          task: manifest.task,
          runs_as: chatAssistant.display_name,
          next_runs: upcomingRuns({ cron: timing.cron, timezone, from: now, count: PREVIEW_RUNS }).map(at =>
            formatRunTime({ at, timezone }),
          ),
        },
        manifest,
      },
    };
  }

  async #prepareDelete(args: Record<string, unknown>): Promise<Prepared<PreparedDelete>> {
    const parsed = ScheduleRefToolSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: 'Nothing was deleted. Pass the schedule name or id.' };
    }
    const found = await this.#find(parsed.data);
    if (!found.ok) {
      return found;
    }
    const schedule = found.value;
    return {
      ok: true,
      value: {
        approved: { ...args, [APPROVED_SCHEDULE_KEY]: schedule.id },
        review: {
          action: 'delete',
          name: plainScheduleName(schedule.name),
          when: describeManifestTiming(schedule.manifest),
          time_zone: schedule.manifest.timezone,
          task: schedule.manifest.task,
          runs_as: await this.#options.runsAs(schedule),
          next_runs: [],
        },
        schedule,
      },
    };
  }

  /** The owner's own schedules or reminders, newest first, up to the lookup limit. */
  async #ownSchedules(kind: ScheduleKind): Promise<ScheduleRecord[]> {
    const schedules: ScheduleRecord[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.#options.store.listSchedules({
        tenant_id: this.#options.tenant_id,
        limit: SCHEDULE_PAGE_SIZE,
        page_token: pageToken,
        agent_names: undefined,
        created_by_or_agent_ids: { created_by_subject_id: this.#options.owner.subject_id, agent_ids: [] },
      });
      schedules.push(...page.data.filter(schedule => schedule.manifest.kind === kind));
      pageToken = page.pagination.next_page_token;
    } while (pageToken !== undefined && schedules.length < SCHEDULE_LOOKUP_LIMIT);
    return schedules;
  }

  /** One of the owner's schedules by id, else by name. Names can repeat, so a shared name asks for the id. */
  async #find(ref: ScheduleRefToolInput): Promise<Prepared<ScheduleRecord>> {
    const schedules = await this.#ownSchedules('task');
    const byId = schedules.find(schedule => schedule.id === ref.schedule);
    if (byId !== undefined) {
      return { ok: true, value: byId };
    }
    const named = schedules.filter(schedule => schedule.name === ref.schedule.toLowerCase());
    if (named.length === 1 && named[0] !== undefined) {
      return { ok: true, value: named[0] };
    }
    if (named.length > 1) {
      const choices = await Promise.all(
        named.map(async schedule => `${schedule.id} (runs as ${await this.#options.runsAs(schedule)})`),
      );
      return {
        ok: false,
        message: `More than one schedule is named "${ref.schedule}". Try again with its id: ${choices.join(', ')}.`,
      };
    }
    return {
      ok: false,
      message: `There is no schedule named "${ref.schedule}". Call list_schedules to see the user's schedules.`,
    };
  }

  async #nextRun(schedule: ScheduleRecord): Promise<string | null> {
    if (schedule.status !== 'active') {
      return null;
    }
    const run = await this.#options.store.getScheduledRunFor({
      tenant_id: this.#options.tenant_id,
      schedule_id: schedule.id,
    });
    return run === undefined
      ? null
      : formatRunTime({ at: new Date(run.scheduled_for), timezone: schedule.manifest.timezone });
  }

  async #summary(schedule: ScheduleRecord) {
    return {
      id: schedule.id,
      name: schedule.name,
      when: describeManifestTiming(schedule.manifest),
      time_zone: schedule.manifest.timezone,
      status: schedule.status,
      next_run: await this.#nextRun(schedule),
      task: schedule.manifest.task,
      runs_as: await this.#options.runsAs(schedule),
    };
  }

  async #list() {
    const schedules = await this.#ownSchedules('task');
    return jsonResult({ schedules: await Promise.all(schedules.map(schedule => this.#summary(schedule))) });
  }

  async #create(input: { input: CreateScheduleToolInput; approval: ApprovalDecision | undefined }) {
    if (input.approval?.status !== 'allow') {
      return errorResult(NOT_APPROVED);
    }
    const prepared = this.#prepareCreate(input.input);
    if (!prepared.ok) {
      return errorResult(prepared.message);
    }
    const saved = await this.#save({ name: input.input.name, manifest: prepared.value.manifest });
    if (!saved.ok) {
      return errorResult(saved.message);
    }
    return jsonResult({ created: await this.#summary(saved.value) });
  }

  /** Saves a schedule that runs as this chat's assistant, with its first run queued. */
  async #save(input: { name: string; manifest: ScheduleManifest }): Promise<Prepared<ScheduleRecord>> {
    const { chatAssistant } = this.#options;
    let agent: AgentRecord;
    try {
      agent = await chatAssistant.agent();
    } catch (error) {
      if (error instanceof ChatAssistantUnavailableError) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
    try {
      const schedule = await this.#options.withTransaction(async transaction => {
        const result = await this.#options.store.createScheduleAndRun(
          {
            tenant_id: this.#options.tenant_id,
            agent_id: agent.id,
            agent_name: agent.name,
            name: input.name,
            persona_id: chatAssistant.persona_id,
            manifest: input.manifest,
            created_by_subject: this.#options.owner,
            runFrom: this.#options.now(),
          },
          transaction,
        );
        return result.schedule;
      });
      return { ok: true, value: schedule };
    } catch (error) {
      if (error instanceof ScheduleNameConflictError) {
        return {
          ok: false,
          message: `Nothing was saved because the user already has a schedule named "${input.name}". Try again with another name.`,
        };
      }
      throw error;
    }
  }

  /** A reminder's words, due time and repeat, checked against the clock; the same check runs for the activity line and the save. */
  #prepareReminder(args: Record<string, unknown>): Prepared<{ manifest: ScheduleManifest; line: ReminderLine }> {
    const parsed = SetReminderToolSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: `Nothing was set. ${plainIssues(parsed.error)} Fix this and try again.` };
    }
    const input = parsed.data;
    const timezone = this.#options.timeZone;
    if (timezone === undefined || !TimezoneSchema.safeParse(timezone).success) {
      return {
        ok: false,
        message: 'Nothing was set because the time zone is not known. Ask the user which time zone they are in.',
      };
    }
    const now = this.#options.now();
    const due = new Date(input.at);
    let cron: string | null = null;
    if (input.repeat !== undefined) {
      // The wall-clock time written in `at` is the time of day the repeat keeps.
      const timing = cronFromRecurrence({
        repeat: input.repeat,
        days: input.days,
        time: /T(\d{2}:\d{2})/.exec(input.at)?.[1],
      });
      if (!timing.ok) {
        return {
          ok: false,
          message: `Nothing was set because the repeat is not clear. Ask the user: ${timing.question}`,
        };
      }
      cron = timing.cron;
    } else if (due.getTime() <= now.getTime()) {
      return {
        ok: false,
        message: 'Nothing was set because that time has already passed. Ask the user for a later time.',
      };
    }
    const manifest = ScheduleManifestSchema.parse({
      task: input.what,
      cron,
      run_at: cron === null ? input.at : null,
      timezone,
      status: 'active',
      kind: 'reminder',
    });
    try {
      validateManifest(manifest, now);
    } catch (error) {
      if (error instanceof InvalidCronError) {
        return { ok: false, message: 'Nothing was set because that timing cannot run. Ask the user for another time.' };
      }
      throw error;
    }
    const first = firstRunAfter({ manifest, from: now });
    return { ok: true, value: { manifest, line: { when: formatRunTime({ at: first, timezone }), what: input.what } } };
  }

  /** What the activity line says about a reminder call: read from the call itself, never from the model's claim of success. */
  async #reminderLine(params: CallToolRequest['params']): Promise<ReminderLine | undefined> {
    const args = params.arguments ?? {};
    if (params.name === SET_REMINDER_TOOL_NAME) {
      const prepared = this.#prepareReminder(args);
      return prepared.ok ? prepared.value.line : undefined;
    }
    if (params.name === CANCEL_REMINDER_TOOL_NAME) {
      const parsed = CancelReminderToolSchema.safeParse(args);
      const found = parsed.success ? await this.#findReminder(parsed.data) : undefined;
      return found?.ok === true ? { when: null, what: found.value.manifest.task } : undefined;
    }
    return undefined;
  }

  async #setReminder(input: SetReminderToolInput) {
    const prepared = this.#prepareReminder(input);
    if (!prepared.ok) {
      return errorResult(prepared.message);
    }
    const saved = await this.#save({ name: `reminder-${randomUUID().slice(0, 8)}`, manifest: prepared.value.manifest });
    if (!saved.ok) {
      return errorResult(saved.message);
    }
    await this.#audit({
      tool_name: SET_REMINDER_TOOL_NAME,
      description: `Set a reminder for ${prepared.value.line.when ?? ''}: ${input.what}`,
    });
    return jsonResult({ set: await this.#reminderSummary(saved.value) });
  }

  async #reminderSummary(schedule: ScheduleRecord) {
    return {
      id: schedule.id,
      what: schedule.manifest.task,
      when: describeManifestTiming(schedule.manifest),
      time_zone: schedule.manifest.timezone,
      repeats: schedule.manifest.cron !== null,
      next: await this.#nextRun(schedule),
    };
  }

  async #listReminders() {
    const reminders = (await this.#ownSchedules('reminder')).filter(reminder => reminder.status === 'active');
    return jsonResult({ reminders: await Promise.all(reminders.map(reminder => this.#reminderSummary(reminder))) });
  }

  /** One of the owner's active reminders by id, else by its exact words. */
  async #findReminder(ref: CancelReminderToolInput): Promise<Prepared<ScheduleRecord>> {
    const reminders = (await this.#ownSchedules('reminder')).filter(reminder => reminder.status === 'active');
    const byId = reminders.find(reminder => reminder.id === ref.reminder);
    if (byId !== undefined) {
      return { ok: true, value: byId };
    }
    const wanted = ref.reminder.toLowerCase();
    const named = reminders.filter(reminder => reminder.manifest.task.toLowerCase() === wanted);
    if (named.length === 1 && named[0] !== undefined) {
      return { ok: true, value: named[0] };
    }
    if (named.length > 1) {
      return {
        ok: false,
        message: `More than one reminder says "${ref.reminder}". Try again with its id from list_reminders.`,
      };
    }
    return {
      ok: false,
      message: `There is no upcoming reminder like "${ref.reminder}". Call list_reminders to see the user's reminders.`,
    };
  }

  async #cancelReminder(input: CancelReminderToolInput) {
    const found = await this.#findReminder(input);
    if (!found.ok) {
      return errorResult(found.message);
    }
    const reminder = found.value;
    await this.#options.store.deleteSchedule({ tenant_id: this.#options.tenant_id, id: reminder.id });
    await this.#audit({
      tool_name: CANCEL_REMINDER_TOOL_NAME,
      description: `Cancelled a reminder: ${reminder.manifest.task}`,
    });
    return jsonResult({ cancelled: { id: reminder.id, what: reminder.manifest.task } });
  }

  async #setStatus(input: { input: ScheduleRefToolInput; status: ScheduleStatus }) {
    const found = await this.#find(input.input);
    if (!found.ok) {
      return errorResult(found.message);
    }
    const existing = found.value;
    if (existing.status === 'done') {
      return errorResult(
        `Nothing was changed because the schedule "${existing.name}" has already run and will not run again. Make a new one if the user wants it again.`,
      );
    }
    if (
      input.status === 'active' &&
      existing.manifest.run_at !== null &&
      new Date(existing.manifest.run_at).getTime() <= this.#options.now().getTime()
    ) {
      return errorResult(
        `Nothing was changed because the time for "${existing.name}" has passed. Make a new one for a later time.`,
      );
    }
    const verb = input.status === 'paused' ? 'Paused' : 'Resumed';
    if (existing.status !== input.status) {
      const updated = await this.#options.withTransaction(transaction =>
        this.#options.store.updateScheduleAndRun(
          {
            tenant_id: this.#options.tenant_id,
            id: existing.id,
            name: existing.name,
            manifest: { ...existing.manifest, status: input.status },
            runFrom: this.#options.now(),
          },
          transaction,
        ),
      );
      if (updated === undefined) {
        return errorResult(
          `Nothing was changed because the schedule "${existing.name}" was deleted first. Call list_schedules to see what is left.`,
        );
      }
      await this.#audit({
        tool_name: input.status === 'paused' ? PAUSE_SCHEDULE_TOOL_NAME : RESUME_SCHEDULE_TOOL_NAME,
        description: `${verb} the schedule "${existing.name}".`,
      });
      return jsonResult({ [input.status === 'paused' ? 'paused' : 'resumed']: await this.#summary(updated.schedule) });
    }
    return jsonResult({ unchanged: await this.#summary(existing), note: `It was already ${input.status}.` });
  }

  async #delete(input: { input: ScheduleRefToolInput; approval: ApprovalDecision | undefined }) {
    if (input.approval?.status !== 'allow') {
      return errorResult(NOT_APPROVED);
    }
    const prepared = await this.#prepareDelete(input.input);
    if (!prepared.ok) {
      return errorResult(prepared.message);
    }
    const { schedule } = prepared.value;
    await this.#options.store.deleteSchedule({ tenant_id: this.#options.tenant_id, id: schedule.id });
    return jsonResult({ deleted: { id: schedule.id, name: schedule.name } });
  }

  /** A pause or resume runs without a card, so it is written to the activity log here. */
  async #audit(input: { tool_name: string; description: string }): Promise<void> {
    const { sentinel, logger } = this.#options;
    try {
      await sentinel.services.audit?.record({
        tenant_id: sentinel.tenant_id,
        created_by: sentinel.created_by,
        conversation_id: sentinel.conversation_id,
        tier: 1,
        tool_name: input.tool_name,
        description: input.description,
        outcome: 'ran',
        auto_deny_reason: null,
      });
    } catch (error) {
      logger.warn('Could not record a schedule change in the activity log', extractErrorLogFields(error));
    }
  }
}

const SCHEDULE_INSTRUCTION_SECTION = 'schedules';
const SCHEDULE_INSTRUCTION =
  'Repeating tasks need create_schedule. For "remind me" use set_reminder: it only reaches the user and needs no approval. Never say something is scheduled or set unless create_schedule or set_reminder succeeded in this chat. If not, say so plainly.';

function buildScheduleInstruction(builder: InstructionBuilder): void {
  builder.addSection(SCHEDULE_INSTRUCTION_SECTION, SCHEDULE_INSTRUCTION);
}

/** Attaches the schedule tools, and the rule that they are the only way to schedule, to one chat turn's root thread. */
export function scheduleCapability(options: ScheduleToolSetOptions): AgentCapability {
  return {
    systemToolSets: [new ScheduleToolSet(options)],
    instructionBuilders: [buildScheduleInstruction],
    bundle: 'schedules',
  };
}

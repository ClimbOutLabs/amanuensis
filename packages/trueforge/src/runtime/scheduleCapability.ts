import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type {
  AgentCapability,
  AgentTracing,
  InstructionBuilder,
  SentinelHostContext,
  Tier3Schedule,
} from '@truefoundry/trueforge-core/core';
import {
  classifyHostToolCall,
  defineTool,
  extractErrorLogFields,
  LocalToolMCP,
  toolResultResponse,
  type ToolDefinition,
} from '@truefoundry/trueforge-core/core';
import type { ApprovalDecision } from '@truefoundry/trueforge-core/core/events/schema';
import { stampSentinelDecision } from '@truefoundry/trueforge-core/core/mcp/ToolSet';
import {
  CREATE_SCHEDULE_TOOL_NAME,
  DELETE_SCHEDULE_TOOL_NAME,
  isScheduleWriteToolName,
  LIST_SCHEDULES_TOOL_NAME,
  PAUSE_SCHEDULE_TOOL_NAME,
  RESUME_SCHEDULE_TOOL_NAME,
  SCHEDULE_SERVER_ID,
} from '@truefoundry/trueforge-core/core/schedules/toolContract';
import type { Logger } from 'winston';
import { z } from 'zod';
import type { AgentRecord } from '../db/agentStore';
import { ScheduleNameConflictError, type IScheduleStore, type ScheduleRecord } from '../db/scheduleStore';
import type { WithTransaction } from '../db/transaction';
import { NameSchema } from '../schemas/common';
import {
  InvalidCronError,
  ScheduleManifestSchema,
  ScheduleTaskSchema,
  TimezoneSchema,
  type ScheduleManifest,
  type ScheduleStatus,
} from '../schemas/schedule';
import { nextTriggerAfter, validateManifest } from './cron';

/** Cron day-of-week order: index 0 is Sunday. */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const WeekdaySchema = z.enum(WEEKDAYS);

export const CreateScheduleToolSchema = z
  .object({
    name: NameSchema,
    task: ScheduleTaskSchema,
    repeat: z
      .enum(['daily', 'weekdays', 'weekly'])
      .optional()
      .describe('daily, weekdays (Monday to Friday), or weekly on the given days.'),
    days: z.array(WeekdaySchema).optional().describe('Days for a weekly schedule.'),
    time: z.string().optional().describe('24-hour local time, like 08:00.'),
    time_zone: TimezoneSchema.optional(),
    agent: NameSchema.optional(),
  })
  .strict();

export const ScheduleRefToolSchema = z
  .object({ schedule: z.string().trim().min(1).describe('Schedule name or id.') })
  .strict();

const ListSchedulesToolSchema = z.object({}).strict();

export type CreateScheduleToolInput = z.infer<typeof CreateScheduleToolSchema>;
type ScheduleRefToolInput = z.infer<typeof ScheduleRefToolSchema>;

/** Keys the host adds to an approved call: what the card was settled on, so a later change ends the approval. */
const APPROVED_ZONE_KEY = 'resolved_time_zone';
const APPROVED_AGENT_KEY = 'resolved_agent_id';
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
  /** An agent the owner may use, by name; undefined names the chat's own agent. Undefined when none fits. */
  resolveAgent: (name: string | undefined) => Promise<AgentRecord | undefined>;
  /** The name the owner gave their assistant; shown instead of the chat's own agent name. Null when unset. */
  assistantName: string | null;
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
  agent: AgentRecord;
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
function formatRunTime(input: { at: Date; timezone: string }): string {
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

function jsonResult(value: unknown) {
  return toolResultResponse({ text: JSON.stringify(value) });
}

function errorResult(message: string) {
  return toolResultResponse({ text: JSON.stringify({ error: message }), isError: true });
}

/**
 * Schedules for the person in one chat, over the same store and limits as the Schedules page. Creating or deleting
 * always shows a card first; listing, pausing and resuming run without asking.
 */
export class ScheduleToolSet extends LocalToolMCP {
  readonly name = SCHEDULE_SERVER_ID;
  readonly displayName = 'Schedules';
  readonly #options: ScheduleToolSetOptions;
  readonly #tools: ToolDefinition[];

  constructor(options: ScheduleToolSetOptions) {
    super({ tracing: options.tracing });
    this.#options = options;
    this.#tools = [
      defineTool({
        name: CREATE_SCHEDULE_TOOL_NAME,
        description:
          "The only way to make a recurring task. Never say something is scheduled unless this succeeded. If how often or what time is unclear, ask the user first. Times are in the user's time zone. The user approves a card before anything is saved.",
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
    ];
  }

  protected getTools(): ToolDefinition[] {
    return this.#tools;
  }

  /**
   * The host classifies every call. A create or delete card is built from what the host would really save or
   * remove, and what it was settled on joins the approved call so a later change needs a new approval.
   */
  override async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<Awaited<ReturnType<LocalToolMCP['toolCallInfo']>>> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    const prepared = isScheduleWriteToolName(params.name) ? await this.#prepareWrite(params) : undefined;
    if (prepared !== undefined && !prepared.ok) {
      return { ...info, pre_dispatch_failure: { kind: 'policy_blocked', message: prepared.message } };
    }
    const decision = await classifyHostToolCall({
      sentinel: this.#options.sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: {
        tool_name: params.name,
        canonical_params: prepared?.value.approved ?? params.arguments ?? {},
        tool_type: 'truefoundry-system',
        mcp_server_name: SCHEDULE_SERVER_ID,
        mcp_hints: {
          read_only_hint: info.read_only_hint,
          destructive_hint: info.destructive_hint,
          open_world_hint: info.open_world_hint,
        },
        ...(prepared === undefined ? {} : { schedule_write: prepared.value.review }),
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
    const prepared = await this.#prepareWrite(params);
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

  async #prepareCreate(args: Record<string, unknown>): Promise<Prepared<PreparedCreate>> {
    const parsed = CreateScheduleToolSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: `Nothing was saved. The schedule details were not valid: ${parsed.error.message}` };
    }
    const input = parsed.data;
    const timing = cronFromRecurrence(input);
    if (!timing.ok) {
      return {
        ok: false,
        message: `Nothing was saved because the timing is not clear. Ask the user: ${timing.question}`,
      };
    }
    const timezone = input.time_zone ?? this.#options.timeZone;
    if (timezone === undefined || !TimezoneSchema.safeParse(timezone).success) {
      return {
        ok: false,
        message: 'Nothing was saved because the time zone is not known. Ask the user which time zone they are in.',
      };
    }
    const manifest = ScheduleManifestSchema.parse({ task: input.task, cron: timing.cron, timezone, status: 'active' });
    const now = this.#options.now();
    try {
      validateManifest(manifest, now);
    } catch (error) {
      if (error instanceof InvalidCronError) {
        return { ok: false, message: `Nothing was saved. ${error.message}` };
      }
      throw error;
    }
    const agent = await this.#options.resolveAgent(input.agent);
    if (agent === undefined) {
      return {
        ok: false,
        message:
          input.agent === undefined
            ? 'Nothing was saved because this chat has no saved agent to run it. Ask the user which agent should run it.'
            : `Nothing was saved because there is no agent named "${input.agent}" that the user can use. Ask the user which agent should run it.`,
      };
    }
    return {
      ok: true,
      value: {
        approved: { ...args, [APPROVED_ZONE_KEY]: timezone, [APPROVED_AGENT_KEY]: agent.id },
        review: {
          action: 'create',
          name: plainScheduleName(input.name),
          when: describeScheduleTiming(timing.cron),
          time_zone: timezone,
          task: manifest.task,
          runs_as: await this.#runsAs({ id: agent.id, name: agent.name }),
          next_runs: upcomingRuns({ cron: timing.cron, timezone, from: now, count: PREVIEW_RUNS }).map(at =>
            formatRunTime({ at, timezone }),
          ),
        },
        agent,
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
          when: describeScheduleTiming(schedule.manifest.cron),
          time_zone: schedule.manifest.timezone,
          task: schedule.manifest.task,
          runs_as: await this.#runsAs({ id: schedule.agent_id, name: schedule.agent_name }),
          next_runs: [],
        },
        schedule,
      },
    };
  }

  /** The assistant's own name for the chat's agent; any other agent by its name. */
  async #runsAs(agent: { id: string; name: string }): Promise<string> {
    const { assistantName } = this.#options;
    if (assistantName === null) {
      return agent.name;
    }
    const own = await this.#options.resolveAgent(undefined);
    return own?.id === agent.id ? assistantName : agent.name;
  }

  /** The owner's own schedules, newest first, up to the lookup limit. */
  async #ownSchedules(): Promise<ScheduleRecord[]> {
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
      schedules.push(...page.data);
      pageToken = page.pagination.next_page_token;
    } while (pageToken !== undefined && schedules.length < SCHEDULE_LOOKUP_LIMIT);
    return schedules;
  }

  /** One of the owner's schedules by id, else by name. Names repeat across agents, so a shared name asks for the id. */
  async #find(ref: ScheduleRefToolInput): Promise<Prepared<ScheduleRecord>> {
    const schedules = await this.#ownSchedules();
    const byId = schedules.find(schedule => schedule.id === ref.schedule);
    if (byId !== undefined) {
      return { ok: true, value: byId };
    }
    const named = schedules.filter(schedule => schedule.name === ref.schedule.toLowerCase());
    if (named.length === 1 && named[0] !== undefined) {
      return { ok: true, value: named[0] };
    }
    if (named.length > 1) {
      return {
        ok: false,
        message: `More than one schedule is named "${ref.schedule}". Use its id instead: ${named.map(s => `${s.id} (${s.agent_name})`).join(', ')}.`,
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
      when: describeScheduleTiming(schedule.manifest.cron),
      time_zone: schedule.manifest.timezone,
      status: schedule.status,
      next_run: await this.#nextRun(schedule),
      task: schedule.manifest.task,
      runs_as: schedule.agent_name,
    };
  }

  async #list() {
    const schedules = await this.#ownSchedules();
    return jsonResult({ schedules: await Promise.all(schedules.map(schedule => this.#summary(schedule))) });
  }

  async #create(input: { input: CreateScheduleToolInput; approval: ApprovalDecision | undefined }) {
    if (input.approval?.status !== 'allow') {
      return errorResult(NOT_APPROVED);
    }
    const prepared = await this.#prepareCreate(input.input);
    if (!prepared.ok) {
      return errorResult(prepared.message);
    }
    const { agent, manifest } = prepared.value;
    let schedule: ScheduleRecord;
    try {
      schedule = await this.#options.withTransaction(async transaction => {
        const result = await this.#options.store.createScheduleAndRun(
          {
            tenant_id: this.#options.tenant_id,
            agent_id: agent.id,
            agent_name: agent.name,
            name: input.input.name,
            manifest,
            created_by_subject: this.#options.owner,
            runFrom: this.#options.now(),
          },
          transaction,
        );
        return result.schedule;
      });
    } catch (error) {
      if (error instanceof ScheduleNameConflictError) {
        return errorResult(
          `Nothing was saved because a schedule named "${input.input.name}" already exists for ${agent.name}. Pick another name.`,
        );
      }
      throw error;
    }
    return jsonResult({ created: await this.#summary(schedule) });
  }

  async #setStatus(input: { input: ScheduleRefToolInput; status: ScheduleStatus }) {
    const found = await this.#find(input.input);
    if (!found.ok) {
      return errorResult(found.message);
    }
    const existing = found.value;
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
        return errorResult(`The schedule "${existing.name}" was deleted before it could be changed.`);
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
  'Schedules can only be made with create_schedule. Never tell the user something is scheduled, set to repeat, or will run later unless create_schedule succeeded in this chat. If it did not, say so plainly.';

function buildScheduleInstruction(builder: InstructionBuilder): void {
  builder.addSection(SCHEDULE_INSTRUCTION_SECTION, SCHEDULE_INSTRUCTION);
}

/** Attaches the schedule tools, and the rule that they are the only way to schedule, to one chat turn's root thread. */
export function scheduleCapability(options: ScheduleToolSetOptions): AgentCapability {
  return { systemToolSets: [new ScheduleToolSet(options)], instructionBuilders: [buildScheduleInstruction] };
}

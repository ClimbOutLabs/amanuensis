import { AgentSpecSchema, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  InstructionBuilder,
  type AuditRecordInput,
  type SentinelServices,
} from '@truefoundry/trueforge-core/core';
import type { ApprovalDecision } from '@truefoundry/trueforge-core/core/events/schema';
import type { InternalEnrichedAssistantMessage } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '@truefoundry/trueforge-core/core/mcp/executeToolCalls';
import { isCallToolResponseResult } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import winston from 'winston';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { scheduleCapability, ScheduleToolSet } from '../../../src/runtime/scheduleCapability';

const OWNER: CreatedBySubject = { subject_id: 'owner-1', subject_type: 'user', subject_display_name: 'Test Owner' };
/** Sunday, October 18 2026, 08:00 in New York. */
const NOW = new Date('2026-10-18T12:00:00.000Z');

const MORNING_BRIEF = {
  name: 'morning-brief',
  task: 'Give me a morning brief: my calendar for today and important unread mail.',
  repeat: 'weekdays',
  time: '08:00',
};

async function setup(input: { timeZone?: string | undefined; assistantName?: string | null } = {}) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const agentStore = new SqliteAgentStore(db);
  const store = new SqliteScheduleStore(db);
  const createAgent = (name: string) =>
    agentStore.createAgent({
      tenant_id: 'default',
      created_by_subject: OWNER,
      name,
      description: 'Test agent.',
      manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
      external_id: null,
    });
  const assistant = await createAgent('assistant');
  await createAgent('researcher');
  const audit: AuditRecordInput[] = [];
  const services: SentinelServices = {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    audit: { record: row => Promise.resolve(void audit.push(row)) },
  };
  const sentinel = createSentinelHostContext({
    services,
    tenant_id: 'default',
    created_by: OWNER.subject_id,
    conversation_id: 'chat-1',
  });
  const options: ConstructorParameters<typeof ScheduleToolSet>[0] = {
    tracing: NOOP_AGENT_TRACING,
    store,
    withTransaction: callback => db.transaction().execute(callback),
    tenant_id: 'default',
    owner: OWNER,
    resolveAgent: async name => (name === undefined ? assistant : agentStore.getAgent({ tenant_id: 'default', name })),
    assistantName: 'assistantName' in input ? (input.assistantName ?? null) : 'Aman',
    logger: winston.createLogger({ silent: true }),
    timeZone: 'timeZone' in input ? input.timeZone : 'America/New_York',
    sentinel,
    now: () => NOW,
  };
  const tools = new ScheduleToolSet(options);
  const listAll = async () =>
    (
      await store.listSchedules({
        tenant_id: 'default',
        limit: 50,
        page_token: undefined,
        agent_names: undefined,
        created_by_or_agent_ids: undefined,
      })
    ).data;
  return { tools, options, sentinel, store, listAll, audit };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Classifies a call as the chat would, then dispatches it with the user's answer (none for a call that never asks). */
async function dispatch(input: {
  built: Setup;
  name: string;
  args: Record<string, unknown>;
  decision?: ApprovalDecision | undefined;
}) {
  const { tools, sentinel } = input.built;
  const info = await tools.toolCallInfo({ name: input.name, arguments: input.args });
  const message: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: input.name, arguments: JSON.stringify(input.args) },
        tool_info: info,
      },
    ],
  };
  const result = await executeToolCalls({
    assistantMessage: message,
    toolMapping: new Map([[input.name, { toolSet: tools, originalToolName: input.name }]]),
    threadId: 'main',
    approvalDecisions: new Map(input.decision === undefined ? [] : [['call-1', input.decision]]),
    memoState: createToolCallMemoState(),
    sentinel: {
      services: sentinel.services,
      identity: {
        tenant_id: sentinel.tenant_id,
        created_by: sentinel.created_by,
        conversation_id: sentinel.conversation_id,
        repository_id: null,
        workspace_cwd: null,
        agent_intent: null,
      },
    },
  });
  return { info, result };
}

function resultText(result: Awaited<ReturnType<typeof dispatch>>['result']): string {
  const content = result.toolCallResults[0]?.message.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

describe('create_schedule', () => {
  it('shows a card first, then on approval saves an active schedule the same as the Schedules page', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: MORNING_BRIEF });
    expect(info).toMatchObject({ tier: 3, tier_reason: 'schedule_write', is_approval_required: true });
    expect(info.tier3_card?.plain_what).toBe(
      'Create the schedule "Morning brief". It runs every weekday at 8:00 AM (America/New_York) and starts as soon as you approve.',
    );
    expect(info.tier3_card?.schedule).toEqual({
      action: 'create',
      name: 'Morning brief',
      when: 'Every weekday at 8:00 AM',
      time_zone: 'America/New_York',
      task: MORNING_BRIEF.task,
      runs_as: 'Aman',
      next_runs: [
        'Monday, October 19 at 8:00 AM',
        'Tuesday, October 20 at 8:00 AM',
        'Wednesday, October 21 at 8:00 AM',
      ],
    });
    expect(await built.listAll()).toEqual([]);

    const { result } = await dispatch({
      built,
      name: 'create_schedule',
      args: MORNING_BRIEF,
      decision: { status: 'allow' },
    });
    expect(resultText(result)).toContain('"status":"active"');
    const [saved] = await built.listAll();
    expect(saved).toMatchObject({
      name: 'morning-brief',
      agent_name: 'assistant',
      status: 'active',
      created_by_subject: OWNER,
      manifest: { task: MORNING_BRIEF.task, cron: '0 8 * * 1-5', timezone: 'America/New_York', status: 'active' },
    });
    const pending = await built.store.getScheduledRunFor({ tenant_id: 'default', schedule_id: saved?.id ?? '' });
    expect(pending?.scheduled_for).toBe('2026-10-19T12:00:00.000Z');
  });

  it('saves nothing without approval: not when denied, not when called directly', async () => {
    const built = await setup();
    const denied = await dispatch({
      built,
      name: 'create_schedule',
      args: MORNING_BRIEF,
      decision: { status: 'deny', reason: 'not now' },
    });
    expect(resultText(denied.result)).toContain('User denied tool call');
    const direct = await built.tools.callTool({ name: 'create_schedule', arguments: MORNING_BRIEF });
    expect(isCallToolResponseResult(direct) && direct.result.isError).toBe(true);
    expect(await built.listAll()).toEqual([]);
  });

  it.each([
    [{ ...MORNING_BRIEF, time: undefined }, 'What time of day should it run?'],
    [{ ...MORNING_BRIEF, time: 'morning' }, 'What time of day should it run?'],
    [{ ...MORNING_BRIEF, repeat: undefined }, 'How often should it run'],
    [{ ...MORNING_BRIEF, repeat: 'weekly' }, 'Which days of the week should it run?'],
  ])('refuses vague timing with a plain question and saves nothing', async (args, question) => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: args });
    expect(info.tier3_card).toBeUndefined();
    expect(info.pre_dispatch_failure?.message).toContain('Nothing was saved because the timing is not clear.');
    expect(info.pre_dispatch_failure?.message).toContain(question);
    expect(await built.listAll()).toEqual([]);
  });

  it("reads the time in the user's own zone, or in a zone they named", async () => {
    const built = await setup();
    const tokyo = await built.tools.toolCallInfo({
      name: 'create_schedule',
      arguments: {
        ...MORNING_BRIEF,
        repeat: 'weekly',
        days: ['wednesday', 'monday'],
        time: '21:30',
        time_zone: 'Asia/Tokyo',
      },
    });
    expect(tokyo.tier3_card?.schedule).toMatchObject({
      when: 'Every Monday and Wednesday at 9:30 PM',
      time_zone: 'Asia/Tokyo',
      next_runs: ['Monday, October 19 at 9:30 PM', 'Wednesday, October 21 at 9:30 PM', 'Monday, October 26 at 9:30 PM'],
    });
    await dispatch({
      built,
      name: 'create_schedule',
      args: {
        ...MORNING_BRIEF,
        repeat: 'weekly',
        days: ['wednesday', 'monday'],
        time: '21:30',
        time_zone: 'Asia/Tokyo',
      },
      decision: { status: 'allow' },
    });
    expect((await built.listAll())[0]?.manifest).toMatchObject({ cron: '30 21 * * 1,3', timezone: 'Asia/Tokyo' });
  });

  it.each([
    ['a cron field', { ...MORNING_BRIEF, cron: '*/5 * * * *' }, 'not valid'],
    ['cron as the time', { ...MORNING_BRIEF, time: '*/5 * * * *' }, 'What time of day should it run?'],
    ['a UTC time', { ...MORNING_BRIEF, time: '13:00Z' }, 'What time of day should it run?'],
    ['an ISO instant', { ...MORNING_BRIEF, time: '2026-10-19T13:00:00Z' }, 'What time of day should it run?'],
    ['cron day numbers', { ...MORNING_BRIEF, repeat: 'weekly', days: ['1-5'] }, 'not valid'],
  ])('never trusts %s from the model as timing', async (_label, args, message) => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: args });
    expect(info.tier3_card).toBeUndefined();
    expect(info.pre_dispatch_failure?.message).toContain(message);
    expect(await built.listAll()).toEqual([]);
  });

  it('asks for the time zone when the device sent none and the model named none', async () => {
    const built = await setup({ timeZone: undefined });
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: MORNING_BRIEF });
    expect(info.pre_dispatch_failure?.message).toBe(
      'Nothing was saved because the time zone is not known. Ask the user which time zone they are in.',
    );
  });

  it('runs as another agent when the user names one, and refuses one that does not exist', async () => {
    const built = await setup();
    const named = await built.tools.toolCallInfo({
      name: 'create_schedule',
      arguments: { ...MORNING_BRIEF, agent: 'researcher' },
    });
    expect(named.tier3_card?.schedule?.runs_as).toBe('researcher');
    const unnamed = await (
      await setup({ assistantName: null })
    ).tools.toolCallInfo({
      name: 'create_schedule',
      arguments: MORNING_BRIEF,
    });
    expect(unnamed.tier3_card?.schedule?.runs_as).toBe('assistant');
    const missing = await built.tools.toolCallInfo({
      name: 'create_schedule',
      arguments: { ...MORNING_BRIEF, agent: 'nobody' },
    });
    expect(missing.pre_dispatch_failure?.message).toContain('there is no agent named "nobody"');
  });

  it('ends the approval when the timing changed after the card', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: MORNING_BRIEF });
    const message: InternalEnrichedAssistantMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'create_schedule', arguments: JSON.stringify({ ...MORNING_BRIEF, time: '05:00' }) },
          tool_info: info,
        },
      ],
    };
    await executeToolCalls({
      assistantMessage: message,
      toolMapping: new Map([['create_schedule', { toolSet: built.tools, originalToolName: 'create_schedule' }]]),
      threadId: 'main',
      approvalDecisions: new Map([['call-1', { status: 'allow' }]]),
      memoState: createToolCallMemoState(),
      sentinel: {
        services: built.sentinel.services,
        identity: {
          tenant_id: 'default',
          created_by: OWNER.subject_id,
          conversation_id: 'chat-1',
          repository_id: null,
          workspace_cwd: null,
          agent_intent: null,
        },
      },
    });
    expect(await built.listAll()).toEqual([]);
  });
});

describe('list, pause, resume and delete', () => {
  async function withMorningBrief() {
    const built = await setup();
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });
    return built;
  }

  it('lists name, when, active or paused, and next run without asking', async () => {
    const built = await withMorningBrief();
    const { info, result } = await dispatch({ built, name: 'list_schedules', args: {} });
    expect(info).toMatchObject({ tier: 1, is_approval_required: false });
    expect(JSON.parse(resultText(result))).toMatchObject({
      schedules: [
        {
          name: 'morning-brief',
          when: 'Every weekday at 8:00 AM',
          time_zone: 'America/New_York',
          status: 'active',
          next_run: 'Monday, October 19 at 8:00 AM',
        },
      ],
    });
  });

  it('pauses and resumes by name without asking, and records each in the activity log', async () => {
    const built = await withMorningBrief();
    const paused = await dispatch({ built, name: 'pause_schedule', args: { schedule: 'morning-brief' } });
    expect(paused.info).toMatchObject({ tier: 1, is_approval_required: false });
    expect(JSON.parse(resultText(paused.result))).toMatchObject({ paused: { status: 'paused', next_run: null } });
    const [schedule] = await built.listAll();
    expect(schedule?.status).toBe('paused');
    expect(
      await built.store.getScheduledRunFor({ tenant_id: 'default', schedule_id: schedule?.id ?? '' }),
    ).toBeUndefined();

    const resumed = await dispatch({ built, name: 'resume_schedule', args: { schedule: schedule?.id ?? '' } });
    expect(JSON.parse(resultText(resumed.result))).toMatchObject({
      resumed: { status: 'active', next_run: 'Monday, October 19 at 8:00 AM' },
    });
    expect(built.audit.map(row => [row.tool_name, row.description, row.outcome])).toEqual([
      [
        'create_schedule',
        'Create the schedule "Morning brief". It runs every weekday at 8:00 AM (America/New_York) and starts as soon as you approve.',
        'approved',
      ],
      ['pause_schedule', 'Paused the schedule "morning-brief".', 'ran'],
      ['resume_schedule', 'Resumed the schedule "morning-brief".', 'ran'],
    ]);
  });

  it('tells the model when there is no such schedule', async () => {
    const built = await withMorningBrief();
    const { result } = await dispatch({ built, name: 'pause_schedule', args: { schedule: 'evening-brief' } });
    expect(resultText(result)).toContain('There is no schedule named \\"evening-brief\\"');
  });

  it('deletes only after the user approves a card that shows what goes', async () => {
    const built = await withMorningBrief();
    const info = await built.tools.toolCallInfo({ name: 'delete_schedule', arguments: { schedule: 'morning-brief' } });
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(info.tier3_card?.plain_what).toBe(
      'Delete the schedule "Morning brief", which runs every weekday at 8:00 AM (America/New_York).',
    );
    await dispatch({
      built,
      name: 'delete_schedule',
      args: { schedule: 'morning-brief' },
      decision: { status: 'deny', reason: 'keep it' },
    });
    expect(await built.listAll()).toHaveLength(1);
    await dispatch({
      built,
      name: 'delete_schedule',
      args: { schedule: 'morning-brief' },
      decision: { status: 'allow' },
    });
    expect(await built.listAll()).toEqual([]);
  });
});

describe('the schedule rule in the system prompt', () => {
  it('tells the model that create_schedule is the only way to schedule', async () => {
    const built = await setup();
    const prompt = InstructionBuilder.createSystemPrompt('test');
    for (const build of scheduleCapability(built.options).instructionBuilders ?? []) {
      build(prompt);
    }
    expect(prompt.build()).toContain(
      'Schedules can only be made with create_schedule. Never tell the user something is scheduled',
    );
  });
});

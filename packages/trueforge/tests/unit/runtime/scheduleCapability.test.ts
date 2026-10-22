import { AgentSpecSchema, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import {
  AgentThread,
  AgentThreadOrchestrator,
  createSentinelHostContext,
  defaultSentinelServices,
  InstructionBuilder,
  type AgentThreadSendBatch,
  type AuditRecordInput,
  type SentinelServices,
} from '@truefoundry/trueforge-core/core';
import { EventType, type ApprovalDecision } from '@truefoundry/trueforge-core/core/events/schema';
import type { ILLM } from '@truefoundry/trueforge-core/core/llm/ILLM';
import {
  getEmptyUsage,
  type ExtendedChatCompletionChunk,
  type InternalEnrichedAssistantMessage,
  type RawAssistantMessageWithUsage,
} from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '@truefoundry/trueforge-core/core/mcp/executeToolCalls';
import { isCallToolResponseResult } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { approvalExpiredReason } from '@truefoundry/trueforge-core/core/permissions/approvalExpiry';
import { unfinishedNotice } from '@truefoundry/trueforge-core/core/runtime/replyBudget';
import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import winston from 'winston';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import {
  CHAT_ASSISTANT_DESCRIPTION,
  resolveChatAssistant,
  scheduleRunsAs,
  type ChatRunner,
} from '../../../src/runtime/chatAssistant';
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

/** A plain chat's own setup: no saved agent, just the model and instructions the person chose. */
const CHAT_SPEC = AgentSpecSchema.parse({ model: { name: 'test-provider/chat-model' }, instructions: 'chat' });

async function setup(
  input: {
    timeZone?: string | undefined;
    assistantName?: string | null;
    /** What runs the chat: a plain chat (the common case) or a saved agent. */
    runner?: ChatRunner['kind'];
    /** The chat is talking to a persona right now. */
    persona?: boolean;
  } = {},
) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const agentStore = new SqliteAgentStore(db);
  const personaStore = new SqlitePersonaStore(db);
  const store = new SqliteScheduleStore(db);
  const researcher = await agentStore.createAgent({
    host_managed: false,
    tenant_id: 'default',
    created_by_subject: OWNER,
    name: 'researcher',
    description: 'Test agent.',
    manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
    external_id: null,
  });
  const persona =
    input.persona === true
      ? await personaStore.createPersona({
          tenant_id: 'default',
          created_by: OWNER.subject_id,
          updated_by: OWNER.subject_id,
          id: 'persona-zara',
          display_name: 'Zara',
          aliases: [],
          instructions: 'Be brief.',
          model_name: 'test-provider/persona-model',
        })
      : undefined;
  const assistantName = 'assistantName' in input ? (input.assistantName ?? null) : 'Aman';
  const personalizationStore = new SqlitePersonalizationStore(db);
  if (assistantName !== null) {
    await personalizationStore.upsertProfile({
      tenant_id: 'default',
      created_by: OWNER.subject_id,
      updated_by: OWNER.subject_id,
      assistant_name: assistantName,
      assistant_identity: null,
      voice_guidance: null,
      user_name: null,
      address_as: null,
      user_profile: null,
      pinned_preferences: [],
      help_areas: [],
      learned_profile: null,
      learning_enabled: false,
    });
  }
  const runner: ChatRunner =
    input.runner === 'saved' ? { kind: 'saved', agent: researcher } : { kind: 'plain', spec: CHAT_SPEC };
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
    chatAssistant: resolveChatAssistant({
      tenant_id: 'default',
      owner: OWNER,
      runner,
      persona,
      assistantName,
      agentStore,
    }),
    runsAs: scheduleRunsAs({ tenant_id: 'default', agentStore, personaStore, personalizationStore }),
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
  return { tools, options, sentinel, store, agentStore, listAll, audit };
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
      web_search: sentinel.web_search,
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
  it("shows a card first, then on approval saves an active schedule that runs as the plain chat's assistant", async () => {
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
      persona_id: null,
      status: 'active',
      created_by_subject: OWNER,
      manifest: { task: MORNING_BRIEF.task, cron: '0 8 * * 1-5', timezone: 'America/New_York', status: 'active' },
    });
    const pending = await built.store.getScheduledRunFor({ tenant_id: 'default', schedule_id: saved?.id ?? '' });
    expect(pending?.scheduled_for).toBe('2026-10-19T12:00:00.000Z');
    // The host made the stored agent from the chat's own setup; the model never named one.
    const runsAs = await built.agentStore.getAgent({ tenant_id: 'default', id: saved?.agent_id ?? '' });
    expect(runsAs).toMatchObject({
      name: saved?.agent_name,
      host_managed: true,
      description: CHAT_ASSISTANT_DESCRIPTION,
      manifest: CHAT_SPEC,
      created_by_subject: OWNER,
    });
    expect(JSON.parse(resultText(result))).toMatchObject({ created: { runs_as: 'Aman' } });
  });

  it('reuses the one stored agent for every schedule from a plain chat', async () => {
    const built = await setup();
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });
    await dispatch({
      built,
      name: 'create_schedule',
      args: { ...MORNING_BRIEF, name: 'evening-brief', time: '18:00' },
      decision: { status: 'allow' },
    });
    const saved = await built.listAll();
    expect(saved).toHaveLength(2);
    expect(new Set(saved.map(schedule => schedule.agent_id)).size).toBe(1);
    const agents = await built.agentStore.listAgents({
      include_host_managed: true,
      tenant_id: 'default',
      agent_name: undefined,
      limit: undefined,
      page_token: undefined,
    });
    expect(agents.data.filter(agent => agent.host_managed)).toHaveLength(1);
  });

  it("runs as the chat's saved agent when the chat has one", async () => {
    const built = await setup({ runner: 'saved' });
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: MORNING_BRIEF });
    expect(info.tier3_card?.schedule?.runs_as).toBe('researcher');
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });
    expect((await built.listAll())[0]).toMatchObject({ agent_name: 'researcher', persona_id: null });
  });

  it('keeps the persona the chat is talking to, and names it on the card', async () => {
    const built = await setup({ persona: true });
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: MORNING_BRIEF });
    expect(info.tier3_card?.schedule?.runs_as).toBe('Zara');
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });
    expect((await built.listAll())[0]).toMatchObject({ persona_id: 'persona-zara' });
    const { result } = await dispatch({ built, name: 'list_schedules', args: {} });
    expect(JSON.parse(resultText(result))).toMatchObject({ schedules: [{ runs_as: 'Zara' }] });
  });

  it("ignores an agent the model passes, shows a normal card and runs as the chat's assistant by the user's name for it", async () => {
    const built = await setup({ assistantName: 'Bender' });
    const guessed = { ...MORNING_BRIEF, agent: 'bender' };
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: guessed });
    expect(info.pre_dispatch_failure).toBeUndefined();
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(info.tier3_card?.schedule).toMatchObject({ name: 'Morning brief', runs_as: 'Bender' });

    const { result } = await dispatch({ built, name: 'create_schedule', args: guessed, decision: { status: 'allow' } });
    expect(JSON.parse(resultText(result))).toMatchObject({ created: { name: 'morning-brief', runs_as: 'Bender' } });
    const [saved] = await built.listAll();
    const runsAs = await built.agentStore.getAgent({ tenant_id: 'default', id: saved?.agent_id ?? '' });
    expect(runsAs).toMatchObject({ description: CHAT_ASSISTANT_DESCRIPTION, manifest: CHAT_SPEC });
    const listed = await dispatch({ built, name: 'list_schedules', args: {} });
    expect(JSON.parse(resultText(listed.result))).toMatchObject({
      schedules: [{ name: 'morning-brief', runs_as: 'Bender' }],
    });
  });

  it('names the assistant in plain words when the user has not named it', async () => {
    const built = await setup({ assistantName: null });
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: MORNING_BRIEF });
    expect(info.tier3_card?.schedule?.runs_as).toBe('Your assistant');
  });

  it('has no agent field, so the model cannot pick one', async () => {
    const built = await setup();
    const { result } = await built.tools.listTools();
    const create = result.tools.find(tool => tool.name === 'create_schedule');
    expect(Object.keys(create?.inputSchema.properties ?? {})).not.toContain('agent');
  });

  it('still reports other unknown details as a fixable error', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({
      name: 'create_schedule',
      arguments: { ...MORNING_BRIEF, cron: '0 8 * * *' },
    });
    expect(info.tier3_card).toBeUndefined();
    expect(info.pre_dispatch_failure).toMatchObject({ kind: 'pre_dispatch_failed' });
    expect(info.pre_dispatch_failure?.message).toContain('Fix this and try again.');
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

  it('reports a fixable call as an ordinary failed call the model can retry, never as a policy block', async () => {
    const built = await setup();
    const vague = { ...MORNING_BRIEF, time: undefined };
    const { info, result } = await dispatch({ built, name: 'create_schedule', args: vague });
    expect(info.pre_dispatch_failure?.kind).toBe('pre_dispatch_failed');
    const [call] = result.toolCallResults;
    expect(call?.disposition).not.toBe('policy_blocked');
    expect(call?.remediation?.reason_code).not.toBe('tool_policy_blocked');
    expect(resultText(result)).toContain('Ask the user: What time of day should it run?');
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

  it('saves a morning brief with the canonical prompt, whatever the model would have written', async () => {
    const built = await setup();
    const brief = { name: 'morning-brief', morning_brief: true, repeat: 'weekdays', time: '08:00' };
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: brief });
    expect(info.tier3_card?.schedule).toMatchObject({ task: MORNING_BRIEF_PROMPT });

    await dispatch({ built, name: 'create_schedule', args: brief, decision: { status: 'allow' } });
    const [saved] = await built.listAll();
    expect(saved?.manifest).toMatchObject({ task: MORNING_BRIEF_PROMPT, cron: '0 8 * * 1-5' });
  });

  it('refuses a morning brief that also names its own task', async () => {
    const built = await setup();
    const args = { ...MORNING_BRIEF, morning_brief: true };
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: args });
    expect(info.tier3_card).toBeUndefined();
    expect(info.pre_dispatch_failure?.message).toContain('Leave task out');
    expect(await built.listAll()).toEqual([]);
  });

  it('refuses a schedule with neither a task nor a morning brief', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({
      name: 'create_schedule',
      arguments: { name: 'morning-brief', repeat: 'weekdays', time: '08:00' },
    });
    expect(info.tier3_card).toBeUndefined();
    expect(info.pre_dispatch_failure?.message).toContain('has no task');
    expect(await built.listAll()).toEqual([]);
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
        web_search: built.sentinel.web_search,
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

describe.each([
  ['a plain chat', 'plain', 'Aman'],
  ['a saved agent chat', 'saved', 'researcher'],
] as const)('list, pause, resume and delete for a schedule made in %s', (_label, runner, runsAs) => {
  async function withMorningBrief() {
    const built = await setup({ runner });
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
          runs_as: runsAs,
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
    expect(info.tier3_card?.schedule?.runs_as).toBe(runsAs);
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
      'Schedules can only be made with create_schedule, and only repeating ones: a one-time reminder or check-in later cannot be set. Never tell the user something is scheduled',
    );
  });
});

/** The old Tour card: it promised a check-in in 25 minutes. */
const OLD_TOUR_PROMPT =
  "I can't get started. Pick the one smallest thing I should do right now, and check in with me in 25 minutes.";
/** What a model made of that prompt: the only schedule it can make is a repeating one. */
const CHECK_IN = {
  name: 'check-in',
  task: 'Ask how the smallest step went.',
  repeat: 'daily',
  time: '08:25',
  time_zone: 'America/New_York',
};
const SAID_NO = /you said no|you declined|you held off|the person declined/i;

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* scriptedStream(
  output: RawAssistantMessageWithUsage['output'],
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const finish = output.tool_calls === undefined ? 'stop' : 'tool_calls';
  yield {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'scripted',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          ...(typeof output.content === 'string' ? { content: output.content } : {}),
          ...(output.tool_calls === undefined
            ? {}
            : { tool_calls: output.tool_calls.map((call, index) => ({ index, ...call })) }),
        },
        finish_reason: finish,
      },
    ],
  };
  return { output, usage: getEmptyUsage(), finish_reason: finish };
}

/**
 * A model that answers from what the tools said: asked for a check-in, it calls create_schedule, then
 * reports the result it read. It never claims the person declined unless the result says so.
 */
function scriptedModel(): ILLM['create'] {
  return request => {
    const last = request.messages.at(-1);
    const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    const asked = request.messages.some(
      message => message.role === 'user' && typeof message.content === 'string' && message.content === OLD_TOUR_PROMPT,
    );
    const toolResult = [...request.messages].reverse().find(message => message.role === 'tool');
    if (asked && toolResult === undefined) {
      return scriptedStream({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-check-in',
            type: 'function',
            function: { name: 'create_schedule', arguments: JSON.stringify(CHECK_IN) },
          },
        ],
      });
    }
    const said = typeof toolResult?.content === 'string' ? toolResult.content : lastText;
    const reply = said.includes('"created"')
      ? 'Do the first small step now. Your check-in is set.'
      : said.includes('They did not say no')
        ? 'Do the first small step now. The check-in request expired before you answered, so it is not set.'
        : 'Do the first small step now. I could not set the check-in.';
    return scriptedStream({ role: 'assistant', content: reply });
  };
}

async function tourChat() {
  const built = await setup();
  const create = jest.fn(scriptedModel());
  const thread = new AgentThread({
    definition: {
      modelClient: { create, createNonStream: jest.fn() },
      instruction: 'You are Aman.',
      messages: undefined,
      modelParams: undefined,
      responseFormat: undefined,
      iterationLimit: undefined,
      toolSets: undefined,
      modelId: undefined,
      configuredModels: undefined,
    },
    threadId: 'main',
    title: 'tour',
    capabilities: [scheduleCapability(built.options)],
    sentinel: built.sentinel,
    tracing: NOOP_AGENT_TRACING,
    logger: winston.createLogger({ silent: true }),
  });
  const orchestrator = new AgentThreadOrchestrator({
    agentThreads: new Map([[thread.threadId, thread]]),
    createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent')),
    tracing: NOOP_AGENT_TRACING,
    logger: winston.createLogger({ silent: true }),
  });
  const run = async (sendBatch: AgentThreadSendBatch) => {
    for await (const _event of orchestrator.send(sendBatch)) {
      void _event;
    }
    const iterator = orchestrator.execute({ signal: new AbortController().signal });
    let step = await iterator.next();
    while (step.done !== true) {
      step = await iterator.next();
    }
    return step.value;
  };
  const first = await run([{ type: EventType.USER_MESSAGE, content: OLD_TOUR_PROMPT }]);
  const card = first.required_actions.flatMap(action =>
    action.type === EventType.TOOL_APPROVAL_REQUIRED
      ? action.tool_calls.map(call => ({ thread_id: action.thread_id, id: call.id }))
      : [],
  );
  const answer = (approval: ApprovalDecision) =>
    run(
      card.map(call => ({
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: call.thread_id,
        tool_call_id: call.id,
        approval,
      })),
    );
  return { built, card, answer };
}

describe('the Tour check-in prompt, run through a scripted model', () => {
  it('asks once, and on approval saves exactly one schedule with no "You said no" line', async () => {
    const { built, card, answer } = await tourChat();
    expect(card).toHaveLength(1);
    expect(await built.listAll()).toEqual([]);

    const done = await answer({ status: 'allow' });

    expect(await built.listAll()).toHaveLength(1);
    expect(done.output?.content).toBe('Do the first small step now. Your check-in is set.');
    expect(built.audit.map(row => row.outcome)).toContain('approved');
  });

  it('tells the person a card left unanswered expired, never that they said no, and saves nothing', async () => {
    const { built, answer } = await tourChat();

    const done = await answer({ status: 'deny', reason: approvalExpiredReason() });

    expect(await built.listAll()).toEqual([]);
    expect(done.output?.content).toContain('The check-in request expired before you answered');
    expect(done.output?.content).toContain(unfinishedNotice('expired'));
    expect(done.output?.content).not.toMatch(SAID_NO);
    // The activity log does not record the person turning it down either.
    expect(built.audit).toContainEqual(
      expect.objectContaining({
        tool_name: 'create_schedule',
        outcome: 'auto_denied',
        auto_deny_reason: 'approval_expired',
      }),
    );
  });

  it('keeps the "You said no" line for the person\'s own decline', async () => {
    const { built, answer } = await tourChat();

    const done = await answer({ status: 'deny', reason: 'not now' });

    expect(await built.listAll()).toEqual([]);
    expect(done.output?.content).toContain(unfinishedNotice('declined'));
    expect(built.audit).toContainEqual(expect.objectContaining({ tool_name: 'create_schedule', outcome: 'denied' }));
  });
});

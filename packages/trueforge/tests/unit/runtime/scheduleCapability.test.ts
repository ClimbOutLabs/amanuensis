import { AgentSpecSchema, type AgentSpec, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
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
import { allowsChatApproval, allowsToolGrant } from '@truefoundry/trueforge-core/core/mcp/approvalGrant';
import { createToolCallMemoState, executeToolCalls } from '@truefoundry/trueforge-core/core/mcp/executeToolCalls';
import { isCallToolResponseResult } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { approvalExpiredReason } from '@truefoundry/trueforge-core/core/permissions/approvalExpiry';
import { forUnattendedRun } from '@truefoundry/trueforge-core/core/permissions/context';
import {
  checkHeldReplay,
  HELD_RESULT_TEXT,
  holdApprovalCalls,
} from '@truefoundry/trueforge-core/core/permissions/heldActions';
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
    /** A plain chat's own setup; defaults to a bare model and instructions. */
    spec?: AgentSpec;
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
    input.runner === 'saved' ? { kind: 'saved', agent: researcher } : { kind: 'plain', spec: input.spec ?? CHAT_SPEC };
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
    session_id: 'chat-1',
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

type CallInfo = Awaited<ReturnType<ScheduleToolSet['toolCallInfo']>>;

/**
 * Classifies a call as the chat would, then dispatches it with the user's answer (none for a call that never asks).
 * A card the person saw earlier can be passed in, to dispatch the call some time after it was shown.
 */
async function dispatch(input: {
  built: Setup;
  name: string;
  args: Record<string, unknown>;
  decision?: ApprovalDecision | undefined;
  shown?: CallInfo | undefined;
}) {
  const { tools, sentinel } = input.built;
  const info = input.shown ?? (await tools.toolCallInfo({ name: input.name, arguments: input.args }));
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
  it('asks every time: its card never offers the chat-wide answer, for a create or a delete', async () => {
    const built = await setup();
    const create = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: MORNING_BRIEF });
    expect(create).toMatchObject({ tier_reason: 'schedule_write', is_approval_required: true });
    expect(allowsChatApproval(create)).toBe(false);
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });
    const remove = await built.tools.toolCallInfo({
      name: 'delete_schedule',
      arguments: { schedule: 'morning-brief' },
    });
    expect(remove).toMatchObject({ tier_reason: 'schedule_write', is_approval_required: true });
    expect(allowsChatApproval(remove)).toBe(false);
  });

  it("shows a card first, then on approval saves an active schedule that runs as the plain chat's assistant", async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: MORNING_BRIEF });
    expect(info).toMatchObject({ tier: 3, tier_reason: 'schedule_write', is_approval_required: true });
    expect(info.tier3_card?.plain_what).toBe(
      'Create the schedule "Morning brief"? It runs every weekday at 8:00 AM (America/New_York) and starts as soon as you approve.',
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

  it("captures the chat's connectors, skills and sandbox on the agent the schedule runs as", async () => {
    const spec = AgentSpecSchema.parse({
      model: { name: 'test-provider/chat-model' },
      instructions: 'chat',
      mcp_servers: [{ name: 'calendar' }, { name: 'mail' }],
      skills: [{ name: 'digest' }],
      config: { sandbox: { enabled: true } },
    });
    const built = await setup({ spec });
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });
    const [saved] = await built.listAll();
    const runsAs = await built.agentStore.getAgent({ tenant_id: 'default', id: saved?.agent_id ?? '' });
    expect(runsAs?.manifest.mcp_servers?.map(server => server.name)).toEqual(['calendar', 'mail']);
    expect(runsAs?.manifest.skills?.map(skill => skill.name)).toEqual(['digest']);
    expect(runsAs?.manifest.config.sandbox.enabled).toBe(true);
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
    expect(resultText(denied.result)).toContain('The person said no to this.');
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

  it('pauses and resumes only after the person approves a card that shows the schedule', async () => {
    const built = await withMorningBrief();
    const pause = { built, name: 'pause_schedule', args: { schedule: 'morning-brief' } };
    const asked = await built.tools.toolCallInfo({ name: pause.name, arguments: pause.args });
    expect(asked).toMatchObject({ tier: 3, tier_reason: 'schedule_status', is_approval_required: true });
    expect(asked.tier3_card?.plain_what).toBe(
      'Pause the schedule "Morning brief"? It runs every weekday at 8:00 AM (America/New_York) and will not run again until it is resumed.',
    );
    await dispatch({ ...pause, decision: { status: 'deny', reason: 'keep it running' } });
    expect((await built.listAll())[0]?.status).toBe('active');

    const paused = await dispatch({ ...pause, decision: { status: 'allow' } });
    expect(JSON.parse(resultText(paused.result))).toMatchObject({ paused: { status: 'paused', next_run: null } });
    const [schedule] = await built.listAll();
    expect(schedule?.status).toBe('paused');
    expect(
      await built.store.getScheduledRunFor({ tenant_id: 'default', schedule_id: schedule?.id ?? '' }),
    ).toBeUndefined();

    const resume = { built, name: 'resume_schedule', args: { schedule: schedule?.id ?? '' } };
    const askedAgain = await built.tools.toolCallInfo({ name: resume.name, arguments: resume.args });
    expect(askedAgain).toMatchObject({ tier: 3, tier_reason: 'schedule_status', is_approval_required: true });
    expect(askedAgain.tier3_card?.plain_what).toBe(
      'Resume the schedule "Morning brief"? It runs every weekday at 8:00 AM (America/New_York) and starts again as soon as you approve.',
    );
    await dispatch({ ...resume, decision: { status: 'deny', reason: 'not yet' } });
    expect((await built.listAll())[0]?.status).toBe('paused');

    const resumed = await dispatch({ ...resume, decision: { status: 'allow' } });
    expect(JSON.parse(resultText(resumed.result))).toMatchObject({
      resumed: { status: 'active', next_run: 'Monday, October 19 at 8:00 AM' },
    });
    expect((await built.listAll())[0]?.status).toBe('active');
  });

  it('asks every time for a pause or a resume: no answer covers the next one', async () => {
    const built = await withMorningBrief();
    const asked = await built.tools.toolCallInfo({ name: 'pause_schedule', arguments: { schedule: 'morning-brief' } });
    expect(allowsChatApproval(asked)).toBe(false);
    expect(allowsToolGrant(asked)).toBe(false);
    await dispatch({
      built,
      name: 'pause_schedule',
      args: { schedule: 'morning-brief' },
      shown: asked,
      decision: { status: 'allow' },
    });
    const askedResume = await built.tools.toolCallInfo({
      name: 'resume_schedule',
      arguments: { schedule: 'morning-brief' },
    });
    expect(askedResume).toMatchObject({ tier: 3, is_approval_required: true });
    expect(allowsChatApproval(askedResume)).toBe(false);
    expect(allowsToolGrant(askedResume)).toBe(false);
  });

  it('does not pause a different schedule that took the name after the card was shown', async () => {
    const built = await withMorningBrief();
    const pause = { built, name: 'pause_schedule', args: { schedule: 'morning-brief' } };
    const shown = await built.tools.toolCallInfo({ name: pause.name, arguments: pause.args });
    const [first] = await built.listAll();
    await built.store.deleteSchedule({ tenant_id: 'default', id: first?.id ?? '' });
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });

    await dispatch({ ...pause, shown, decision: { status: 'allow' } });
    const [second] = await built.listAll();
    expect(second?.id).not.toBe(first?.id);
    expect(second?.status).toBe('active');
  });

  it('answers a pause that would change nothing with the reason, and shows no card', async () => {
    const built = await withMorningBrief();
    await dispatch({
      built,
      name: 'pause_schedule',
      args: { schedule: 'morning-brief' },
      decision: { status: 'allow' },
    });
    const again = await built.tools.toolCallInfo({ name: 'pause_schedule', arguments: { schedule: 'morning-brief' } });
    expect(again.tier3_card).toBeUndefined();
    expect(again.pre_dispatch_failure?.message).toBe(
      'Nothing was changed because the schedule "morning-brief" is already paused.',
    );
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
      'Delete the schedule "Morning brief", which runs every weekday at 8:00 AM (America/New_York)?',
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
      'Repeating tasks need create_schedule. For "remind me" use set_reminder: it only reaches the user and needs no approval. Never say something is scheduled or set unless create_schedule or set_reminder succeeded in this chat.',
    );
  });
});

const MEDICINE = { what: 'Take the medicine', at: '2026-10-19T18:00:00-04:00' };

describe('in an incognito chat', () => {
  it('only lists schedules and reminders: anything set here would outlive the chat', async () => {
    const built = await setup();
    const tools = new ScheduleToolSet({ ...built.options, keepsNothing: true });
    expect((await tools.listTools()).result.tools.map(tool => tool.name).sort()).toEqual([
      'list_reminders',
      'list_schedules',
    ]);
    const refused = await tools.callTool({ name: 'set_reminder', arguments: MEDICINE });
    expect(isCallToolResponseResult(refused) && refused.result.isError).toBe(true);
    expect(await built.listAll()).toEqual([]);
    expect(built.audit).toEqual([]);
  });

  it('tells the model it cannot set or change one here', async () => {
    const built = await setup();
    const prompt = InstructionBuilder.createSystemPrompt('test');
    for (const build of scheduleCapability({ ...built.options, keepsNothing: true }).instructionBuilders ?? []) {
      build(prompt);
    }
    const text = prompt.build();
    expect(text).toContain('This incognito chat cannot set, change or cancel a schedule or a reminder.');
    expect(text).not.toContain('use set_reminder');
  });
});

describe('reminder tools', () => {
  it('sets a one-time reminder without a card, records it, and tells the activity log in plain words', async () => {
    const built = await setup();
    const { info, result } = await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    expect(info).toMatchObject({
      tier: 1,
      tier_reason: 'reminder_write',
      is_approval_required: false,
      tier3_card: null,
    });
    expect(JSON.parse(resultText(result))).toMatchObject({
      set: { what: 'Take the medicine', repeats: false, next: 'Monday, October 19 at 6:00 PM' },
    });
    const [saved] = await built.listAll();
    expect(saved).toMatchObject({
      status: 'active',
      created_by_subject: OWNER,
      manifest: {
        task: 'Take the medicine',
        cron: null,
        run_at: '2026-10-19T18:00:00-04:00',
        kind: 'reminder',
        timezone: 'America/New_York',
        origin_session_id: 'chat-1',
      },
    });
    const pending = await built.store.getScheduledRunFor({ tenant_id: 'default', schedule_id: saved?.id ?? '' });
    expect(pending?.scheduled_for).toBe('2026-10-19T22:00:00.000Z');
    expect(built.audit.map(row => [row.tool_name, row.description, row.outcome])).toEqual([
      ['set_reminder', 'Set a reminder for Monday, October 19 at 6:00 PM: Take the medicine', 'ran'],
    ]);
  });

  it('records no origin chat when a reminder is set outside a chat', async () => {
    const built = await setup();
    const outsideChat = { ...built, tools: new ScheduleToolSet({ ...built.options, session_id: null }) };
    await dispatch({ built: outsideChat, name: 'set_reminder', args: MEDICINE });
    const [saved] = await built.listAll();
    expect(saved?.manifest).toMatchObject({ kind: 'reminder', origin_session_id: null });
  });

  it('refuses a time in the past with a message that says what to do next', async () => {
    const built = await setup();
    const { result } = await dispatch({
      built,
      name: 'set_reminder',
      args: { what: 'Too late', at: '2026-10-18T07:00:00-04:00' },
    });
    expect(resultText(result)).toContain(
      'Nothing was set because that time has already passed. Ask the user for a later time.',
    );
    expect(await built.listAll()).toEqual([]);
  });

  it('makes a repeating reminder from the existing cron path', async () => {
    const built = await setup();
    await dispatch({
      built,
      name: 'set_reminder',
      args: { what: 'Take the medicine', at: '2026-10-19T08:30:00-04:00', repeat: 'weekdays' },
    });
    const [saved] = await built.listAll();
    expect(saved?.manifest).toMatchObject({ cron: '30 8 * * 1-5', run_at: null, kind: 'reminder' });
  });

  it('lists upcoming reminders apart from schedules without asking', async () => {
    const built = await setup();
    await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    const schedules = await dispatch({ built, name: 'list_schedules', args: {} });
    expect(JSON.parse(resultText(schedules.result))).toEqual({ schedules: [] });

    const listed = await dispatch({ built, name: 'list_reminders', args: {} });
    expect(listed.info).toMatchObject({ tier: 1, tier_reason: 'reminder_read', is_approval_required: false });
    expect(JSON.parse(resultText(listed.result)).reminders).toHaveLength(1);
  });

  it('cancels a reminder only after the person approves a card that shows it', async () => {
    const built = await setup();
    await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    const [reminder] = await built.listAll();
    const cancel = { built, name: 'cancel_reminder', args: { reminder: reminder?.id ?? '' } };
    const asked = await built.tools.toolCallInfo({ name: cancel.name, arguments: cancel.args });
    expect(asked).toMatchObject({ tier: 3, tier_reason: 'reminder_cancel', is_approval_required: true });
    expect(asked.tier3_card?.plain_what).toBe(
      'Cancel the reminder "Take the medicine", set for Monday, October 19 at 6:00 PM?',
    );
    expect(asked.tier3_card?.cannot_be_undone).toBe('Once cancelled, the reminder is gone for good.');
    expect(allowsChatApproval(asked)).toBe(false);
    expect(allowsToolGrant(asked)).toBe(false);

    await dispatch({ ...cancel, decision: { status: 'deny', reason: 'keep it' } });
    expect(await built.listAll()).toHaveLength(1);

    const cancelled = await dispatch({ ...cancel, decision: { status: 'allow' } });
    expect(JSON.parse(resultText(cancelled.result))).toMatchObject({ cancelled: { what: 'Take the medicine' } });
    expect(await built.listAll()).toEqual([]);
  });

  it('asks again for the next reminder: one answer never covers another cancel', async () => {
    const built = await setup();
    await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    await dispatch({ built, name: 'set_reminder', args: { what: 'Call the clinic', at: '2026-10-20T09:00:00-04:00' } });
    await dispatch({
      built,
      name: 'cancel_reminder',
      args: { reminder: 'Take the medicine' },
      decision: { status: 'allow' },
    });
    const next = await built.tools.toolCallInfo({
      name: 'cancel_reminder',
      arguments: { reminder: 'Call the clinic' },
    });
    expect(next).toMatchObject({ tier: 3, tier_reason: 'reminder_cancel', is_approval_required: true });
    expect(next.tier3_card?.plain_what).toBe(
      'Cancel the reminder "Call the clinic", set for Tuesday, October 20 at 9:00 AM?',
    );
    expect((await built.listAll()).map(row => row.manifest.task)).toEqual(['Call the clinic']);
  });

  it('shows when a repeating reminder runs on the cancel card', async () => {
    const built = await setup();
    await dispatch({
      built,
      name: 'set_reminder',
      args: { what: 'Take the medicine', at: '2026-10-19T08:30:00-04:00', repeat: 'weekdays' },
    });
    const asked = await built.tools.toolCallInfo({
      name: 'cancel_reminder',
      arguments: { reminder: 'Take the medicine' },
    });
    expect(asked.tier3_card?.plain_what).toBe(
      'Cancel the reminder "Take the medicine", set for every weekday at 8:30 AM?',
    );
  });

  it('does not cancel a different reminder that has the same words after the card was shown', async () => {
    const built = await setup();
    await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    const cancel = { built, name: 'cancel_reminder', args: { reminder: 'Take the medicine' } };
    const shown = await built.tools.toolCallInfo({ name: cancel.name, arguments: cancel.args });
    const [first] = await built.listAll();
    await built.store.deleteSchedule({ tenant_id: 'default', id: first?.id ?? '' });
    await dispatch({ built, name: 'set_reminder', args: { ...MEDICINE, at: '2026-10-21T07:00:00-04:00' } });

    await dispatch({ ...cancel, shown, decision: { status: 'allow' } });
    const left = await built.listAll();
    expect(left).toHaveLength(1);
    expect(left[0]?.id).not.toBe(first?.id);
  });

  it('says what to do when no reminder matches, and shows no card', async () => {
    const built = await setup();
    await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    const missing = await dispatch({ built, name: 'cancel_reminder', args: { reminder: 'Walk the dog' } });
    expect(missing.info.tier3_card).toBeUndefined();
    expect(resultText(missing.result)).toContain('Call list_reminders');
    expect(await built.listAll()).toHaveLength(1);
  });

  it('sets a reminder without a card after a cancel was approved or refused', async () => {
    const built = await setup();
    await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    await dispatch({
      built,
      name: 'cancel_reminder',
      args: { reminder: 'Take the medicine' },
      decision: { status: 'deny', reason: 'keep it' },
    });
    const { info } = await dispatch({
      built,
      name: 'set_reminder',
      args: { what: 'Call the clinic', at: '2026-10-20T09:00:00-04:00' },
    });
    expect(info).toMatchObject({ tier: 1, is_approval_required: false, tier3_card: null });
    expect(await built.listAll()).toHaveLength(2);
  });
});

/** The same tools as `built`, in a run a schedule started with nobody watching. */
function inScheduledRun(built: Setup): Setup {
  const sentinel = { ...built.sentinel, services: forUnattendedRun(built.sentinel.services) };
  return { ...built, sentinel, tools: new ScheduleToolSet({ ...built.options, sentinel }) };
}

/** Classifies a call as a scheduled run would, holds it if it asks, and dispatches what is left. */
async function dispatchUnattended(input: { built: Setup; name: string; args: Record<string, unknown> }) {
  const run = inScheduledRun(input.built);
  const info = await run.tools.toolCallInfo({ name: input.name, arguments: input.args });
  const { message } = holdApprovalCalls({
    message: {
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
    },
    alreadyHeld: 0,
    isSubAgent: false,
    browserEditWaiting: false,
  });
  const result = await executeToolCalls({
    assistantMessage: message,
    toolMapping: new Map([[input.name, { toolSet: run.tools, originalToolName: input.name }]]),
    threadId: 'main',
    approvalDecisions: new Map(),
    memoState: createToolCallMemoState(),
    sentinel: {
      services: run.sentinel.services,
      web_search: run.sentinel.web_search,
      identity: {
        tenant_id: run.sentinel.tenant_id,
        created_by: run.sentinel.created_by,
        conversation_id: run.sentinel.conversation_id,
        repository_id: null,
        workspace_cwd: null,
        agent_intent: null,
      },
    },
  });
  return { info, result };
}

describe('in a scheduled run, a change to a reminder or a schedule waits for the owner', () => {
  it('holds a new reminder: the card says when and what, and nothing is saved', async () => {
    const built = await setup();
    const { info, result } = await dispatchUnattended({ built, name: 'set_reminder', args: MEDICINE });
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(info.tier3_card?.plain_what).toBe('Set a reminder for Monday, October 19 at 6:00 PM: Take the medicine?');
    expect(resultText(result)).toBe(HELD_RESULT_TEXT);
    expect(await built.listAll()).toEqual([]);
  });

  it('holds a cancel: the card names the reminder, and the reminder stays', async () => {
    const built = await setup();
    await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    const { info, result } = await dispatchUnattended({
      built,
      name: 'cancel_reminder',
      args: { reminder: 'Take the medicine' },
    });
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(info.tier3_card?.plain_what).toBe(
      'Cancel the reminder "Take the medicine", set for Monday, October 19 at 6:00 PM?',
    );
    expect(resultText(result)).toBe(HELD_RESULT_TEXT);
    expect(await built.listAll()).toHaveLength(1);
  });

  it('holds a pause and a resume: the card names the schedule, and its state stays', async () => {
    const built = await setup();
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });
    const paused = await dispatchUnattended({ built, name: 'pause_schedule', args: { schedule: 'morning-brief' } });
    expect(paused.info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(paused.info.tier3_card?.plain_what).toBe(
      'Pause the schedule "Morning brief"? It runs every weekday at 8:00 AM (America/New_York) and will not run again until it is resumed.',
    );
    expect(resultText(paused.result)).toBe(HELD_RESULT_TEXT);
    expect((await built.listAll())[0]?.status).toBe('active');

    await dispatch({
      built,
      name: 'pause_schedule',
      args: { schedule: 'morning-brief' },
      decision: { status: 'allow' },
    });
    const resumed = await dispatchUnattended({ built, name: 'resume_schedule', args: { schedule: 'morning-brief' } });
    expect(resumed.info.tier3_card?.plain_what).toBe(
      'Resume the schedule "Morning brief"? It runs every weekday at 8:00 AM (America/New_York) and starts again as soon as you approve.',
    );
    expect((await built.listAll())[0]?.status).toBe('paused');
  });

  it('does not let a held pause reach a different schedule that took the name before the owner approved', async () => {
    const built = await setup();
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });
    const pause = { name: 'pause_schedule', args: { schedule: 'morning-brief' } };
    const held = await dispatchUnattended({ built, ...pause });
    const scope = { tenant_id: 'default', created_by: OWNER.subject_id };
    const check = async () =>
      checkHeldReplay({
        held: { ...held.info, held_for_owner: { expires_at: new Date(Date.now() + 60_000).toISOString() } },
        fresh: await built.tools.toolCallInfo({ name: pause.name, arguments: pause.args }),
        tokens: built.sentinel.services.token_store,
        scope,
      });
    expect(await check()).toMatchObject({ ok: true });

    const [first] = await built.listAll();
    await built.store.deleteSchedule({ tenant_id: 'default', id: first?.id ?? '' });
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });
    expect(await check()).toEqual({ ok: false, reason: 'changed' });
  });

  it('still lists schedules and reminders without asking', async () => {
    const built = await setup();
    await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    const schedules = await dispatchUnattended({ built, name: 'list_schedules', args: {} });
    const reminders = await dispatchUnattended({ built, name: 'list_reminders', args: {} });
    expect(schedules.info).toMatchObject({ tier: 1, is_approval_required: false });
    expect(reminders.info).toMatchObject({ tier: 1, is_approval_required: false });
    expect(JSON.parse(resultText(reminders.result)).reminders).toHaveLength(1);
  });

  it('runs the held reminder once the owner approves it in the chat', async () => {
    const built = await setup();
    await dispatchUnattended({ built, name: 'set_reminder', args: MEDICINE });
    // Approving replays the same call in the chat the owner is in, where it is classified again.
    const { info } = await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    expect(info).toMatchObject({ tier: 1, is_approval_required: false });
    expect(await built.listAll()).toHaveLength(1);
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
        : said.includes('The person said no to this.')
          ? 'Do the first small step now. No check-in, as you asked.'
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
    parent: undefined,
    agentInfo: undefined,
    context: undefined,
    currentContextUsage: undefined,
    preComputedCompletion: undefined,
    sandbox: undefined,
    capabilities: [scheduleCapability(built.options)],
    capabilityState: undefined,
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
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
  const events: unknown[] = [];
  const run = async (sendBatch: AgentThreadSendBatch) => {
    for await (const _event of orchestrator.send(sendBatch)) {
      void _event;
    }
    const iterator = orchestrator.execute({ signal: new AbortController().signal });
    let step = await iterator.next();
    while (step.done !== true) {
      events.push(step.value);
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
  return { built, card, answer, events };
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
    const { built, answer, events } = await tourChat();

    const done = await answer({ status: 'deny', reason: approvalExpiredReason() });

    expect(await built.listAll()).toEqual([]);
    // The model read the true reason and said it in its own words; the host added nothing.
    expect(done.output?.content).toBe(
      'Do the first small step now. The check-in request expired before you answered, so it is not set.',
    );
    expect(done.output?.content).not.toMatch(SAID_NO);
    // The activity log does not record the person turning it down either.
    expect(built.audit).toContainEqual(
      expect.objectContaining({
        tool_name: 'create_schedule',
        outcome: 'auto_denied',
        auto_deny_reason: 'approval_expired',
      }),
    );
    // The chat's step reads the result's code, so it shows the card expired rather than "you said no".
    expect(events).toContainEqual(
      expect.objectContaining({
        type: EventType.TOOL_RESPONSE_V2,
        disposition: 'denied',
        remediation: expect.objectContaining({ reason_code: 'approval_expired' }),
      }),
    );
  });

  it("lets the reply acknowledge the person's own decline once, with no extra line", async () => {
    const { built, answer } = await tourChat();

    const done = await answer({ status: 'deny', reason: 'not now' });

    expect(await built.listAll()).toEqual([]);
    expect(done.output?.content).toBe('Do the first small step now. No check-in, as you asked.');
    expect(built.audit).toContainEqual(expect.objectContaining({ tool_name: 'create_schedule', outcome: 'denied' }));
  });
});

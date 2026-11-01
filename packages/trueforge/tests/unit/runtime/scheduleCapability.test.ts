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
import { createToolCallMemoState, executeToolCalls } from '@truefoundry/trueforge-core/core/mcp/executeToolCalls';
import { isCallToolResponseResult } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { approvalExpiredReason } from '@truefoundry/trueforge-core/core/permissions/approvalExpiry';
import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import winston from 'winston';
import { usableAgentByName } from '../../../src/apis/agentAccess';
import { TrueForgeAuthorizer, type Authorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
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
  agent: 'researcher',
  task: 'Give me a morning brief: my calendar for today and important unread mail.',
  repeat: 'weekdays',
  time: '08:00',
};

/** A plain chat's own setup: no saved agent, just the model and instructions the person chose. */
const CHAT_SPEC = AgentSpecSchema.parse({ model: { name: 'test-provider/chat-model' }, instructions: 'chat' });

async function setup(
  input: {
    timeZone?: string | undefined;
    /** Names of saved agents the owner is not allowed to use. */
    forbidden?: readonly string[];
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
  const briefAgent = await agentStore.createAgent({
    host_managed: false,
    tenant_id: 'default',
    created_by_subject: OWNER,
    name: 'brief-agent',
    description: 'Reads mail and calendar.',
    manifest: AgentSpecSchema.parse({
      model: { name: 'test-provider/test-model' },
      instructions: 'brief',
      mcp_servers: [{ name: 'calendar' }, { name: 'mail' }],
    }),
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
  const runner: ChatRunner =
    input.runner === 'saved' ? { kind: 'saved', agent: researcher } : { kind: 'plain', spec: input.spec ?? CHAT_SPEC };
  const authorizer: Authorizer = {
    listAgentAccess: () => new TrueForgeAuthorizer().listAgentAccess(),
    canAccessAgent: async access =>
      !(input.forbidden ?? []).includes(access.agent.name) && new TrueForgeAuthorizer().canAccessAgent(access),
    getPermissions: access => new TrueForgeAuthorizer().getPermissions(access),
  };
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
    chatAssistant: resolveChatAssistant({ tenant_id: 'default', owner: OWNER, runner, persona, agentStore }),
    usableAgent: name =>
      usableAgentByName({ store: agentStore, authorizer, context: STANDALONE_REQUEST_CONTEXT, name }),
    runsAs: scheduleRunsAs({ tenant_id: 'default', personaStore }),
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
  return { tools, options, sentinel, store, agentStore, researcher, briefAgent, listAll, audit };
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
  it('shows a card first, then on approval saves an active schedule bound to the named saved agent', async () => {
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
      runs_as: 'researcher',
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
      agent_id: built.researcher.id,
      agent_name: 'researcher',
      persona_id: null,
      status: 'active',
      created_by_subject: OWNER,
      manifest: { task: MORNING_BRIEF.task, cron: '0 8 * * 1-5', timezone: 'America/New_York', status: 'active' },
    });
    const pending = await built.store.getScheduledRunFor({ tenant_id: 'default', schedule_id: saved?.id ?? '' });
    expect(pending?.scheduled_for).toBe('2026-10-19T12:00:00.000Z');
    expect(JSON.parse(resultText(result))).toMatchObject({ created: { runs_as: 'researcher' } });
  });

  it('makes no hidden agent for a task schedule, and leaves the saved agent as it was', async () => {
    const built = await setup();
    const before = await built.agentStore.getAgent({ tenant_id: 'default', name: 'brief-agent' });
    await dispatch({
      built,
      name: 'create_schedule',
      args: { ...MORNING_BRIEF, agent: 'brief-agent' },
      decision: { status: 'allow' },
    });
    const agents = await built.agentStore.listAgents({
      include_host_managed: true,
      tenant_id: 'default',
      agent_name: undefined,
      limit: undefined,
      page_token: undefined,
    });
    expect(agents.data.filter(agent => agent.host_managed)).toEqual([]);
    expect(agents.data.map(agent => agent.name).sort()).toEqual(['brief-agent', 'researcher']);
    expect(await built.agentStore.getAgent({ tenant_id: 'default', name: 'brief-agent' })).toEqual(before);
    expect((await built.listAll())[0]).toMatchObject({ agent_id: built.briefAgent.id, agent_name: 'brief-agent' });
  });

  it('binds to the named agent whatever agent or setup the chat itself runs on', async () => {
    for (const runner of ['plain', 'saved'] as const) {
      const built = await setup({ runner });
      await dispatch({
        built,
        name: 'create_schedule',
        args: { ...MORNING_BRIEF, agent: 'brief-agent' },
        decision: { status: 'allow' },
      });
      expect((await built.listAll())[0]).toMatchObject({ agent_name: 'brief-agent' });
    }
  });

  it('keeps the persona the chat is talking to, and names it on the card instead of the agent', async () => {
    const built = await setup({ persona: true });
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: MORNING_BRIEF });
    expect(info.tier3_card?.schedule?.runs_as).toBe('Zara');
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });
    expect((await built.listAll())[0]).toMatchObject({ persona_id: 'persona-zara', agent_name: 'researcher' });
    const { result } = await dispatch({ built, name: 'list_schedules', args: {} });
    expect(JSON.parse(resultText(result))).toMatchObject({ schedules: [{ runs_as: 'Zara' }] });
  });

  it('lists a schedule as the agent it runs as when the chat has no persona', async () => {
    const built = await setup();
    await dispatch({ built, name: 'create_schedule', args: MORNING_BRIEF, decision: { status: 'allow' } });
    const { result } = await dispatch({ built, name: 'list_schedules', args: {} });
    expect(JSON.parse(resultText(result))).toMatchObject({ schedules: [{ runs_as: 'researcher' }] });
  });

  it('refuses an agent that does not exist, with a plain message that says what to do', async () => {
    const built = await setup();
    const args = { ...MORNING_BRIEF, agent: 'ghost' };
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: args });
    expect(info.tier3_card).toBeUndefined();
    expect(info.pre_dispatch_failure?.message).toBe(
      'Nothing was saved because there is no agent named ghost you can use. Call create_agent to make one, or ask the user which agent to use.',
    );
    const { result } = await dispatch({ built, name: 'create_schedule', args, decision: { status: 'allow' } });
    expect(resultText(result)).toContain('there is no agent named ghost you can use');
    expect(await built.listAll()).toEqual([]);
  });

  it('refuses an agent the owner may not use with the same message, so it never says the agent exists', async () => {
    const built = await setup({ forbidden: ['brief-agent'] });
    const args = { ...MORNING_BRIEF, agent: 'brief-agent' };
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: args });
    expect(info.tier3_card).toBeUndefined();
    expect(info.pre_dispatch_failure?.message).toBe(
      'Nothing was saved because there is no agent named brief-agent you can use. Call create_agent to make one, or ask the user which agent to use.',
    );
    await dispatch({ built, name: 'create_schedule', args, decision: { status: 'allow' } });
    expect(await built.listAll()).toEqual([]);
  });

  it('requires an agent: a call without one is a fixable error', async () => {
    const built = await setup();
    const { agent: _agent, ...withoutAgent } = MORNING_BRIEF;
    const info = await built.tools.toolCallInfo({ name: 'create_schedule', arguments: withoutAgent });
    expect(info.tier3_card).toBeUndefined();
    expect(info.pre_dispatch_failure?.message).toContain('agent:');
    expect(info.pre_dispatch_failure?.message).toContain('Fix this and try again.');
  });

  it('offers an agent field the model must fill, described in plain words', async () => {
    const built = await setup();
    const { result } = await built.tools.listTools();
    const create = result.tools.find(tool => tool.name === 'create_schedule');
    expect(create?.inputSchema.required).toContain('agent');
    expect(JSON.stringify(create?.inputSchema.properties?.['agent'])).toContain(
      'Name of a saved agent to run this schedule as. Make one with create_agent first if none fits.',
    );
  });

  it('ends the approval when the agent behind the name changed after the card', async () => {
    const built = await setup();
    const first = await built.tools.liveMintParams({ name: 'create_schedule', arguments: MORNING_BRIEF });
    await built.agentStore.deleteAgent({ tenant_id: 'default', id: built.researcher.id });
    await built.agentStore.createAgent({
      host_managed: false,
      tenant_id: 'default',
      created_by_subject: OWNER,
      name: 'researcher',
      description: 'Another agent with the same name.',
      manifest: CHAT_SPEC,
      external_id: null,
    });
    const second = await built.tools.liveMintParams({ name: 'create_schedule', arguments: MORNING_BRIEF });
    expect(first).toMatchObject({ resolved_runs_as: `agent:${built.researcher.id}|persona:none` });
    expect(second?.['resolved_runs_as']).not.toBe(first?.['resolved_runs_as']);
  });

  it('ends the approval when the chat switches persona after the card', async () => {
    const plain = await setup();
    const withPersona = await setup({ persona: true });
    const first = await plain.tools.liveMintParams({ name: 'create_schedule', arguments: MORNING_BRIEF });
    const second = await withPersona.tools.liveMintParams({ name: 'create_schedule', arguments: MORNING_BRIEF });
    expect(second).toMatchObject({ resolved_runs_as: expect.stringMatching(/\|persona:persona-zara$/) });
    expect(first?.['resolved_runs_as']).not.toBe(second?.['resolved_runs_as']);
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
    const brief = {
      name: 'morning-brief',
      agent: 'brief-agent',
      morning_brief: true,
      repeat: 'weekdays',
      time: '08:00',
    };
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
      arguments: { name: 'morning-brief', agent: 'researcher', repeat: 'weekdays', time: '08:00' },
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

describe('list, pause, resume and delete for a schedule made in chat', () => {
  const runsAs = 'researcher';

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
        'Create the schedule "Morning brief"? It runs every weekday at 8:00 AM (America/New_York) and starts as soon as you approve.',
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
  it('tells the model a schedule runs as a saved agent, and that create_schedule is the only way to schedule', async () => {
    const built = await setup();
    const prompt = InstructionBuilder.createSystemPrompt('test');
    for (const build of scheduleCapability(built.options).instructionBuilders ?? []) {
      build(prompt);
    }
    expect(prompt.build()).toContain(
      'Repeating tasks need create_schedule. A schedule runs as a saved agent. If none fits, make one with create_agent first. A morning brief should use an agent with the connectors the brief needs. For "remind me" use set_reminder: it only reaches the user and needs no approval. Never say something is scheduled or set unless create_schedule or set_reminder succeeded in this chat.',
    );
  });
});

const MEDICINE = { what: 'Take the medicine', at: '2026-10-19T18:00:00-04:00' };

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
      },
    });
    const pending = await built.store.getScheduledRunFor({ tenant_id: 'default', schedule_id: saved?.id ?? '' });
    expect(pending?.scheduled_for).toBe('2026-10-19T22:00:00.000Z');
    expect(built.audit.map(row => [row.tool_name, row.description, row.outcome])).toEqual([
      ['set_reminder', 'Set a reminder for Monday, October 19 at 6:00 PM: Take the medicine', 'ran'],
    ]);
  });

  it("still binds a reminder to the chat's hidden agent, and makes no card for it", async () => {
    const built = await setup();
    await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    const [saved] = await built.listAll();
    const hidden = await built.agentStore.getAgent({ tenant_id: 'default', id: saved?.agent_id ?? '' });
    expect(hidden).toMatchObject({ host_managed: true, description: CHAT_ASSISTANT_DESCRIPTION, manifest: CHAT_SPEC });
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

  it('lists upcoming reminders apart from schedules, and cancels one by id without asking', async () => {
    const built = await setup();
    await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    const schedules = await dispatch({ built, name: 'list_schedules', args: {} });
    expect(JSON.parse(resultText(schedules.result))).toEqual({ schedules: [] });

    const listed = await dispatch({ built, name: 'list_reminders', args: {} });
    expect(listed.info).toMatchObject({ tier: 1, tier_reason: 'reminder_read', is_approval_required: false });
    const { reminders } = JSON.parse(resultText(listed.result));
    expect(reminders).toHaveLength(1);

    const cancelled = await dispatch({ built, name: 'cancel_reminder', args: { reminder: reminders[0].id } });
    expect(cancelled.info).toMatchObject({ tier: 1, tier_reason: 'reminder_write', is_approval_required: false });
    expect(JSON.parse(resultText(cancelled.result))).toMatchObject({ cancelled: { what: 'Take the medicine' } });
    expect(await built.listAll()).toEqual([]);
  });

  it('cancels by the exact words, and says what to do when none matches', async () => {
    const built = await setup();
    await dispatch({ built, name: 'set_reminder', args: MEDICINE });
    const missing = await dispatch({ built, name: 'cancel_reminder', args: { reminder: 'Walk the dog' } });
    expect(resultText(missing.result)).toContain('Call list_reminders');
    await dispatch({ built, name: 'cancel_reminder', args: { reminder: 'take the medicine' } });
    expect(await built.listAll()).toEqual([]);
  });
});

/** The old Tour card: it promised a check-in in 25 minutes. */
const OLD_TOUR_PROMPT =
  "I can't get started. Pick the one smallest thing I should do right now, and check in with me in 25 minutes.";
/** What a model made of that prompt: the only schedule it can make is a repeating one. */
const CHECK_IN = {
  name: 'check-in',
  agent: 'researcher',
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

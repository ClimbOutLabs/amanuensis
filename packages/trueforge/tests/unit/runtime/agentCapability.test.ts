import { AgentSpecSchema, type AgentSpec, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  type SentinelServices,
} from '@truefoundry/trueforge-core/core';
import type { ApprovalDecision } from '@truefoundry/trueforge-core/core/events/schema';
import type { InternalEnrichedAssistantMessage } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '@truefoundry/trueforge-core/core/mcp/executeToolCalls';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { AgentToolSet } from '../../../src/runtime/agentCapability';
import type { ChatRunner } from '../../../src/runtime/chatAssistant';

const OWNER: CreatedBySubject = { subject_id: 'owner-1', subject_type: 'user', subject_display_name: 'Test Owner' };
const CHAT_MODEL = 'test-provider/chat-model';
const OTHER_MODEL = 'test-provider/other-model';

/** A plain chat's own setup: the model, the instructions and the one connector the person turned on. */
const CHAT_SPEC = AgentSpecSchema.parse({
  model: { name: CHAT_MODEL },
  instructions: 'Be brief.',
  mcp_servers: [{ name: 'calendar' }],
});

const MORNING_BRIEF = {
  name: 'morning-brief',
  description: 'Reads my calendar each morning.',
};

async function setup(input: { runner?: ChatRunner; forbidden?: readonly string[] } = {}) {
  const { forbidden } = input;
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const modelProviderStore = new SqliteModelProviderStore(db);
  await modelProviderStore.upsertProvider({
    tenant_id: 'default',
    name: 'test-provider',
    manifest: {
      type: 'custom',
      name: 'test-provider',
      base_url: 'https://llm.test.example.com/v1',
      auth: { api_key: 'sk-test' },
      models: ['chat-model', 'other-model'].map(name => ({
        model_id: name,
        name,
        properties: { context_length: 128000, max_output_tokens: 4096 },
      })),
    },
  });
  const mcpServerStore = new SqliteMcpServerStore(db);
  for (const name of ['calendar', 'mail']) {
    await mcpServerStore.createServer({
      tenant_id: 'default',
      name,
      first_party: false,
      manifest: { type: 'remote', name, url: `https://${name}.example.com/mcp`, description: `The ${name}.` },
    });
  }
  const agentStore = new SqliteAgentStore(db);
  const skillStore = new SqliteSkillStore(db);
  const sandboxProviderStore = new SqliteSandboxProviderStore(db);
  const runner: ChatRunner = input.runner ?? { kind: 'plain', spec: CHAT_SPEC };
  const services: SentinelServices = { ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }) };
  const sentinel = createSentinelHostContext({
    services,
    tenant_id: 'default',
    created_by: OWNER.subject_id,
    conversation_id: 'chat-1',
  });
  const listAll = async () =>
    (
      await agentStore.listAgents({
        tenant_id: 'default',
        agent_name: undefined,
        include_host_managed: true,
        limit: undefined,
        page_token: undefined,
      })
    ).data;
  const tools = new AgentToolSet({
    tracing: NOOP_AGENT_TRACING,
    agentStore,
    modelProviderStore,
    mcpServerStore,
    skillStore,
    sandboxProviderStore,
    mcpCatalog: new McpCatalog([]),
    tenant_id: 'default',
    owner: OWNER,
    runner,
    listUsableAgents: async () => (await listAll()).filter(agent => !(forbidden ?? []).includes(agent.name)),
    sentinel,
  });
  return { tools, sentinel, agentStore, listAll };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Classifies a call as the chat would, then dispatches it with the user's answer (none when nobody answered). */
async function dispatch(input: {
  built: Setup;
  args: Record<string, unknown>;
  name?: string | undefined;
  decision?: ApprovalDecision | undefined;
}) {
  const { tools, sentinel } = input.built;
  const name = input.name ?? 'create_agent';
  const info = await tools.toolCallInfo({ name, arguments: input.args });
  const message: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name, arguments: JSON.stringify(input.args) },
        tool_info: info,
      },
    ],
  };
  const result = await executeToolCalls({
    assistantMessage: message,
    toolMapping: new Map([[name, { toolSet: tools, originalToolName: name }]]),
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

describe('create_agent', () => {
  it('shows one card with the whole agent, then saves it on approval', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({ name: 'create_agent', arguments: MORNING_BRIEF });
    expect(info).toMatchObject({ tier: 3, tier_reason: 'agent_write', is_approval_required: true });
    expect(info.tier3_card?.plain_what).toBe('Save an agent: morning-brief? Reads my calendar each morning.');
    expect(info.tier3_card?.agent).toEqual({
      name: 'morning-brief',
      description: MORNING_BRIEF.description,
      instructions: 'Be brief.',
      model_name: CHAT_MODEL,
      connectors: ['calendar'],
      skills: [],
      sandbox_enabled: false,
    });
    expect(await built.listAll()).toEqual([]);

    const { result } = await dispatch({ built, args: MORNING_BRIEF, decision: { status: 'allow' } });
    const [saved] = await built.listAll();
    expect(saved).toMatchObject({
      name: 'morning-brief',
      description: MORNING_BRIEF.description,
      external_id: null,
      host_managed: false,
      created_by_subject: OWNER,
    });
    expect(JSON.parse(resultText(result))).toEqual({
      created: {
        id: saved?.id,
        name: 'morning-brief',
        description: MORNING_BRIEF.description,
        model_name: CHAT_MODEL,
        connectors: ['calendar'],
        skills: [],
        sandbox_enabled: false,
      },
    });
  });

  it('saves nothing without approval, whether denied or called directly', async () => {
    const built = await setup();
    await dispatch({ built, args: MORNING_BRIEF, decision: { status: 'deny' } });
    const { result } = await dispatch({ built, args: MORNING_BRIEF });
    expect(resultText(result)).toContain('has not approved');
    expect(await built.listAll()).toEqual([]);
  });

  it('starts from the setup of the saved agent the chat runs on', async () => {
    const runner: ChatRunner = {
      kind: 'saved',
      agent: {
        id: 'agent-1',
        tenant_id: 'default',
        name: 'researcher',
        description: 'Researches.',
        manifest: AgentSpecSchema.parse({
          model: { name: OTHER_MODEL },
          instructions: 'Dig deep.',
          mcp_servers: [{ name: 'mail' }],
        }),
        external_id: null,
        host_managed: false,
        created_by_subject: OWNER,
        created_at: '2026-10-18T12:00:00.000Z',
        updated_at: '2026-10-18T12:00:00.000Z',
      },
    };
    const built = await setup({ runner });
    const info = await built.tools.toolCallInfo({ name: 'create_agent', arguments: MORNING_BRIEF });
    expect(info.tier3_card?.agent).toMatchObject({
      instructions: 'Dig deep.',
      model_name: OTHER_MODEL,
      connectors: ['mail'],
    });
  });

  it('applies only what the call names and keeps the rest of the chat setup', async () => {
    const built = await setup();
    const args = { ...MORNING_BRIEF, instructions: 'Sum up the day in five lines.', model: OTHER_MODEL };
    const info = await built.tools.toolCallInfo({ name: 'create_agent', arguments: args });
    expect(info.tier3_card?.agent).toMatchObject({
      instructions: 'Sum up the day in five lines.',
      model_name: OTHER_MODEL,
      connectors: ['calendar'],
      skills: [],
      sandbox_enabled: false,
    });
    await dispatch({ built, args, decision: { status: 'allow' } });
    const [saved] = await built.listAll();
    expect(saved?.manifest).toMatchObject({
      model: { name: OTHER_MODEL },
      instructions: 'Sum up the day in five lines.',
      mcp_servers: [{ name: 'calendar' }],
    });
  });

  it('replaces the connectors when the call lists them, and clears them for an empty list', async () => {
    const built = await setup();
    const withMail = await built.tools.toolCallInfo({
      name: 'create_agent',
      arguments: { ...MORNING_BRIEF, connectors: ['calendar', 'mail'] },
    });
    expect(withMail.tier3_card?.agent?.connectors).toEqual(['calendar', 'mail']);
    const none = await built.tools.toolCallInfo({
      name: 'create_agent',
      arguments: { ...MORNING_BRIEF, connectors: [] },
    });
    expect(none.tier3_card?.agent?.connectors).toEqual([]);
  });

  it('refuses a connector that is not set up, in plain words that name the fix', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({
      name: 'create_agent',
      arguments: { ...MORNING_BRIEF, connectors: ['weather'] },
    });
    expect(info.pre_dispatch_failure?.message).toBe(
      'Nothing was saved because the connector weather is not set up. Pick one from Settings → Connectors.',
    );
    expect(info.tier3_card).toBeUndefined();

    const { result } = await dispatch({
      built,
      args: { ...MORNING_BRIEF, connectors: ['weather'] },
      decision: { status: 'allow' },
    });
    expect(resultText(result)).toContain('connector weather is not set up');
    expect(await built.listAll()).toEqual([]);
  });

  it('refuses a model that is not set up, in plain words that name the fix', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({
      name: 'create_agent',
      arguments: { ...MORNING_BRIEF, model: 'test-provider/missing' },
    });
    expect(info.pre_dispatch_failure?.message).toBe(
      'Nothing was saved because the model test-provider/missing is not set up. Pick one from Settings → Models.',
    );
  });

  it('refuses a skill that is not set up, in plain words that name the fix', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({
      name: 'create_agent',
      arguments: { ...MORNING_BRIEF, skills: ['pdf'], sandbox_enabled: true },
    });
    expect(info.pre_dispatch_failure?.message).toBe(
      'Nothing was saved because the skill pdf is not set up. Pick one from Settings → Skills.',
    );
  });

  it('refuses skills without the sandbox, whether the sandbox is turned off here or in the chat', async () => {
    const built = await setup();
    for (const args of [
      { ...MORNING_BRIEF, skills: ['pdf'], sandbox_enabled: false },
      { ...MORNING_BRIEF, skills: ['pdf'] },
    ]) {
      const info = await built.tools.toolCallInfo({ name: 'create_agent', arguments: args });
      expect(info.pre_dispatch_failure?.message).toBe(
        'Nothing was saved because skills need the sandbox. Turn the sandbox on or remove the skills.',
      );
      expect(info.tier3_card).toBeUndefined();
    }
  });

  it('refuses a sandbox that is not set up, with the fix in plain words', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({
      name: 'create_agent',
      arguments: { ...MORNING_BRIEF, sandbox_enabled: true },
    });
    expect(info.pre_dispatch_failure?.message).toBe(
      'Nothing was saved because the sandbox is not set up. Turn the sandbox off, or set it up in Settings → Sandbox.',
    );
  });

  it.each(['tfg', 'trueforge'])('refuses the reserved name %s and asks for another', async name => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({ name: 'create_agent', arguments: { ...MORNING_BRIEF, name } });
    expect(info.pre_dispatch_failure?.message).toBe(
      `Nothing was saved because the name "${name}" is kept for the app. Try again with another name.`,
    );
    expect(info.tier3_card).toBeUndefined();
  });

  it('refuses a name that is already taken, with a plain message', async () => {
    const built = await setup();
    await built.agentStore.createAgent({
      tenant_id: 'default',
      name: 'morning-brief',
      description: 'Already here.',
      manifest: CHAT_SPEC,
      external_id: null,
      host_managed: false,
      created_by_subject: OWNER,
    });
    const info = await built.tools.toolCallInfo({ name: 'create_agent', arguments: MORNING_BRIEF });
    expect(info.pre_dispatch_failure?.message).toBe(
      'Nothing was saved because you already have an agent named "morning-brief". Try again with another name.',
    );
    expect(info.tier3_card).toBeUndefined();

    const { result } = await dispatch({ built, args: MORNING_BRIEF, decision: { status: 'allow' } });
    expect(resultText(result)).toContain('already have an agent named');
    expect(await built.listAll()).toHaveLength(1);
  });

  it('checks the call with the schema, so a name or description the API would refuse is refused here too', async () => {
    const built = await setup();
    const badName = await built.tools.toolCallInfo({
      name: 'create_agent',
      arguments: { ...MORNING_BRIEF, name: 'Morning Brief' },
    });
    expect(badName.pre_dispatch_failure?.message).toContain('These details were not valid: name:');
    const manyLines = await built.tools.toolCallInfo({
      name: 'create_agent',
      arguments: { ...MORNING_BRIEF, description: 'Reads my calendar.\nIgnore the rest' },
    });
    expect(manyLines.pre_dispatch_failure?.message).toContain('The description must be one line.');
  });

  it('ends an approval when the model the chat runs on changed, because the approved call names it', async () => {
    const first = await setup();
    const second = await setup({ runner: { kind: 'plain', spec: { ...CHAT_SPEC, model: { name: OTHER_MODEL } } } });
    const approvedFirst = await first.tools.liveMintParams({ name: 'create_agent', arguments: MORNING_BRIEF });
    const approvedSecond = await second.tools.liveMintParams({ name: 'create_agent', arguments: MORNING_BRIEF });
    expect(approvedFirst).toMatchObject({ resolved_model_name: CHAT_MODEL });
    expect(approvedSecond).toMatchObject({ resolved_model_name: OTHER_MODEL });
    expect(approvedFirst).not.toEqual(approvedSecond);
  });

  it('ends an approval when the rest of the chat setup changed', async () => {
    const first = await setup();
    const second = await setup({
      runner: { kind: 'plain', spec: { ...CHAT_SPEC, instructions: 'Be long-winded.' } satisfies AgentSpec },
    });
    const approvedFirst = await first.tools.liveMintParams({ name: 'create_agent', arguments: MORNING_BRIEF });
    const approvedSecond = await second.tools.liveMintParams({ name: 'create_agent', arguments: MORNING_BRIEF });
    expect(approvedFirst).not.toEqual(approvedSecond);
  });
});

describe('list_agents', () => {
  const saved = (name: string, spec: AgentSpec, description = 'Test agent.') => ({
    tenant_id: 'default',
    name,
    description,
    manifest: spec,
    external_id: null,
    host_managed: false,
    created_by_subject: OWNER,
  });

  it('lists each usable agent by name, description, model, connectors, skills and sandbox, with no card', async () => {
    const built = await setup();
    await built.agentStore.createAgent(saved('researcher', CHAT_SPEC, 'Researches things.'));
    await built.agentStore.createAgent(
      saved('mailer', AgentSpecSchema.parse({ model: { name: OTHER_MODEL }, mcp_servers: [{ name: 'mail' }] })),
    );
    const { info, result } = await dispatch({ built, args: {}, name: 'list_agents' });
    expect(info).toMatchObject({ tier: 1, is_approval_required: false });
    expect(info.tier3_card).toBeUndefined();
    const { agents } = JSON.parse(resultText(result));
    expect(agents).toEqual(
      expect.arrayContaining([
        {
          name: 'researcher',
          description: 'Researches things.',
          model_name: CHAT_MODEL,
          connectors: ['calendar'],
          skills: [],
          sandbox_enabled: false,
        },
        {
          name: 'mailer',
          description: 'Test agent.',
          model_name: OTHER_MODEL,
          connectors: ['mail'],
          skills: [],
          sandbox_enabled: false,
        },
      ]),
    );
    expect(agents).toHaveLength(2);
  });

  it('leaves out agents the owner may not use', async () => {
    const built = await setup({ forbidden: ['secret'] });
    await built.agentStore.createAgent(saved('secret', CHAT_SPEC));
    await built.agentStore.createAgent(saved('shared', CHAT_SPEC));
    const { result } = await dispatch({ built, args: {}, name: 'list_agents' });
    expect(JSON.parse(resultText(result)).agents.map((agent: { name: string }) => agent.name)).toEqual(['shared']);
  });

  it('returns an empty list when there are no agents, and refuses any arguments', async () => {
    const built = await setup();
    const { result } = await dispatch({ built, args: {}, name: 'list_agents' });
    expect(JSON.parse(resultText(result))).toEqual({ agents: [] });
    const { result: extra } = await dispatch({ built, args: { name: 'x' }, name: 'list_agents' });
    expect(extra.toolCallResults[0]?.message.content).not.toContain('"agents"');
  });
});

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AgentSpec, CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type {
  AgentCapability,
  AgentTracing,
  InstructionBuilder,
  SentinelHostContext,
  Tier3Agent,
} from '@truefoundry/trueforge-core/core';
import { classifyHostToolCall, defineTool, LocalToolMCP, type ToolDefinition } from '@truefoundry/trueforge-core/core';
import {
  AGENT_SERVER_ID,
  CREATE_AGENT_TOOL_NAME,
  isAgentWriteToolName,
  LIST_AGENTS_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/agents/toolContract';
import type { ApprovalDecision } from '@truefoundry/trueforge-core/core/events/schema';
import { stampSentinelDecision } from '@truefoundry/trueforge-core/core/mcp/ToolSet';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { McpCatalog } from '../catalog/McpCatalog';
import { AgentNameConflictError, type AgentRecord, type IAgentStore } from '../db/agentStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { ISkillStore } from '../db/skillStore';
import { isReservedAgentName } from '../schemas/agent';
import { NameSchema } from '../schemas/common';
import type { ChatRunner } from './chatAssistant';
import { specWithTools } from './scheduleTools';
import { validateAgentSpec } from './sessionResources';
import { errorResult, jsonResult, plainIssues } from './toolResults';

/** A description is one line in the card. */
const CARD_DESCRIPTION_MAX_LENGTH = 160;

export const CreateAgentToolSchema = z
  .object({
    name: NameSchema,
    description: z
      .string()
      .trim()
      .min(1)
      .max(CARD_DESCRIPTION_MAX_LENGTH)
      .refine(value => !/[\r\n]/.test(value), 'The description must be one line.')
      .describe('One line on what the agent is for.'),
    instructions: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("What the agent focuses on and how it works. Leave out to use this chat's instructions."),
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Model as provider/model. Leave out to use the model this chat runs on.'),
    connectors: z
      .array(z.string().trim().min(1))
      .max(100)
      .optional()
      .describe("Names of the connectors it can use. Leave out to use this chat's connectors."),
    skills: z
      .array(z.string().trim().min(1))
      .max(50)
      .optional()
      .describe("Names of the skills it can use. Leave out to use this chat's skills."),
    sandbox_enabled: z
      .boolean()
      .optional()
      .describe("Whether it can use the sandbox. Skills need the sandbox. Leave out to use this chat's setting."),
  })
  .strict();

export type CreateAgentToolInput = z.infer<typeof CreateAgentToolSchema>;

const ListAgentsToolSchema = z.object({}).strict();

/** What the agent tool needs from the host for one chat turn. */
export interface AgentTurnContext {
  agentStore: IAgentStore;
  modelProviderStore: IModelProviderStore;
  mcpServerStore: IMcpServerStore;
  skillStore: ISkillStore;
  sandboxProviderStore: ISandboxProviderStore;
  mcpCatalog: McpCatalog;
  tenant_id: string;
  /** The person in the chat; the agent is saved as theirs. */
  owner: CreatedBySubject;
  /** What runs the chat; a new agent starts from its setup and changes only what the call names. */
  runner: ChatRunner;
  /** Every saved agent the owner may use. */
  listUsableAgents: () => Promise<AgentRecord[]>;
}

interface AgentToolSetOptions extends AgentTurnContext {
  tracing: AgentTracing;
  sentinel: SentinelHostContext;
}

type Prepared<T> = { ok: true; value: T } | { ok: false; message: string };

interface PreparedCreate {
  approved: Record<string, unknown>;
  spec: AgentSpec;
  description: string;
  name: string;
}

/** The card shows the exact setup that would be saved. */
function agentReview({ name, description, spec }: PreparedCreate): Tier3Agent {
  return {
    name,
    description,
    instructions: spec.instructions ?? '',
    model_name: spec.model.name,
    connectors: (spec.mcp_servers ?? []).map(server => server.name),
    skills: (spec.skills ?? []).map(skill => skill.name),
    sandbox_enabled: spec.config.sandbox.enabled,
  };
}

const NOT_APPROVED = 'Nothing was saved because the user has not approved it. Ask again if they still want it.';

const SKILLS_NEED_SANDBOX =
  'Nothing was saved because skills need the sandbox. Turn the sandbox on or remove the skills.';

/** The setup a new agent starts from: the chat's saved agent, or the chat's own setup. */
function chatSpec(runner: ChatRunner): AgentSpec {
  return runner.kind === 'plain' ? runner.spec : runner.agent.manifest;
}

/** Matches the message text of `validateAgentSpec` and its stores; it must follow if those strings change. */
function plainSaveProblem(error: HTTPException): string {
  const message = error.message;
  const connector = /^Unknown MCP server "(.+)" — not configured$/.exec(message)?.[1];
  if (connector !== undefined) {
    return `Nothing was saved because the connector ${connector} is not set up. Pick one from Settings → Connectors.`;
  }
  const skill = /^Unknown skill "(.+)" — not configured$/.exec(message)?.[1];
  if (skill !== undefined) {
    return `Nothing was saved because the skill ${skill} is not set up. Pick one from Settings → Skills.`;
  }
  const model = /^Unknown model "(.+)" — /.exec(message)?.[1] ?? /^Model name must be .*: (.+)$/.exec(message)?.[1];
  if (model !== undefined) {
    return `Nothing was saved because the model ${model} is not set up. Pick one from Settings → Models.`;
  }
  if (/sandbox/i.test(message)) {
    return 'Nothing was saved because the sandbox is not set up. Turn the sandbox off, or set it up in Settings → Sandbox.';
  }
  return `Nothing was saved because ${message}. Fix this and try again.`;
}

/**
 * Saves one agent for the person in this chat, and lists the ones they can use. It can only create: existing
 * agents are never edited or deleted here. Creating always shows a card first.
 */
export class AgentToolSet extends LocalToolMCP {
  readonly name = AGENT_SERVER_ID;
  readonly displayName = 'Agents';
  readonly #options: AgentToolSetOptions;
  readonly #tools: ToolDefinition[];

  constructor(options: AgentToolSetOptions) {
    super({ tracing: options.tracing });
    this.#options = options;
    this.#tools = [
      defineTool({
        name: CREATE_AGENT_TOOL_NAME,
        description:
          "Save a lasting agent the user can pick later, and that a schedule can run as: a name, a one-line description, and optionally instructions, a model, connectors, skills and the sandbox. Anything left out comes from this chat's setup. First tell the user in plain words which setup you propose, which is this chat's current one unless they asked for something else, and ask them to confirm or change it. Call this tool only after they answered. The user then approves a card showing exactly what will be saved. It cannot change or delete an existing agent.",
        schema: CreateAgentToolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: (input, approval) => this.#create({ input, approval }),
      }),
      defineTool({
        name: LIST_AGENTS_TOOL_NAME,
        description:
          'List the saved agents the user can use: each name, one-line description, model, connectors, skills and whether the sandbox is on. Call this before create_agent or before naming an agent in create_schedule, to see which already exist.',
        schema: ListAgentsToolSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        handler: () => this.#list(),
      }),
    ];
  }

  protected getTools(): ToolDefinition[] {
    return this.#tools;
  }

  /**
   * The host classifies every create. The card is built from the exact setup that would be saved, and the
   * approved call carries the model and the whole setup it was settled on, so a change needs a new approval.
   */
  override async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<Awaited<ReturnType<LocalToolMCP['toolCallInfo']>>> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    // A preview while the call streams in has no arguments yet: classifying it would only repeat side effects (an audit row, a live read).
    if (resolveUnderlyingTool === false) {
      return info;
    }
    const prepared = isAgentWriteToolName(params.name) ? await this.#prepareCreate(params.arguments ?? {}) : undefined;
    if (prepared !== undefined && !prepared.ok) {
      // Not a permission wall: the model can fix the call or ask the user.
      return { ...info, pre_dispatch_failure: { kind: 'pre_dispatch_failed', message: prepared.message } };
    }
    const approved = prepared?.value.approved ?? params.arguments ?? {};
    const decision = await classifyHostToolCall({
      sentinel: this.#options.sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: {
        tool_name: params.name,
        canonical_params: approved,
        tool_type: 'truefoundry-system',
        mcp_server_name: AGENT_SERVER_ID,
        mcp_hints: {
          read_only_hint: info.read_only_hint,
          destructive_hint: info.destructive_hint,
          open_world_hint: info.open_world_hint,
        },
        ...(prepared === undefined ? {} : { agent_write: agentReview(prepared.value) }),
      },
    });
    return {
      ...info,
      ...stampSentinelDecision({ decision }),
      mint_canonical_params: approved,
    };
  }

  /** Re-settles a create at dispatch, so an approval ends when what it covered changed. */
  async liveMintParams(params: CallToolRequest['params']): Promise<Record<string, unknown> | undefined> {
    if (!isAgentWriteToolName(params.name)) {
      return undefined;
    }
    const prepared = await this.#prepareCreate(params.arguments ?? {});
    if (!prepared.ok) {
      throw new Error(prepared.message);
    }
    return prepared.value.approved;
  }

  /**
   * Builds the agent from the chat's setup and the call, and checks it the way the agents API does, so a card
   * is never shown for an agent that cannot be saved. The store repeats the name check on write.
   */
  async #prepareCreate(args: Record<string, unknown>): Promise<Prepared<PreparedCreate>> {
    const parsed = CreateAgentToolSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: `Nothing was saved. ${plainIssues(parsed.error)} Fix this and try again.` };
    }
    const input = parsed.data;
    if (isReservedAgentName(input.name)) {
      return {
        ok: false,
        message: `Nothing was saved because the name "${input.name}" is kept for the app. Try again with another name.`,
      };
    }
    const taken = await this.#options.agentStore.getAgent({ tenant_id: this.#options.tenant_id, name: input.name });
    if (taken !== undefined) {
      return { ok: false, message: this.#duplicateMessage(input.name) };
    }
    const base = chatSpec(this.#options.runner);
    const connectors = input.connectors ?? (base.mcp_servers ?? []).map(server => server.name);
    const skills = input.skills ?? (base.skills ?? []).map(skill => skill.name);
    const sandbox_enabled = input.sandbox_enabled ?? base.config.sandbox.enabled;
    if (skills.length > 0 && !sandbox_enabled) {
      return { ok: false, message: SKILLS_NEED_SANDBOX };
    }
    // The model's own settings, such as reasoning effort, belong to the model they were chosen for.
    const model = input.model === undefined || input.model === base.model.name ? base.model : { name: input.model };
    const withTools = specWithTools({
      spec: { ...base, model, ...(input.instructions === undefined ? {} : { instructions: input.instructions }) },
      tools: { connectors, skills, sandbox_enabled },
    });
    if (!withTools.ok) {
      return { ok: false, message: `Nothing was saved. ${withTools.message}` };
    }
    const { spec } = withTools;
    try {
      await validateAgentSpec({
        spec,
        tenant_id: this.#options.tenant_id,
        modelProviderStore: this.#options.modelProviderStore,
        mcpServerStore: this.#options.mcpServerStore,
        skillStore: this.#options.skillStore,
        sandboxProviderStore: this.#options.sandboxProviderStore,
        searchProviderPresetNames: this.#options.mcpCatalog.searchProviderPresetNames(),
      });
    } catch (error) {
      if (error instanceof HTTPException) {
        return { ok: false, message: plainSaveProblem(error) };
      }
      throw error;
    }
    const setup = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
    return {
      ok: true,
      value: {
        approved: { ...args, resolved_model_name: spec.model.name, resolved_setup: setup },
        spec,
        description: input.description,
        name: input.name,
      },
    };
  }

  async #list() {
    const agents = await this.#options.listUsableAgents();
    return jsonResult({
      agents: agents.map(agent => ({
        name: agent.name,
        description: agent.description,
        model_name: agent.manifest.model.name,
        connectors: (agent.manifest.mcp_servers ?? []).map(server => server.name),
        skills: (agent.manifest.skills ?? []).map(skill => skill.name),
        sandbox_enabled: agent.manifest.config.sandbox.enabled,
      })),
    });
  }

  #duplicateMessage(name: string): string {
    return `Nothing was saved because you already have an agent named "${name}". Try again with another name.`;
  }

  async #create(input: { input: CreateAgentToolInput; approval: ApprovalDecision | undefined }) {
    if (input.approval?.status !== 'allow') {
      return errorResult(NOT_APPROVED);
    }
    const prepared = await this.#prepareCreate(input.input);
    if (!prepared.ok) {
      return errorResult(prepared.message);
    }
    const { spec, description, name } = prepared.value;
    try {
      const record = await this.#options.agentStore.createAgent({
        tenant_id: this.#options.tenant_id,
        name,
        description,
        manifest: spec,
        external_id: null,
        host_managed: false,
        created_by_subject: this.#options.owner,
      });
      return jsonResult({
        created: {
          id: record.id,
          name: record.name,
          description: record.description,
          model_name: record.manifest.model.name,
          connectors: (record.manifest.mcp_servers ?? []).map(server => server.name),
          skills: (record.manifest.skills ?? []).map(skill => skill.name),
          sandbox_enabled: record.manifest.config.sandbox.enabled,
        },
      });
    } catch (error) {
      if (error instanceof AgentNameConflictError) {
        return errorResult(this.#duplicateMessage(name));
      }
      throw error;
    }
  }
}

const AGENT_INSTRUCTION_SECTION = 'agents';
const AGENT_INSTRUCTION =
  "An agent is a saved setup the user can pick later: its model, instructions, connectors, skills and sandbox. Before making one, call list_agents to see which already exist. Before calling create_agent, say in plain words what you would save, which is this chat's current setup unless the user asked for something else, and ask them to confirm or change it. Call create_agent only after they answered. It shows the user a card to approve. Say an agent was saved only when create_agent succeeded. Never change or delete an agent from chat.";

function buildAgentInstruction(builder: InstructionBuilder): void {
  builder.addSection(AGENT_INSTRUCTION_SECTION, AGENT_INSTRUCTION);
}

/** Attaches the agent tool to one chat turn's root thread. */
export function agentCapability(options: AgentToolSetOptions): AgentCapability {
  return { systemToolSets: [new AgentToolSet(options)], instructionBuilders: [buildAgentInstruction] };
}

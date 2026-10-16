/** DB AgentSpec wire schema — FQN model names and skill refs (name + optional preload). */
import { z } from '@hono/zod-openapi';
import {
  DEFAULT_INDIVIDUAL_TOOL_TOKEN_THRESHOLD,
  DEFAULT_PREVIEW_NUMBER_OF_CHARACTERS,
  DEFAULT_TOTAL_TOOL_TOKEN_THRESHOLD,
} from '../../core/capabilities/builtins/LargeToolResponse';
import { ResponseFormatSchema } from '../../core/llm/responseFormat';
import {
  DEFAULT_DISABLE_TOOLS,
  DEFAULT_ENABLE_TOOLS,
  DEFAULT_PRELOAD_TOOLS,
  DEFAULT_REQUIRE_APPROVAL_FOR_TOOLS,
  REQUIRE_APPROVAL_TOOLS_SELECTOR_TAGS,
  TOOLS_SELECTOR_TAGS,
} from '../../core/mcp/toolSelectors';
import { SkillPromptModeSchema } from '../../core/sandbox/skills/constants';

export const DEFAULT_AGENT_CONFIG_ITERATION_LIMIT = 100;

// --- Model ---

const ModelParamsSchema = z
  .object({
    max_tokens: z.number().optional().describe('Maximum tokens to generate in the model response.'),
    temperature: z.number().optional().describe('Sampling temperature; higher values increase randomness.'),
    top_p: z.number().optional().describe('Nucleus sampling probability mass.'),
    top_k: z.number().optional().describe('Top-k sampling; keep only the k highest-probability tokens.'),
    parallel_tool_calls: z
      .boolean()
      .optional()
      .describe('Whether the model may emit multiple tool calls in one response.'),
    reasoning_effort: z.string().optional().describe('Provider-specific reasoning effort (e.g. low/medium/high).'),
  })
  .loose() // this ensures extra model params are allowed
  .describe(
    'Model call parameters passed through to the provider. Known keys are documented; extra keys are allowed and forwarded as-is.',
  )
  .openapi('ModelParams');

// Opaque runtime identifier; the hosting server owns naming conventions (e.g. provider/model).
const ModelSchema = z
  .object({
    name: z
      .string()
      .min(1, 'model.name must not be empty')
      .describe('Model FQN: `provider/model`, e.g. `openai/gpt-5.2`.'),
    params: ModelParamsSchema.optional(),
  })
  .openapi('Model');

// --- MCP servers ---

// Literal tool name (not a tag).
const LiteralToolSelectorSchema = z
  .string()
  .min(1)
  .refine(s => !s.startsWith('@'), { message: 'Invalid tool selector tag' });

// enable_tools / disable_tools / preload_tools: @all, @read-only, or a literal name.
const EnableToolSelectorSchema = z
  .union([z.enum(TOOLS_SELECTOR_TAGS), LiteralToolSelectorSchema])
  .openapi('MCPServerToolSelector');

// require_approval_for_tools: @all, @write, @destructive, @unclassified, or a literal name.
const RequireApprovalToolSelectorSchema = z
  .union([z.enum(REQUIRE_APPROVAL_TOOLS_SELECTOR_TAGS), LiteralToolSelectorSchema])
  .openapi('MCPServerApprovalToolSelector');

// `preload` defaults to false; use `preload_tools` to eagerly load specific tools when not fully preloading.
// Auth headers are not part of the spec — they come from the configured MCP server store.
const MCPServerRequestSchema = z
  .object({
    name: z
      .string()
      .min(1, 'mcp_servers[].name must not be empty')
      .describe('Name of a configured MCP server (Settings → Connectors).'),
    // Which tools to enable. Default: all tools.
    enable_tools: z
      .array(EnableToolSelectorSchema)
      .default(DEFAULT_ENABLE_TOOLS)
      .describe('Tools exposed to the agent: `@all`, `@read-only`, or literal tool names. Default: `["@all"]`.'),
    // Which tools to disable (subtracted from enable_tools). Default: none.
    disable_tools: z
      .array(EnableToolSelectorSchema)
      .default(DEFAULT_DISABLE_TOOLS)
      .describe('Tools subtracted from the enabled set. Default: none.'),
    // When the server is not fully preloaded (`preload: false`), which tools to
    // still preload into context. A non-empty list implies `preload: false`.
    preload_tools: z
      .array(EnableToolSelectorSchema)
      .default(DEFAULT_PRELOAD_TOOLS)
      .describe(
        'Tools loaded eagerly into context while the rest stay deferred. A non-empty list implies `preload: false`.',
      ),
    // Tools that require human approval before execution. Default: @write + @destructive + @unclassified
    // (fail-closed: a tool whose annotations do not establish it as read-only is gated).
    require_approval_for_tools: z
      .array(RequireApprovalToolSelectorSchema)
      .default(DEFAULT_REQUIRE_APPROVAL_FOR_TOOLS)
      .describe(
        'Tools that pause for human approval: `@all`, `@write`, `@destructive`, `@unclassified`, or literal names. Default: `["@write", "@destructive", "@unclassified"]`.',
      ),
    // Whether this server's tools are preloaded into context. Left unset, a server whose tool
    // count at initialise time is at or below MCP_AUTO_PRELOAD_MAX_TOOLS (toolSelectors.ts) is
    // preloaded automatically; above it, tools are discovered lazily and only `preload_tools`
    // stay eager. Explicit `true`/`false` always wins over auto-detection.
    preload: z
      .boolean()
      .optional()
      .describe(
        'When true, load all tool schemas upfront; when false, defer to list_tools/get_tool_info. ' +
          'Left unset, small connectors (a handful of tools) are preloaded automatically and larger ones stay deferred.',
      ),
  })
  .openapi('MCPServer');

// --- Runtime config ---

const InputTokensCompactionTriggerSchema = z
  .object({
    type: z.literal('input_tokens').describe('Trigger compaction when the estimated input reaches a token limit.'),
    value: z.number().int().positive().describe('Estimated input-token count that triggers compaction.'),
  })
  .strict()
  .openapi('InputTokensCompactionTrigger');

const CompactionSettingsSchema = z
  .object({
    enabled: z.boolean().default(true).describe('Summarize older history when context grows too large. Default: true.'),
    trigger: InputTokensCompactionTriggerSchema.optional(),
  })
  .strict()
  .describe(
    'Without an explicit trigger, compaction starts at 80% of the model context length, lowered so input plus the configured max output tokens fit (never below 4000), or at 50000 tokens when the context length is unknown.',
  )
  .openapi('CompactionConfig');

const LargeToolResponseSettingsSchema = z.object({
  enabled: z.boolean().default(true).describe('Offload oversized tool responses to a sandbox file. Default: true.'),
  individual_tool_response_token_threshold: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_INDIVIDUAL_TOOL_TOKEN_THRESHOLD)
    .describe(
      `Token threshold for a single tool response before offloading. Default: ${String(DEFAULT_INDIVIDUAL_TOOL_TOKEN_THRESHOLD)}.`,
    ),
  total_tool_response_token_threshold: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_TOTAL_TOOL_TOKEN_THRESHOLD)
    .describe(
      `Combined tool-response token threshold before offloading. Default: ${String(DEFAULT_TOTAL_TOOL_TOKEN_THRESHOLD)}.`,
    ),
  preview_number_of_characters: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_PREVIEW_NUMBER_OF_CHARACTERS)
    .describe(
      `Characters of preview kept in context after offloading. Default: ${String(DEFAULT_PREVIEW_NUMBER_OF_CHARACTERS)}.`,
    ),
});

const SandboxConfigSchema = z
  .object({
    enabled: z.boolean().describe('Give the agent a sandbox. Required for skills and Code Mode.'),
    file_downloads: z
      .boolean()
      .default(true)
      .describe('Allow downloading agent-produced files via the turn download endpoint. Default: true.'),
    skill_prompt_mode: SkillPromptModeSchema.default('advertise').describe(
      "How mounted skills are presented in the <skills> prompt section: 'advertise' lists name/description/path and the agent reads SKILL.md itself; 'inline' embeds preloaded SKILL.md content so the agent skips that read. Default: 'advertise'.",
    ),
  })
  .openapi('SandboxConfig');

const DynamicSubAgentsConfigSchema = z
  .object({
    enabled: z.boolean().default(true).describe('Allow the agent to spawn dynamic subagents. Default: true.'),
  })
  .openapi('DynamicSubAgentsConfig');

const LargeToolResponseConfigSchema = LargeToolResponseSettingsSchema.pick({
  enabled: true,
}).openapi('LargeToolResponseConfig');

const ContextManagementConfigSchema = z
  .object({
    compaction: CompactionSettingsSchema.default(() => ({ enabled: true })),
    large_tool_response: LargeToolResponseConfigSchema.default(() => ({ enabled: true })),
  })
  .openapi('ContextManagementConfig');

const GenerativeUIConfigSchema = z
  .object({
    enabled: z.boolean().default(true).describe('Enable Generative UI (OpenUI blocks). Default: true.'),
  })
  .openapi('GenerativeUIConfig');

const AskUserQuestionsConfigSchema = z
  .object({
    enabled: z.boolean().default(true).describe('Enable the `ask_user_question` tool. Default: true.'),
  })
  .openapi('AskUserQuestionsConfig');

const MemoryConfigSchema = z
  .object({
    recall_enabled: z.boolean().default(true).describe('Recall long-term memory before model calls. Default: true.'),
  })
  .openapi('MemoryConfig');

const TaskStateConfigSchema = z
  .object({
    tool_call_budget: z
      .number()
      .int()
      .positive()
      .max(1024)
      .optional()
      .describe(
        'Host-owned research tool-call budget per turn (1–1024). When set, the agent banks findings with the ' +
          '`record_finding` tool into a structured scratchpad that is re-injected before every model call and ' +
          'survives context compaction; once the budget is spent the host withholds the budgeted research tools ' +
          'and the agent must write its final answer from the banked findings. Unset (default) disables the ' +
          'feature entirely. Requires `budgeted_tools` when set.',
      ),
    budgeted_tools: z
      .array(z.string().trim().min(1).max(128))
      .max(64)
      .optional()
      .describe(
        'Tool names charged against `tool_call_budget` and withheld once it is spent. ' +
          "Matched against each tool's canonical original name; `*` is a wildcard " +
          '(e.g. `tavily*` budgets every Tavily tool). The host-owned `record_finding` ' +
          'tool is always exempt and can never be budgeted. Only these tools are ' +
          'withheld in the final-answer phase — control, approval, and unrelated ' +
          'tools stay available. Required when `tool_call_budget` is set.',
      ),
  })
  .superRefine((value, ctx) => {
    if (value.tool_call_budget !== undefined && (value.budgeted_tools ?? []).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: '`budgeted_tools` must list at least one tool when `tool_call_budget` is set.',
        path: ['budgeted_tools'],
      });
    }
  })
  .openapi('TaskStateConfig');

export const RuntimeConfigSchema = z
  .object({
    iteration_limit: z
      .number()
      .int()
      .positive()
      .max(1024)
      .default(DEFAULT_AGENT_CONFIG_ITERATION_LIMIT)
      .describe(
        `Max agent-loop iterations per turn (1–1024). Default: ${String(DEFAULT_AGENT_CONFIG_ITERATION_LIMIT)}.`,
      ),
    sandbox: SandboxConfigSchema.default(() => SandboxConfigSchema.parse({ enabled: false })),
    dynamic_sub_agents: DynamicSubAgentsConfigSchema.default(() => ({ enabled: true })),
    context_management: ContextManagementConfigSchema.default(() => ({
      compaction: { enabled: true },
      large_tool_response: { enabled: true },
    })),
    memory: MemoryConfigSchema.default(() => ({ recall_enabled: true })),
    task_state: TaskStateConfigSchema.default(() => ({})),
    generative_ui: GenerativeUIConfigSchema.default(() => ({ enabled: true })),
    ask_user_questions: AskUserQuestionsConfigSchema.default(() => ({ enabled: true })),
  })
  .openapi('RuntimeConfig');

// --- Skills ---
// Name (+ optional preload) refs; the skill store expands mounts at turn time.

const SKILL_NAME_REGEX = /^[A-Za-z0-9._\-/:]+$/;

const MAX_AGENT_SKILLS = 50;

/** Skill selection; mount fields come from the skill store. */
const SkillSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .regex(SKILL_NAME_REGEX, 'Name may only contain letters, numbers, ".", "_", "-", "/", and ":"')
      .refine(v => v !== '.' && v !== '..', 'Name must not be "." or ".."')
      .refine(v => !v.startsWith('.tfy-'), 'Name must not use the reserved ".tfy-" prefix')
      .describe('Skill name.'),
    preload: z.boolean().optional().default(false).describe('Inline SKILL.md into the prompt.'),
  })
  .strict()
  .openapi('Skill');

// --- Initial messages (string-only; turn UserMessage also allows file parts) ---

const InitialUserMessageSchema = z
  .object({
    type: z.literal('user.message').describe('Initial message type.'),
    content: z
      .string()
      .min(1, 'User message content must not be empty')
      .refine(content => content.trim().length > 0, 'User message content must not be empty')
      .describe('Initial user message content injected at the start of every session.'),
  })
  .openapi('InitialUserMessage');

// --- Auxiliary model roles ---

/**
 * Models for the host's own bounded operations, chosen per role.
 *
 * A role exists only where a distinct model call does. Today that is compaction,
 * which issues its own summarization request, delegation, which resolves a
 * fresh client per sub-agent thread, and summarization, which condenses a turn
 * before it is written to memory. Titles are a string slice, uploaded images
 * ride the ordinary chat message, and approval is a pure function, so none of
 * those can be given a model without inventing a control that changes nothing.
 *
 * Absence means inherit `model`, resolved at use rather than copied at save
 * time, so changing the main model carries every inheriting role with it.
 */
const AuxiliaryModelsSchema = z
  .object({
    compaction: ModelSchema.optional(),
    delegation: ModelSchema.optional(),
    summarization: ModelSchema.optional(),
  })
  .describe(
    'Per-role model overrides: compaction summarizes context, delegation runs sub-agent threads, and summarization condenses turns before memory writes. Each role inherits the main model when absent.',
  )
  .openapi('AuxiliaryModels');

// --- Agent spec ---

export const AgentSpecSchema = z
  .object({
    model: ModelSchema,
    auxiliary_models: AuxiliaryModelsSchema.optional().describe(
      "Per-role model overrides for the host's own operations. Each role inherits `model` when unset.",
    ),
    instructions: z
      .string()
      .optional()
      .describe("Optional system prompt — the agent's role, behavior, and constraints."),
    messages: z
      .array(InitialUserMessageSchema)
      .optional()
      .describe('Optional initial user messages injected at the start of every session.'),
    mcp_servers: z
      .array(MCPServerRequestSchema)
      .optional()
      .describe('Optional MCP servers attached by configured name.'),
    response_format: ResponseFormatSchema.optional(),
    skills: z
      .array(SkillSchema)
      .max(MAX_AGENT_SKILLS)
      .optional()
      .describe(
        'Optional name-only skill references. Skills mount into the sandbox and are advertised in the <skills> prompt section only when `config.sandbox.enabled` is true — listing skills with the sandbox disabled is rejected (422), so a spec can never silently advertise skills the agent cannot reach.',
      ),
    // Factory must parse so nested RuntimeConfig field defaults materialize.
    config: RuntimeConfigSchema.default(() => RuntimeConfigSchema.parse({})),
  })
  .describe('Complete agent definition used inline on a session or saved as a named agent.')
  .openapi('AgentSpec');

export type AgentSpec = z.infer<typeof AgentSpecSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type InitialUserMessage = z.infer<typeof InitialUserMessageSchema>;

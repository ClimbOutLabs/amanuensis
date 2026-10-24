// TODO(agent): We should not maintain choices anymore.
// https://platform.claude.com/docs/en/api/messages/create
// https://platform.openai.com/docs/api-reference/responses/object#responses-object-output
// Check the above page and check code to and come up with a streaming structure that does not expose
// choices to upstream.

// TODO(agent): At this point, we can write the types from scratch. No point in keeping the old OpenAI baggage.
import { z } from '@hono/zod-openapi';
import type { ChatCompletionChunk } from 'openai/resources/chat';
import {
  ImplementationPlanBindingSchema,
  ImplementationPlanGrantSchema,
  ImplementationPlanGrantScopeSchema,
} from '../mcp/implementationPlanGrant';
import { ShellApprovalBindingSchema } from '../permissions/approvalTokens';
import { TIER2_ACTION_KINDS, Tier3CardSchema, TierSchema, TrackedExecutionBindingSchema } from '../permissions/tier';
import { GitRemotePreconditionSchema } from '../sandbox/gitRemoteObservation';
import { StructuredEditPreconditionSchema } from '../sandbox/structuredEditPrecondition';
import {
  ChatCompletionAssistantMessageParamSchema,
  ChatCompletionChunkDeltaSchema,
  ChatCompletionChunkDeltaToolCallSchema,
  ChatCompletionChunkFinishReasonSchema,
  ChatCompletionMessageToolCallSchema,
  ChatCompletionToolMessageParamSchema,
  ChatCompletionUserMessageParamSchema,
} from './openaiSchemas';

export const ThinkingBlockSchema = z
  .object({
    type: z.literal('thinking').describe('Structured thinking block.'),
    thinking: z.string().describe('Thinking text content.'),
    signature: z.string().optional().describe('Optional provider signature for multi-turn replay.'),
  })
  .openapi('ThinkingBlock');

export const RedactedThinkingBlockSchema = z
  .object({
    type: z.literal('redacted_thinking').describe('Redacted thinking block.'),
    data: z.string().describe('Opaque redacted thinking payload from the provider.'),
  })
  .openapi('RedactedThinkingBlock');

export const ThinkingBlockUnionSchema = z.union([ThinkingBlockSchema, RedactedThinkingBlockSchema]);

/** Host-resolved identity and deadline for one registered repository command. */
export const RegisteredCommandExecutionSchema = z
  .object({
    repository_id: z.string().min(1),
    repository_revision: z.number().int().nonnegative(),
    command_id: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1),
    timeout_ms: z.number().int().positive().max(3_600_000),
  })
  .openapi('RegisteredCommandExecution');

/**
 * Everything an approval prompt may state about what a tool does and where it
 * reaches. Sourced from server-owned descriptions, MCP annotations, or a
 * host-side admission classifier. A prompt can never invent an effect; absent
 * metadata stays absent rather than defaulting to the reassuring answer.
 */
const ToolEffectHintsSchema = z.object({
  description: z.string().optional().describe('Tool description as published by the server that hosts it.'),
  read_only_hint: z
    .boolean()
    .optional()
    .describe('MCP readOnlyHint: the tool does not modify anything in its environment.'),
  destructive_hint: z
    .boolean()
    .optional()
    .describe('MCP destructiveHint: the tool may perform destructive or irreversible updates.'),
  open_world_hint: z
    .boolean()
    .optional()
    .describe('MCP openWorldHint: the tool reaches systems beyond this machine, so data can leave it.'),
  effect: z
    .enum(['inspect', 'edit', 'verify', 'commit', 'push', 'execute'])
    .optional()
    .describe('Server-classified effect of this tool call.'),
});

export const MapsHostsSchema = z
  .object({
    geocoder: z.string(),
    router: z.string(),
    walking: z.string(),
    cycling: z.string(),
    transit: z.string(),
    tile: z.string(),
  })
  .describe('Configured maps upstream URLs for the approval card destination.');

export const InternalToolCallInfoSchema = z.object({
  type: z.enum(['truefoundry-system', 'mcp']).describe('Whether the tool is a system tool or MCP tool.'),
  mcp_server_id: z.string().describe('Internal MCP server id (empty for system tools).'),
  mcp_server_name: z.string().describe('Configured MCP server name (empty for system tools).'),
  original_tool_name: z.string().describe('Original tool name before any remapping.'),
  is_approval_required: z.boolean().optional().describe('Whether this tool call requires human approval.'),
  is_deferred: z.boolean().optional().describe('Whether the tool was loaded via deferred discovery.'),
  mint_tool_name: z
    .string()
    .optional()
    .describe(
      'Tool name the approval token was minted over, when it differs from original_tool_name (sandbox remaps for display). Never model-authored.',
    ),
  mint_canonical_params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Canonical params the approval token was minted over, when they differ from the raw arguments (sandbox normalizes structured-edit args before minting). Never model-authored.',
    ),
  path_resolution: z
    .enum(['host', 'remote'])
    .optional()
    .describe(
      'How the Sentinel reads this call\'s file paths: the sandbox provider says "remote" when the sandbox filesystem is not the server\'s. Never model-authored.',
    ),
  is_client_side: z.boolean().optional().describe('Whether the client must supply the tool result.'),
  // Runtime + wire: deviation from origin/main OpenAPI (which omitted this field) is accepted.
  is_thread_creation: z.boolean().optional().describe('Whether this tool call creates a subagent thread.'),
  pre_dispatch_failure: z
    .object({
      kind: z.enum(['policy_blocked', 'pre_dispatch_failed']),
      message: z.string(),
      owner_message: z
        .string()
        .optional()
        .describe('One plain line shown to the owner instead of the generic message.'),
    })
    .optional()
    .describe('Host-only failure captured while preparing the call, before provider dispatch.'),
  command_execution: RegisteredCommandExecutionSchema.optional().describe(
    'Host-only registered-command identity used for durable execution and deadline control.',
  ),
  implementation_plan_grant: ImplementationPlanGrantSchema.optional().describe(
    'Host-derived implementation-plan grant candidate. Never model-authored or client supplied.',
  ),
  implementation_plan_scope: ImplementationPlanGrantScopeSchema.optional().describe(
    'Host-derived repository-relative scope for implementation-plan admission. Never model-authored or client supplied.',
  ),
  implementation_plan_binding: ImplementationPlanBindingSchema.optional().describe(
    'Host-derived repository identity and checkout state for implementation-plan admission. Never model-authored or client supplied.',
  ),
  structured_edit_precondition: StructuredEditPreconditionSchema.optional().describe(
    'Host-observed structured-edit target state captured before approval. Never model-authored or client supplied.',
  ),
  git_remote_precondition: GitRemotePreconditionSchema.optional().describe(
    'Host-observed git remotes captured before approval. Never model-authored or client supplied.',
  ),
  maps_hosts: MapsHostsSchema.optional().describe(
    'Host-derived configured maps upstream hosts for the approval card destination. Never model-authored or client supplied.',
  ),
  // Sentinel host-only classification. Populated by the classifier in
  // ToolSet/Sandbox; always present on classified calls, never wire-visible.
  tier: TierSchema.optional().describe('Server-owned Sentinel permission tier. Never model-authored.'),
  tier_reason: z
    .string()
    .optional()
    .describe('Server-owned classifier reason code behind the tier. Never model-authored.'),
  tier3_card: Tier3CardSchema.nullable()
    .optional()
    .describe('Server-rendered approval card for Tier 2 and Tier 3 actions, or null.'),
  tier2_kind: z
    .enum(TIER2_ACTION_KINDS)
    .nullable()
    .optional()
    .describe('Tier 2 member kind governed by the per-kind relaxation, or null.'),
  approval_token_id: z
    .string()
    .nullable()
    .optional()
    .describe('Single-use approval token id for actions that need approval, or null.'),
  silent_search_query: z
    .string()
    .optional()
    .describe('Text of a web search the host ran without asking, shown as a chip. Never model-authored.'),
  grant_host: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Connector host a standing grant for this call binds to, set on a grant-eligible ask. Never model-authored.',
    ),
  audit_description: z
    .string()
    .optional()
    .describe('Audit-row text used instead of the approval card sentence. Never model-authored, never wire-visible.'),
  held_for_owner: z
    .object({ expires_at: z.string(), duplicate: z.literal(true).optional() })
    .optional()
    .describe(
      'Set when an unattended run held this call for the owner instead of asking; duplicate marks a repeat of a call already held in the same batch. Never model-authored.',
    ),
  search_provider_call: z
    .literal(true)
    .optional()
    .describe('Set on every call to the connector the user designated as search provider. Never model-authored.'),
  secret_path_read: z
    .literal(true)
    .optional()
    .describe(
      'Set when the call reads a sensitive path or passes a path-like argument, which is never eligible for a standing grant. Never model-authored.',
    ),
  approval_binding: TrackedExecutionBindingSchema.nullable()
    .optional()
    .describe('Host-derived tracked-execution content/argv binding. Never model-authored.'),
  shell_binding: ShellApprovalBindingSchema.nullable()
    .optional()
    .describe('Host-derived parsed shell binding for Tier 3 shell approvals. Never model-authored.'),
  ...ToolEffectHintsSchema.shape,
});

export const TrueFoundrySystemToolInfoSchema = z
  .object({
    type: z.literal('truefoundry-system').describe('Built-in harness system tool.'),
    name: z.string().describe('System tool name.'),
    host_observed_target_summary: z
      .string()
      .optional()
      .describe('Host-observed target the call acts on, such as a file or git repository, shown during approval.'),
    ...ToolEffectHintsSchema.shape,
  })
  .openapi('TrueFoundrySystemToolInfo');

export const MCPToolInfoSchema = z
  .object({
    type: z.literal('mcp').describe('Tool hosted on an MCP server.'),
    server_id: z.string().describe('Internal MCP server id.'),
    server_name: z.string().describe('Configured MCP server name.'),
    name: z.string().describe('Tool name on the MCP server.'),
    host_observed_target_summary: z
      .string()
      .optional()
      .describe('Host-observed target the call acts on, such as a file or git repository, shown during approval.'),
    silent_search_query: z
      .string()
      .optional()
      .describe('Text of a web search the host ran without asking, for the Searched chip.'),
    ...ToolEffectHintsSchema.shape,
  })
  .openapi('MCPToolInfo');

export const RawToolCallSchema = ChatCompletionMessageToolCallSchema.extend({
  provider_specific_fields: z.record(z.string(), z.unknown()).optional(),
}).openapi('RawToolCall');

export const InternalEnrichedToolCallSchema = RawToolCallSchema.extend({
  tool_info: InternalToolCallInfoSchema,
});

export const ToolInfoSchema = z
  .discriminatedUnion('type', [TrueFoundrySystemToolInfoSchema, MCPToolInfoSchema])
  .openapi('ToolInfo');

export const EnrichedToolCallSchema = RawToolCallSchema.extend({
  tool_info: ToolInfoSchema,
}).openapi('ToolCall');

export const RawAssistantMessageSchema = ChatCompletionAssistantMessageParamSchema.omit({
  tool_calls: true,
  audio: true,
  function_call: true,
})
  .extend({
    tool_calls: z.array(RawToolCallSchema).optional(),
    thinking_blocks: z.array(ThinkingBlockUnionSchema).optional(),
    /** Plain-text thinking content streamed incrementally for frontend display; redundant with thinking_blocks[].thinking. */
    reasoning_content: z.string().optional(),
    /** Source of the message: which provider/model sent it (`provider_type/provider_name/model_name`). */
    source: z.string().optional(),
  })
  .openapi('RawAssistantMessage');

export const InternalEnrichedAssistantMessageSchema = RawAssistantMessageSchema.omit({
  tool_calls: true,
}).extend({
  tool_calls: z.array(InternalEnrichedToolCallSchema).optional(),
});

// `thinking_blocks` / `source` omitted: kept on the internal message for context replay, hidden from the client event.
export const EnrichedAssistantMessageSchema = RawAssistantMessageSchema.omit({
  tool_calls: true,
  thinking_blocks: true,
  source: true,
})
  .extend({
    tool_calls: z.array(EnrichedToolCallSchema).optional(),
  })
  .openapi('EnrichedAssistantMessage');

export const ExtendedChunkDeltaToolCallSchema = ChatCompletionChunkDeltaToolCallSchema.extend({
  tool_info: ToolInfoSchema.optional(),
  provider_specific_fields: z.record(z.string(), z.unknown()).optional(),
}).openapi('ExtendedChunkDeltaToolCall');

export const ExtendedChunkDeltaSchema = ChatCompletionChunkDeltaSchema.omit({ tool_calls: true })
  .extend({
    tool_calls: z.array(ExtendedChunkDeltaToolCallSchema).optional(),
    /** Structured thinking blocks from the gateway; accumulated into complete blocks (with signatures) for multi-turn replay. */
    thinking_blocks: z.array(ThinkingBlockUnionSchema).optional(),
    /** Plain-text thinking content streamed incrementally for frontend display; not stored — redundant with thinking_blocks[].thinking. */
    reasoning_content: z.string().optional(),
  })
  .openapi('ExtendedChunkDelta');

export const LLMUserMessageSchema = ChatCompletionUserMessageParamSchema.pick({
  role: true,
  content: true,
}).openapi('LLMUserMessage');

export const LLMSystemMessageSchema = z
  .object({
    role: z.literal('system'),
    content: z.string(),
  })
  .openapi('LLMSystemMessage');

export const LLMToolMessageSchema = ChatCompletionToolMessageParamSchema.omit({ content: true })
  .extend({
    // TODO(agent): Where do I update the Zod code for this change?
    content: z.string(),
  })
  .openapi('LLMToolMessage');

export const CompletionUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().describe('Input tokens for this completion.'),
    output_tokens: z.number().int().nonnegative().describe('Output tokens for this completion.'),
    total_tokens: z.number().int().nonnegative().describe('Total tokens (input + output).'),
    cache_read_tokens: z.number().int().nonnegative().optional().describe('Optional cache-read tokens.'),
    cache_write_tokens: z.number().int().nonnegative().optional().describe('Optional cache-write tokens.'),
    reasoning_tokens: z.number().int().nonnegative().optional().describe('Optional reasoning tokens.'),
    cost_in_usd: z.number().nonnegative().optional().describe('Optional estimated cost in USD.'),
  })
  .openapi('CompletionUsage');

export const FinishReasonSchema = ChatCompletionChunkFinishReasonSchema.openapi('FinishReason');

export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type RedactedThinkingBlock = z.infer<typeof RedactedThinkingBlockSchema>;
export type ToolEffectHints = z.infer<typeof ToolEffectHintsSchema>;
export type MapsHosts = z.infer<typeof MapsHostsSchema>;
export type InternalToolCallInfo = z.infer<typeof InternalToolCallInfoSchema>;
export type RegisteredCommandExecution = z.infer<typeof RegisteredCommandExecutionSchema>;
export type TrueFoundrySystemToolInfo = z.infer<typeof TrueFoundrySystemToolInfoSchema>;
export type MCPToolInfo = z.infer<typeof MCPToolInfoSchema>;
export type ToolInfo = z.infer<typeof ToolInfoSchema>;
export type InternalEnrichedToolCall = z.infer<typeof InternalEnrichedToolCallSchema>;
export type EnrichedToolCall = z.infer<typeof EnrichedToolCallSchema>;
export type RawToolCall = z.infer<typeof RawToolCallSchema>;
export type RawAssistantMessage = z.infer<typeof RawAssistantMessageSchema>;
export type InternalEnrichedAssistantMessage = z.infer<typeof InternalEnrichedAssistantMessageSchema>;
export type EnrichedAssistantMessage = z.infer<typeof EnrichedAssistantMessageSchema>;
export type ExtendedDeltaToolCall = z.infer<typeof ExtendedChunkDeltaToolCallSchema>;
export type ExtendedDelta = z.infer<typeof ExtendedChunkDeltaSchema>;
export type LLMUserMessage = z.infer<typeof LLMUserMessageSchema>;
export type LLMSystemMessage = z.infer<typeof LLMSystemMessageSchema>;
export type LLMToolMessage = z.infer<typeof LLMToolMessageSchema>;
export type CompletionUsage = z.infer<typeof CompletionUsageSchema>;
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export function getEmptyUsage(): CompletionUsage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

/**
 * Extended choice type that includes thought_signature in the delta.
 */
interface ExtendedChoice extends Omit<ChatCompletionChunk.Choice, 'delta'> {
  /**
   * A chat completion delta generated by streamed model responses, with thought_signature support.
   */
  delta: ExtendedDelta;
}

/**
 * Extended chat completion chunk that includes thought_signature in tool calls.
 * `usage` is harness-normalized; the LLM adapter maps the wire `usage` payload at the adapter boundary.
 */
export interface ExtendedChatCompletionChunk extends Omit<ChatCompletionChunk, 'choices' | 'usage'> {
  /**
   * A list of chat completion choices, with thought_signature support in deltas.
   */
  choices: ExtendedChoice[];
  usage?: CompletionUsage | null;
}

export interface RawAssistantMessageWithUsage {
  output: RawAssistantMessage;
  usage: CompletionUsage;
  /** null when the stream ended without a finish_reason chunk (e.g. provider omitted it). */
  finish_reason: FinishReason | null;
  /**
   * Set when the reply's answer text carried leaked tool-call markup. The markup is held out of
   * output.content and never runs, and the turn is not retried. Absent when the reply had none.
   */
  tool_markup?: 'leaked';
  /**
   * Set when a repetition guard cut the answer short. output.content ends with the stop notice and
   * nothing after the first copy of the loop. Absent when the reply was not cut.
   */
  repetition_stopped?: true;
}

export const UNKNOWN_TOOL_NAME = 'unknown';

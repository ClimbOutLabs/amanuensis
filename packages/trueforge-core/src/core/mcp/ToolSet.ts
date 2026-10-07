import type { CallToolRequest, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { McpConnectionError, ToolPolicyBlockedError, ToolPreDispatchError } from '../errors';
import type { ApprovalDecision } from '../events/schema';
import type { InternalToolCallInfo, ToolEffectHints } from '../llm/LLMTypes';
import {
  classifyHostToolCall,
  type SentinelHostContext,
  type TierDecision,
} from '../permissions';
import { normalizeGithubFileContentsResponse } from './githubFileContents';
import {
  isAuthRequired,
  isCallToolResponseResult,
  toolResultResponse,
  type AgentToolSchema,
  type ToolSchema,
  type AuthRequiredResponse,
  type CallToolResponse,
  type IToolSet,
  type ListToolsResponse,
  type ToolInvocationContext,
  type ToolSource,
} from './IMCPServer';
import { ToolSelectorPolicy, type ToolSelectorConfig } from './ToolSelectorPolicy';

/**
 * Type guard for plain-object tool arguments. Tool arguments arrive as parsed
 * JSON; arrays and null are not valid parameter objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The tool result a denied call produces. Shared with OpenToolCallCloser, which writes it
 * for a call that was denied and then never dispatched, so the model reads one wording
 * either way.
 */
export function deniedToolCallText(reason: string | undefined): string {
  return JSON.stringify({ error: `User denied tool call: ${reason ?? 'no reason provided'}` });
}

/**
 * Stamp a TierDecision onto host-only InternalToolCallInfo fields. The
 * classifier result replaces the policy approval stamp: only Tier 3 carded
 * actions require approval; auto-denied actions surface as a
 * pre-dispatch failure instead of a card.
 */
export function stampSentinelDecision(input: {
  decision: TierDecision;
}): Pick<
  InternalToolCallInfo,
  | 'tier'
  | 'tier3_card'
  | 'tier2_kind'
  | 'tier2_files'
  | 'approval_token_id'
  | 'approval_binding'
  | 'shell_binding'
  | 'is_approval_required'
  | 'pre_dispatch_failure'
> {
  const decision = input.decision;
  return {
    tier: decision.tier,
    tier3_card: decision.card,
    tier2_kind: decision.tier2_kind,
    tier2_files: decision.tier2_files,
    approval_token_id: decision.approval_token_id,
    approval_binding: decision.approval_binding,
    shell_binding: decision.shell_binding,
    is_approval_required: decision.tier === 3 && decision.auto_deny === null,
    ...(decision.auto_deny === null
      ? {}
      : {
          pre_dispatch_failure: {
            kind: 'policy_blocked' as const,
            message:
              decision.auto_deny === 'offline_mode'
                ? 'Auto-denied: offline mode is on.'
                : 'Auto-denied: the destination of this external action could not be verified.',
          },
        }),
  };
}

/**
 * Per-agent {@link IToolSet} view over a shared, policy-free {@link ToolSource}, applying the
 * enable/disable/preload/approval selectors. Many can wrap one source without policy bleed.
 */
export class ToolSet implements IToolSet {
  readonly name: string;
  readonly id: string;
  readonly description?: string | undefined;

  private readonly source: ToolSource;
  private readonly policy: ToolSelectorPolicy;
  private readonly sentinel: SentinelHostContext | undefined;

  constructor(params: {
    source: ToolSource;
    selectors: ToolSelectorConfig;
    preload: boolean | undefined;
    /**
     * Sentinel classification context. When present, every tool call the
     * source has not already classified is classified here and the classifier
     * result replaces the policy approval stamp. Absent, the source's own
     * approval stamping is preserved and no classification runs.
     */
    sentinel?: SentinelHostContext | undefined;
  }) {
    this.source = params.source;
    this.name = params.source.name;
    this.id = params.source.id;
    this.description = params.source.description;
    this.policy = new ToolSelectorPolicy({
      selectors: params.selectors,
      preload: params.preload,
    });
    this.sentinel = params.sentinel;
  }

  // True when every exposed tool is eager. Tracks the policy live: for an auto-preload server
  // (spec left `preload` unset) this starts `false` and can flip `true` once filterAndAnnotate()
  // (inside listTools()) has learned the tool count.
  get preload(): boolean {
    return this.policy.preload;
  }

  get hasPreloadedTools(): boolean {
    return this.policy.hasPreloadedTools;
  }

  get preloadPending(): boolean {
    return this.policy.preloadPending;
  }

  getAllowedToolNamesForSandbox(): string[] | undefined {
    return this.policy.allowedNamesForSandbox();
  }

  async listTools(): Promise<ListToolsResponse> {
    let response: ListToolsResponse | AuthRequiredResponse;
    try {
      response = await this.source.listTools();
    } catch (error) {
      // A server whose preload is still undecided (spec left it unset) is being probed purely to
      // learn its tool count; a failed connect/list here must not take down every other server's
      // tools in the same batched convertMCPServersToTools() call. Degrade to deferred and let the
      // meta-tools (list_tools/get_tool_info/call_tool) surface the same failure, in tool result
      // text, the next time this server is actually used.
      if (this.policy.preloadPending) {
        this.policy.degradeAutoPreloadOnFailure();
        return { result: { tools: [] }, wasInitialized: undefined };
      }
      throw error;
    }
    if (isAuthRequired(response)) {
      return response;
    }

    const tools = response.result.tools;
    const missingTools = this.policy.missingEnableLiterals(tools);
    if (missingTools.length > 0) {
      throw new McpConnectionError(
        `Requested tools not found in MCP server ${this.name}: ${missingTools.join(', ')}`,
        422,
      );
    }

    return {
      result: { tools: this.policy.filterAndAnnotate(tools) },
      wasInitialized: response.wasInitialized,
    };
  }

  async callTool(
    params: CallToolRequest['params'],
    decision?: ApprovalDecision,
    context?: ToolInvocationContext,
  ): Promise<CallToolResponse> {
    let listed: ListToolsResponse;
    let tool: AgentToolSchema | undefined;
    try {
      // Prime the source and surface auth-required before the annotation-based allow/approval checks
      // (which would otherwise see missing annotations and wrongly 403).
      listed = await this.source.listTools();
      if (isAuthRequired(listed)) {
        return listed;
      }
      tool = findTool(listed.result.tools, params.name);

      await this.assertToolAllowed(params.name, tool?.annotations);

      const tool_info = await this.buildToolCallInfo(params, tool);
      if (!decision && tool_info.is_approval_required) {
        return { approvalRequired: { tool_info } };
      }

      if (decision?.status === 'deny') {
        return toolResultResponse({
          text: deniedToolCallText(decision.reason),
          isError: true,
        });
      }
    } catch (error) {
      if (error instanceof ToolPolicyBlockedError || error instanceof ToolPreDispatchError) {
        throw error;
      }
      const detail = error instanceof McpConnectionError ? `: ${error.message}` : '';
      throw new ToolPreDispatchError(`Tool '${params.name}' could not be prepared for execution${detail}`, {
        cause: error,
      });
    }

    const response = normalizeGithubFileContentsResponse({
      serverName: this.name,
      params,
      response: await this.source.callTool(params, decision, context),
    });
    // The priming listTools() may have captured the first-connect init; carry it forward since the
    // subsequent callTool sees an already-open connection and reports none.
    if (listed.wasInitialized && isCallToolResponseResult(response) && !response.wasInitialized) {
      return { ...response, wasInitialized: listed.wasInitialized };
    }
    return response;
  }

  async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    try {
      const tool = await this.resolveTool(params.name);
      return await this.buildToolCallInfo(params, tool, resolveUnderlyingTool);
    } catch (error) {
      if (error instanceof ToolPolicyBlockedError || error instanceof ToolPreDispatchError) {
        throw error;
      }
      const detail = error instanceof McpConnectionError ? `: ${error.message}` : '';
      throw new ToolPreDispatchError(`Tool '${params.name}' could not be prepared for execution${detail}`, {
        cause: error,
      });
    }
  }

  private async assertToolAllowed(toolName: string, annotations: ToolAnnotations | undefined): Promise<void> {
    const allowed = await this.policy.isAllowed(toolName, () => Promise.resolve(annotations));
    if (!allowed) {
      throw new ToolPolicyBlockedError(`Tool '${toolName}' is not allowed on MCP server ${this.name}`);
    }
  }

  private async buildToolCallInfo(
    params: CallToolRequest['params'],
    tool: AgentToolSchema | undefined,
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    // Hints go under the source's info, not over it: a deferred call resolves to the
    // underlying tool's own hints, and `tool` here only describes the dispatch wrapper.
    const sourceInfo = await this.source.toolCallInfo(params, resolveUnderlyingTool);
    if (sourceInfo.tier !== undefined) {
      // Already classified by the source (the sandbox classifies its own
      // tools with normalized arguments): keep the classifier result, do not
      // re-classify or re-stamp.
      return { ...toolEffectHints(tool), ...sourceInfo };
    }
    const sentinel = this.sentinel;
    if (sentinel === undefined) {
      // No Sentinel context wired by the host: preserve the legacy policy
      // approval stamping. Classification only runs when the host opts in.
      return {
        ...toolEffectHints(tool),
        ...sourceInfo,
        is_approval_required: this.policy.requiresApproval(params.name, tool?.annotations),
      };
    }
    const decision = await classifyHostToolCall({
      sentinel,
      repository_id: null,
      workspace_cwd: sentinel.workspace_cwd,
      action: {
        tool_name: params.name,
        canonical_params: isRecord(params.arguments) ? params.arguments : {},
        tool_type: sourceInfo.type,
        mcp_server_id: sourceInfo.mcp_server_id,
        mcp_hints: {
          read_only_hint: sourceInfo.read_only_hint,
          destructive_hint: sourceInfo.destructive_hint,
          open_world_hint: sourceInfo.open_world_hint,
        },
      },
    });
    return {
      ...toolEffectHints(tool),
      ...sourceInfo,
      ...stampSentinelDecision({ decision }),
    };
  }

  private async resolveTool(toolName: string): Promise<AgentToolSchema | undefined> {
    const listed = await this.source.listTools();
    if (isAuthRequired(listed)) {
      return undefined;
    }
    return findTool(listed.result.tools, toolName);
  }
}

function findTool(tools: AgentToolSchema[], toolName: string): AgentToolSchema | undefined {
  return tools.find(t => t.name === toolName);
}

/**
 * Classifies an MCP tool as read-only inspection, which is the only category a
 * durable chat-scoped approval may cover.
 *
 * Both conditions are required. `readOnlyHint` alone is not enough: a tool that
 * reads nothing but reaches off this machine can still carry data out in its
 * arguments, and an MCP chat grant is argument-blind, so one grant would
 * authorize every later call with any argument for the rest of the chat.
 * Requiring the tool to stay local bounds that to this machine.
 *
 * The claim is the hosting server's own, which is the only signal MCP offers.
 * Absence is never read as the reassuring answer: an unannotated tool is not
 * inspection.
 */
function isReadOnlyLocalTool(annotations: ToolAnnotations | undefined): boolean {
  return annotations?.readOnlyHint === true && annotations.openWorldHint !== true;
}

/**
 * Copies only the hints the server actually published. Keys are omitted rather than
 * set to undefined so an unannotated tool stays visibly unannotated downstream.
 */
/**
 * Effect hints from a tool's MCP annotations. Shared by ToolSet (remote MCP
 * tools) and LocalToolMCP (built-in host tools) so both read the same
 * server-declared metadata.
 */
export function toolEffectHints(tool: ToolSchema | undefined): ToolEffectHints {
  const annotations: ToolAnnotations | undefined = tool?.annotations;
  return {
    ...(tool?.description !== undefined && { description: tool.description }),
    ...(annotations?.readOnlyHint !== undefined && { read_only_hint: annotations.readOnlyHint }),
    ...(annotations?.destructiveHint !== undefined && { destructive_hint: annotations.destructiveHint }),
    ...(annotations?.openWorldHint !== undefined && { open_world_hint: annotations.openWorldHint }),
    ...(isReadOnlyLocalTool(annotations) && { effect: 'inspect' as const }),
  };
}

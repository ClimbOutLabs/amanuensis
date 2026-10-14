import type { CallToolRequest, CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { McpConnectionError, ToolPolicyBlockedError, ToolPreDispatchError } from '../errors';
import type { ApprovalDecision } from '../events/schema';
import type { InternalToolCallInfo, ToolEffectHints } from '../llm/LLMTypes';
import {
  classifyHostToolCall,
  recordStandingTrustRun,
  type SentinelHostContext,
  type TierDecision,
} from '../permissions';
import type { ConnectorBinding } from '../permissions/approvalTokens';
import { isStandingTrustDecision } from '../permissions/connectorTrust';
import { appendOutboundTrace, collectOutboundStrings } from '../permissions/outboundGuard';
import {
  isSearchAskReason,
  namesUrl,
  recordResultUrls,
  runOneAtATime,
  SEARCH_SILENT_REASON,
} from '../permissions/webSearch';
import { normalizeGithubFileContentsResponse } from './githubFileContents';
import {
  isAuthRequired,
  isCallToolResponseResult,
  toolResultResponse,
  type AgentToolSchema,
  type AuthRequiredResponse,
  type CallToolResponse,
  type IToolSet,
  type ListToolsResponse,
  type ToolInvocationContext,
  type ToolSchema,
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
 * classifier result replaces the policy approval stamp: Tier 3 actions and
 * Tier 2 actions carrying an approval token require approval; auto-denied
 * actions surface as a pre-dispatch failure instead of a card.
 */
export function stampSentinelDecision(input: {
  decision: TierDecision;
}): Pick<
  InternalToolCallInfo,
  | 'tier'
  | 'tier3_card'
  | 'tier2_kind'
  | 'approval_token_id'
  | 'approval_binding'
  | 'shell_binding'
  | 'is_approval_required'
  | 'pre_dispatch_failure'
  | 'silent_search_query'
> {
  const decision = input.decision;
  return {
    tier: decision.tier,
    tier3_card: decision.card,
    tier2_kind: decision.tier2_kind,
    approval_token_id: decision.approval_token_id,
    approval_binding: decision.approval_binding,
    shell_binding: decision.shell_binding,
    ...(decision.silent_search_query === null ? {} : { silent_search_query: decision.silent_search_query }),
    is_approval_required:
      decision.auto_deny === null &&
      (decision.tier === 3 || (decision.tier === 2 && decision.approval_token_id !== null)),
    ...(decision.auto_deny === null
      ? {}
      : {
          pre_dispatch_failure: {
            kind: 'policy_blocked' as const,
            message: autoDenyMessage(decision),
          },
        }),
  };
}

/** Result for a search that was settled as silent before dispatch and may no longer run. */
function searchNotRunText(input: { detail: string; unattended: boolean }): string {
  const next = input.unattended ? 'Continue without it.' : 'Try again; it will be sent for approval.';
  return JSON.stringify({ error: `The web search was not run. ${input.detail} ${next}` });
}

/** Text a search result carries: its text blocks and its structured content. */
function resultTexts(result: CallToolResult): string[] {
  if (result.isError === true) {
    return [];
  }
  const texts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text') {
        texts.push(block.text);
      }
    }
  }
  if (result.structuredContent !== undefined) {
    texts.push(JSON.stringify(result.structuredContent));
  }
  return texts;
}

function autoDenyMessage(decision: TierDecision): string {
  switch (decision.auto_deny) {
    case 'offline_mode':
      return 'Auto-denied: offline mode is on.';
    case 'outbound_guard':
      return `Auto-denied: ${decision.reason_detail ?? 'the outbound guard held this call back'} Continue without it.`;
    default:
      return 'Auto-denied: the destination of this external action could not be verified.';
  }
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
  private readonly firstParty: boolean;
  private readonly searchProvider: boolean;
  private readonly searchTools: ReadonlySet<string>;

  constructor(params: {
    source: ToolSource;
    selectors: ToolSelectorConfig;
    preload: boolean | undefined;
    /**
     * Sentinel classification context. When present, every tool call the
     * source has not already classified is classified here; the classifier
     * result decides approval, and a require-approval selector can only add a
     * gate. Absent, the source's own approval stamping is preserved and no
     * classification runs.
     */
    sentinel?: SentinelHostContext | undefined;
    /**
     * The host provisioned this connector itself, so a tool that declares itself read-only and
     * explicitly closed-world runs without a card. Set by the host only, never from a connector
     * URL, client input, or tool metadata. Has no effect without `sentinel`.
     */
    firstParty?: boolean | undefined;
    /**
     * The user designated this connector as their search provider; `tools` are the host's own
     * list of its search tools. Set by the host from the connector record only, never from a
     * connector URL, client input, or tool metadata. A tool runs silently only when the server
     * declares it read-only or this list names it. Has no effect without `sentinel`.
     */
    searchProvider?: { tools: readonly string[] } | undefined;
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
    this.firstParty = params.firstParty === true;
    this.searchProvider = params.searchProvider !== undefined;
    this.searchTools = new Set(params.searchProvider?.tools);
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

      const refusal = await this.admit({ params, tool, decision });
      if (refusal !== undefined) {
        return refusal;
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
    if (this.searchProvider && this.sentinel !== undefined && isCallToolResponseResult(response)) {
      // What a search returned is what a later fetch in this turn may name. A call that itself
      // names a URL is a fetch: its page's links are not search results, so they stay unreturned.
      const sent = collectOutboundStrings(params.arguments ?? {});
      if (sent !== undefined && !namesUrl(sent.values)) {
        recordResultUrls({ state: this.sentinel.web_search, texts: resultTexts(response.result) });
      }
    }
    // The priming listTools() may have captured the first-connect init; carry it forward since the
    // subsequent callTool sees an already-open connection and reports none.
    if (listed.wasInitialized && isCallToolResponseResult(response) && !response.wasInitialized) {
      return { ...response, wasInitialized: listed.wasInitialized };
    }
    return response;
  }

  /**
   * Classifies the call and settles whether it may be dispatched now: a response means it must not
   * be (approval needed, denied, or a silent search that can no longer run), undefined means go.
   * For the search provider the whole step runs one call at a time per turn, so the silent count and
   * the text already sent are read and updated without another call of the batch slipping between.
   */
  private async admit(input: {
    params: CallToolRequest['params'];
    tool: AgentToolSchema | undefined;
    decision: ApprovalDecision | undefined;
  }): Promise<CallToolResponse | undefined> {
    const work = () => this.admitNow(input);
    return this.searchProvider && this.sentinel !== undefined
      ? runOneAtATime({ state: this.sentinel.web_search, work })
      : work();
  }

  private async admitNow({
    params,
    tool,
    decision,
  }: {
    params: CallToolRequest['params'];
    tool: AgentToolSchema | undefined;
    decision: ApprovalDecision | undefined;
  }): Promise<CallToolResponse | undefined> {
    const { info: tool_info, classification } = await this.buildToolCallInfo(params, tool);
    if (tool_info.pre_dispatch_failure !== undefined) {
      // The turn loop refuses these before it gets here; a caller that skips that step still cannot
      // run a call the host auto-denied, such as a search the outbound guard held in a scheduled run.
      return toolResultResponse({ text: JSON.stringify({ error: tool_info.pre_dispatch_failure.message }), isError: true });
    }
    if (decision === undefined && classification !== undefined && isSearchAskReason(classification.reason)) {
      // The turn settled this call as silent before dispatch, and a count, setting, or secret
      // changed since. The turn loop cannot take an approval request at dispatch, so the call
      // does not run; the next attempt is classified afresh and asks.
      return toolResultResponse({
        text: searchNotRunText({
          detail: classification.reason_detail ?? 'It needs approval.',
          unattended: this.sentinel?.services.unattended === true,
        }),
        isError: true,
      });
    }
    if (!decision && tool_info.is_approval_required) {
      return { approvalRequired: { tool_info } };
    }

    if (decision?.status === 'deny') {
      return toolResultResponse({
        text: deniedToolCallText(decision.reason),
        isError: true,
      });
    }

    if (decision === undefined && classification?.reason === SEARCH_SILENT_REASON && this.sentinel !== undefined) {
      // Classified as silent a moment ago inside this one-at-a-time step, so the count is current.
      const turn = this.sentinel.web_search;
      turn.silentSearches += 1;
      const sent = collectOutboundStrings(params.arguments ?? {});
      if (sent !== undefined) {
        turn.sentText = appendOutboundTrace({ earlier: turn.sentText, strings: sent });
      }
    }

    if (
      decision === undefined &&
      classification !== undefined &&
      isStandingTrustDecision(classification) &&
      this.sentinel !== undefined
    ) {
      await recordStandingTrustRun({
        services: this.sentinel.services,
        identity: this.sentinel,
        tool_name: params.name,
        description: classification.reason_detail ?? params.name,
      });
    }
    return undefined;
  }

  resolveConnector(): ConnectorBinding {
    return { server_id: this.id, destination_host: this.source.serverHost ?? null };
  }

  async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    try {
      const tool = await this.resolveTool(params.name);
      return (await this.buildToolCallInfo(params, tool, resolveUnderlyingTool)).info;
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
  ): Promise<{ info: InternalToolCallInfo; classification: TierDecision | undefined }> {
    // Hints go under the source's info, not over it: a deferred call resolves to the
    // underlying tool's own hints, and `tool` here only describes the dispatch wrapper.
    const sourceInfo = await this.source.toolCallInfo(params, resolveUnderlyingTool);
    if (sourceInfo.tier !== undefined) {
      // Already classified by the source (the sandbox classifies its own
      // tools with normalized arguments): keep the classifier result, do not
      // re-classify or re-stamp.
      return { info: { ...toolEffectHints(tool), ...sourceInfo }, classification: undefined };
    }
    const sentinel = this.sentinel;
    if (sentinel === undefined) {
      // No Sentinel context wired by the host: preserve the legacy policy
      // approval stamping. Classification only runs when the host opts in.
      return {
        info: {
          ...toolEffectHints(tool),
          ...sourceInfo,
          is_approval_required: this.policy.requiresApproval(params.name, tool?.annotations),
        },
        classification: undefined,
      };
    }
    const info = { ...toolEffectHints(tool), ...sourceInfo };
    const decision = await classifyHostToolCall({
      sentinel,
      repository_id: null,
      workspace_cwd: sentinel.workspace_cwd,
      action: {
        tool_name: params.name,
        canonical_params: isRecord(params.arguments) ? params.arguments : {},
        tool_type: info.type,
        mcp_server_name: info.mcp_server_name,
        mcp_server_id: info.mcp_server_id,
        mcp_server_host: this.source.serverHost,
        mcp_first_party: this.firstParty,
        mcp_search_provider: this.searchProvider,
        mcp_search_tool: this.searchTools.has(params.name),
        mcp_hints: {
          read_only_hint: info.read_only_hint,
          destructive_hint: info.destructive_hint,
          open_world_hint: info.open_world_hint,
        },
        maps_hosts: info.maps_hosts,
      },
    });
    const stamp = stampSentinelDecision({ decision });
    return {
      info: {
        ...info,
        ...stamp,
        // An explicit require-approval selector adds a gate on top of any tier, including a
        // standing grant, but never to a call that is auto-denied without a card.
        is_approval_required:
          stamp.is_approval_required === true ||
          (decision.auto_deny === null &&
            this.policy.requiresApproval(params.name, tool?.annotations, {
              waiveUnclassified: decision.reason === SEARCH_SILENT_REASON,
            })),
      },
      classification: decision,
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
 * durable chat-scoped or always-allow approval may cover.
 *
 * Both conditions are required. `readOnlyHint` alone is not enough: a tool that
 * reads nothing but reaches off this machine can still carry data out in its
 * arguments, and an MCP grant is argument-blind, so one grant would authorize
 * every later call with any argument. Requiring the tool to stay local bounds
 * that to this machine.
 *
 * The claim is the hosting server's own, which is the only signal MCP offers.
 * Absence is never read as the reassuring answer: an unannotated tool is not
 * inspection, and a tool that omits `openWorldHint` is open-world, as the MCP
 * spec defines the default.
 */
function isReadOnlyLocalTool(annotations: ToolAnnotations | undefined): boolean {
  return annotations?.readOnlyHint === true && annotations.openWorldHint === false;
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

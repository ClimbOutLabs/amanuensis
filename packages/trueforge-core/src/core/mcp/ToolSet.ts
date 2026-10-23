import type { CallToolRequest, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'winston';
import { caldavEventReviewFrom, type CaldavEventReview } from '../calendar/caldav/eventReview';
import { CALDAV_SERVER_NAME } from '../calendar/caldav/toolContract';
import { McpConnectionError, ToolPolicyBlockedError, ToolPreDispatchError } from '../errors';
import type { ApprovalDecision, ToolResultRemediation } from '../events/schema';
import type { InternalToolCallInfo, ToolEffectHints } from '../llm/LLMTypes';
import {
  classifyHostToolCall,
  recordStandingTrustRun,
  type SentinelHostContext,
  type TierDecision,
} from '../permissions';
import {
  APPROVAL_EXPIRED_REASON_CODE,
  APPROVAL_EXPIRED_RESULT,
  isApprovalExpiredReason,
} from '../permissions/approvalExpiry';
import type { ConnectorBinding } from '../permissions/approvalTokens';
import { caldavResultNote } from '../permissions/caldavTier';
import { isChangeRequestReason } from '../permissions/changeRequest';
import { isStandingTrustDecision } from '../permissions/connectorTrust';
import { isMapsToolName } from '../permissions/mapsToolNames';
import { appendOutboundTrace, collectOutboundStrings } from '../permissions/outboundGuard';
import {
  countSilentFetches,
  isSearchAskReason,
  isSilentSearchReason,
  namesUrl,
  recordResultUrls,
  resultTexts,
  runOneAtATime,
  type SearchProviderGrant,
} from '../permissions/webSearch';
import type { ToolBundleName } from '../runtime/toolBundleCatalog';
import {
  isPageReaderTool,
  isSearchResultTool,
  recordFetchedPages,
  recordSearchResults,
  type FetchedPageScope,
  type FetchedPageStore,
} from '../search/fetchedPages';
import { TAVILY_SEARCH_TOOL_NAME } from '../search/TavilyClient';
import { normalizeGithubFileContentsResponse } from './githubFileContents';
import {
  isAuthRequired,
  isCallToolResponseResult,
  toolResultResponse,
  type AgentToolSchema,
  type AuthRequiredResponse,
  type CallToolResolvedResponse,
  type CallToolResponse,
  type IToolSet,
  type ListToolsResponse,
  type ToolInvocationContext,
  type ToolSchema,
  type ToolSource,
} from './IMCPServer';
import { dropUnnamedArguments, toParameterSchema } from './toolArgumentCheck';
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
 * either way. A "Change it" answer is not an error, so it reaches the model as the request itself.
 */
export function deniedToolCallText(reason: string | undefined): string {
  if (reason !== undefined && isChangeRequestReason(reason)) {
    return reason;
  }
  if (isApprovalExpiredReason(reason)) {
    return JSON.stringify({ error: APPROVAL_EXPIRED_RESULT });
  }
  const said = reason === undefined ? DENIED_SAID : `${DENIED_SAID} Their reason: ${reason}.`;
  return JSON.stringify({ error: `${said} ${DENIED_NEXT_STEP}` });
}

// Firm on purpose: a small model reads a bare "denied" as "try another wording".
const DENIED_SAID = 'The person said no to this.';
const DENIED_NEXT_STEP =
  'Do not try it again, with any wording, unless they ask for it. Answer with what you have, or ask them what they want.';

/** Marks a call refused because it repeats a "no" from earlier in the turn; it never asked again. */
export const REPEATED_DENIAL_REMEDIATION: ToolResultRemediation = {
  reason_code: 'repeated_denied_action',
  message: 'You already said no to this, so it was not asked again.',
  suggested_action: 'contact_user',
};

/** Marks a denied call whose card expired, so the chat says it expired instead of "you said no". */
export function deniedToolCallRemediation(reason: string | undefined): ToolResultRemediation | undefined {
  return isApprovalExpiredReason(reason)
    ? { reason_code: APPROVAL_EXPIRED_REASON_CODE, message: APPROVAL_EXPIRED_RESULT, suggested_action: 'request_approval' }
    : undefined;
}

/**
 * The response a denied call produces. A "Change it" answer is plain text, not an error payload,
 * so the model reads the request exactly as written.
 */
export function deniedToolCallResponse(reason: string | undefined): CallToolResolvedResponse {
  return toolResultResponse({ text: deniedToolCallText(reason), isError: !isChangeRequestReason(reason) });
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
  | 'tier_reason'
  | 'tier3_card'
  | 'tier2_kind'
  | 'approval_token_id'
  | 'approval_binding'
  | 'shell_binding'
  | 'is_approval_required'
  | 'pre_dispatch_failure'
  | 'silent_search_query'
  | 'audit_description'
  | 'effect'
  | 'grant_host'
  | 'secret_path_read'
> {
  const decision = input.decision;
  return {
    tier: decision.tier,
    tier_reason: decision.reason,
    tier3_card: decision.card,
    tier2_kind: decision.tier2_kind,
    approval_token_id: decision.approval_token_id,
    approval_binding: decision.approval_binding,
    shell_binding: decision.shell_binding,
    // A connector read is inspection per call: its arguments decide it, not the tool's annotations.
    ...(decision.inspection ? { effect: 'inspect' as const } : {}),
    ...(decision.grant_host === null ? {} : { grant_host: decision.grant_host }),
    ...(decision.secret_path_read ? { secret_path_read: true as const } : {}),
    ...(decision.silent_search_query === null ? {} : { silent_search_query: decision.silent_search_query }),
    ...(decision.audit_description === null ? {} : { audit_description: decision.audit_description }),
    is_approval_required:
      decision.auto_deny === null &&
      (decision.tier === 3 || (decision.tier === 2 && decision.approval_token_id !== null)),
    ...(decision.auto_deny === null
      ? {}
      : {
          pre_dispatch_failure: {
            kind: 'policy_blocked' as const,
            message: autoDenyMessage(decision),
            ...(decision.owner_message === null ? {} : { owner_message: decision.owner_message }),
          },
        }),
  };
}

/** Result for a search that was settled as silent before dispatch and may no longer run. */
function searchNotRunText(input: { detail: string; unattended: boolean }): string {
  const next = input.unattended ? 'Continue without it.' : 'Try again; it will be sent for approval.';
  return JSON.stringify({ error: `The web search was not run. ${input.detail} ${next}` });
}

function autoDenyMessage(decision: TierDecision): string {
  switch (decision.auto_deny) {
    case 'offline_mode':
      return 'Auto-denied: offline mode is on.';
    case 'incomplete_send_card':
      return `Auto-denied: ${decision.reason_detail ?? 'the send cannot be shown in full.'}`;
    case 'unattended_run':
      return `Auto-denied: ${decision.reason_detail ?? 'a scheduled run cannot do this'}`;
    case 'outbound_guard':
      return `Auto-denied: ${decision.reason_detail ?? 'the outbound guard held this call back'} Continue without it.`;
    case 'private_text_check':
      return `Skipped: ${decision.reason_detail ?? 'it would have shared something from your mail or calendar.'} Continue without it.`;
    default:
      return 'Auto-denied: the destination of this external action could not be verified.';
  }
}

/** What the model is told when a web search or page read ran past its deadline. */
export const SEARCH_TOO_SLOW_MESSAGE =
  'The search took too long and was stopped. Answer from what you already have, or try one shorter search.';

const SEARCH_TOO_SLOW = Symbol('search-too-slow');

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
  private readonly searchPlumbingFields: readonly string[];
  private readonly pages: FetchedPageStore | undefined;
  private readonly pagesScope: FetchedPageScope | undefined;
  private readonly bundle: ToolBundleName | undefined;
  private readonly searchCallTimeoutMs: number | undefined;
  private readonly logger: Logger | undefined;

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
    searchProvider?: SearchProviderGrant | undefined;
    /**
     * The shared memory of pages read this session, written after every successful call so a
     * place found on a page can be checked against it whatever tool read the page. Set by the
     * host only.
     */
    pages?: FetchedPageStore | undefined;
    /**
     * The tenant and chat the pages memory is written for; a page is recorded only when the
     * host names the chat it belongs to. Set by the host only, alongside `pages`.
     */
    pagesScope?: FetchedPageScope | undefined;
    /** The guidance topic every tool of this connector is grouped under. Set by the host only; absent groups them under none. */
    bundle?: ToolBundleName | undefined;
    /**
     * How long a web search or page read may take before it is stopped and the model gets a plain
     * tool error, so the reply goes on. Applies to the designated search provider's tools and to
     * page readers. Absent, only the turn's general tool deadline applies.
     */
    searchCallTimeoutMs?: number | undefined;
    logger?: Logger | undefined;
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
    this.searchPlumbingFields = params.searchProvider?.plumbing_fields ?? [];
    this.pages = params.pages;
    this.pagesScope = params.pagesScope;
    this.bundle = params.bundle;
    this.searchCallTimeoutMs = params.searchCallTimeoutMs;
    this.logger = params.logger;
  }

  bundleOf(_toolName: string): ToolBundleName | undefined {
    void _toolName;
    return this.bundle;
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
    requested: CallToolRequest['params'],
    decision?: ApprovalDecision,
    context?: ToolInvocationContext,
  ): Promise<CallToolResponse> {
    let params = requested;
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
      params = this.withNamedArgumentsOnly({ params, tool });

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

    const response = this.withCaldavResultNote({
      params,
      response: normalizeGithubFileContentsResponse({
        serverName: this.name,
        params,
        response: await this.dispatch({ params, decision, context }),
      }),
    });
    if (
      this.pages !== undefined &&
      this.pagesScope !== undefined &&
      (this.firstParty || this.searchProvider) &&
      isPageReaderTool(params.name) &&
      isCallToolResponseResult(response) &&
      response.result.isError !== true
    ) {
      // Only Aman's own page readers record: a tool from any other server may echo its input, so its
      // text is never a page the model read.
      recordFetchedPages({
        pages: this.pages,
        scope: this.pagesScope,
        toolArguments: params.arguments ?? {},
        texts: resultTexts(response.result),
      });
    }
    if (
      this.pages !== undefined &&
      this.pagesScope !== undefined &&
      isCallToolResponseResult(response) &&
      response.result.isError !== true &&
      isSearchResultTool(params.name) &&
      ((this.firstParty && params.name === TAVILY_SEARCH_TOOL_NAME) ||
        (this.searchProvider && this.searchTools.has(params.name)))
    ) {
      // A search's results are sources, one link at a time; its query and any answer it wrote are not.
      // A provider's search_tools list also holds its page readers, so only named search tools count.
      recordSearchResults({
        pages: this.pages,
        scope: this.pagesScope,
        toolArguments: params.arguments ?? {},
        texts: resultTexts(response.result),
      });
    }
    if (this.searchProvider && this.sentinel !== undefined && isCallToolResponseResult(response)) {
      // What a search returned is what a later fetch in this turn may name. A call that itself
      // names a URL is a fetch: its page's links are not search results, so they stay unreturned.
      const sent = collectOutboundStrings(params.arguments ?? {}, this.searchPlumbingFields);
      if (sent !== undefined && !namesUrl([...sent.values, ...sent.plumbing])) {
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
      // run a call the host auto-denied.
      return toolResultResponse({
        text: JSON.stringify({ error: tool_info.pre_dispatch_failure.message }),
        isError: true,
      });
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
      return deniedToolCallResponse(decision.reason);
    }

    if (
      this.sentinel !== undefined &&
      (this.searchProvider || (decision !== undefined && isMapsToolName(params.name)))
    ) {
      // The text an approved search or map sends joins the turn's trace, so a later silent call is checked
      // against it. A silent map was recorded when it was classified, so only approved maps are added here.
      const turn = this.sentinel.web_search;
      const sent = collectOutboundStrings(params.arguments ?? {}, this.searchPlumbingFields);
      if (sent !== undefined) {
        turn.sentText = appendOutboundTrace({ earlier: turn.sentText, strings: sent });
      }
    }
    if (
      decision === undefined &&
      classification !== undefined &&
      isSilentSearchReason(classification.reason) &&
      this.sentinel !== undefined
    ) {
      // Classified as silent a moment ago inside this one-at-a-time step, so the count is current.
      const turn = this.sentinel.web_search;
      turn.silentSearches += 1;
      const sent = collectOutboundStrings(params.arguments ?? {}, this.searchPlumbingFields);
      if (sent !== undefined) {
        countSilentFetches({ values: sent.values, state: turn });
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

  /**
   * An approval was minted on the arguments the tool takes, so the dispatch check re-derives them the
   * same way; the wire still carries what the model wrote. A connector that cannot list its tools leaves
   * the wire arguments as written, which must still match the approval exactly.
   */
  async liveMintParams(params: CallToolRequest['params']): Promise<Record<string, unknown> | undefined> {
    const tool = await this.resolveTool(params.name).catch(() => undefined);
    const named = this.withNamedArgumentsOnly({ params, tool });
    return named === params ? undefined : named.arguments;
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
      // The same pruning as dispatch, so an approval covers exactly the arguments that will be sent.
      return (await this.buildToolCallInfo(this.withNamedArgumentsOnly({ params, tool }), tool, resolveUnderlyingTool))
        .info;
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

  /**
   * The event a CalDAV change names, read once before it is classified so the card can say what it
   * changes. Null when that read fails, and the card then says the title could not be read.
   */
  private async caldavEventFor(params: CallToolRequest['params']): Promise<CaldavEventReview | null | undefined> {
    if (!this.firstParty || this.name !== CALDAV_SERVER_NAME) {
      return undefined;
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const id = typeof args['id'] === 'string' ? args['id'] : undefined;
    const needsReview =
      params.name === 'update_event' ||
      params.name === 'delete_event' ||
      (params.name === 'respond_to_event' && typeof args['confirm_token'] === 'string');
    if (id === undefined || !needsReview) {
      return undefined;
    }
    try {
      const response = await this.source.callTool({ name: 'get_event', arguments: { id } });
      if (!isCallToolResponseResult(response) || response.result.isError === true) {
        return null;
      }
      return caldavEventReviewFrom({ id, result: response.result.structuredContent });
    } catch {
      return null;
    }
  }

  /** Adds the plain-words note the CalDAV reply result needs when the calendar sent no reply itself. */
  private withCaldavResultNote({
    params,
    response,
  }: {
    params: CallToolRequest['params'];
    response: CallToolResponse;
  }): CallToolResponse {
    if (!this.firstParty || this.name !== CALDAV_SERVER_NAME || !isCallToolResponseResult(response)) {
      return response;
    }
    const note = caldavResultNote({ tool_name: params.name, structured: response.result.structuredContent });
    if (note === undefined) {
      return response;
    }
    return {
      ...response,
      result: { ...response.result, content: [...response.result.content, { type: 'text', text: note }] },
    };
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
    // A preview while the call streams in has no arguments yet: classifying it would only repeat side effects (an audit row, a live read).
    if (resolveUnderlyingTool === false) {
      return { info, classification: undefined };
    }
    const caldavEvent = await this.caldavEventFor(params);
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
        mcp_search_plumbing_fields: this.searchPlumbingFields,
        caldav_event: caldavEvent,
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
        ...(this.searchProvider ? { search_provider_call: true as const } : {}),
        // An explicit require-approval selector adds a gate on top of any tier, including a
        // standing grant, but never to a call that is auto-denied without a card.
        is_approval_required:
          stamp.is_approval_required === true ||
          (decision.auto_deny === null &&
            this.policy.requiresApproval(params.name, tool?.annotations, {
              waiveUnclassified: isSilentSearchReason(decision.reason),
            })),
      },
      classification: decision,
    };
  }

  /**
   * Drops arguments the tool's schema does not name. The reply guard already does this for calls
   * the model makes directly; a call made through `call_tool` carries its arguments inside the
   * wrapper, so this is where a made-up argument is stopped before it reaches the connector.
   */
  private withNamedArgumentsOnly(input: {
    params: CallToolRequest['params'];
    tool: AgentToolSchema | undefined;
  }): CallToolRequest['params'] {
    const { params, tool } = input;
    if (tool === undefined || params.arguments === undefined) {
      return params;
    }
    const { args, dropped } = dropUnnamedArguments({
      schema: toParameterSchema(tool.inputSchema),
      args: params.arguments,
    });
    if (dropped.length === 0) {
      return params;
    }
    this.logger?.debug('Dropped arguments the tool does not take', { server: this.name, tool: params.name, dropped });
    return { ...params, arguments: args };
  }

  /** Sends the call. A web search or page read past its deadline comes back as a plain tool error. */
  private async dispatch(input: {
    params: CallToolRequest['params'];
    decision: ApprovalDecision | undefined;
    context: ToolInvocationContext | undefined;
  }): Promise<CallToolResponse> {
    const call = this.source.callTool(input.params, input.decision, input.context);
    const timeoutMs = this.searchCallTimeoutMs;
    if (timeoutMs === undefined || !(this.searchProvider || isPageReaderTool(input.params.name))) {
      return call;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooSlow = new Promise<typeof SEARCH_TOO_SLOW>(resolve => {
      timer = setTimeout(() => {
        resolve(SEARCH_TOO_SLOW);
      }, timeoutMs);
    });
    try {
      // A late answer from the provider is never read: the race has already settled the call.
      const outcome = await Promise.race([call, tooSlow]);
      if (outcome !== SEARCH_TOO_SLOW) {
        return outcome;
      }
    } finally {
      clearTimeout(timer);
    }
    this.logger?.warn('Search took too long; stopped it', { server: this.name, tool: input.params.name, timeoutMs });
    return toolResultResponse({ text: JSON.stringify({ error: SEARCH_TOO_SLOW_MESSAGE }), isError: true });
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

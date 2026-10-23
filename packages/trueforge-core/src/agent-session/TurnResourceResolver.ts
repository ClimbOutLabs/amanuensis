import type { Logger } from 'winston';
import { CALDAV_SERVER_NAME } from '../core/calendar/caldav/toolContract';
import { privateDataReadCapability } from '../core/capabilities/builtins/PrivateDataRead';
import type { TaskChecklistAccess } from '../core/capabilities/builtins/TaskChecklist';
import { MAIL_CONNECTOR_NAME } from '../core/email/mailConnector/toolContract';
import type { ILLM } from '../core/llm/ILLM';
import type { ToolSource } from '../core/mcp/IMCPServer';
import { RemoteMCP, type RemoteMcpHeaders } from '../core/mcp/RemoteMCP';
import type { ToolSelectorConfig } from '../core/mcp/ToolSelectorPolicy';
import { ToolSet } from '../core/mcp/ToolSet';
import {
  createSentinelHostContext,
  createWebSearchTurnState,
  type SearchProviderGrant,
  type SentinelHostContext,
  type SentinelServices,
} from '../core/permissions';
import type { AgentDefinition, ConfiguredModelSummary, ModelParams } from '../core/runtime/AgentDefinition';
import type { AgentInfo } from '../core/runtime/AgentThread.types';
import type { HostToolCallPolicy } from '../core/runtime/HostToolCallPolicy';
import type { ToolBundleName } from '../core/runtime/toolBundleCatalog';
import type { BoundRepository, Sandbox, SandboxInfo } from '../core/sandbox/Sandbox';
import { fetchedPages, type FetchedPageScope } from '../core/search/fetchedPages';
import type { PageFixtureSource } from '../core/search/pageFixtures';
import { isTavilyConnectorUrl, tavilyAuthFromHeader, TavilyClient } from '../core/search/TavilyClient';
import { TavilySource } from '../core/search/TavilySource';
import type { AgentTracing } from '../core/tracing/AgentTracing';
import { NOOP_AGENT_TRACING } from '../core/tracing/NoopAgentTracing';
import type { ITurnResourceResolver, ResolvedAgentDefinition } from './ITurnResourceResolver';
import type { TurnRecord } from './models/TurnRecord';
import type { AgentSpec } from './schemas/agentSpec';

/**
 * Factory that creates a Sandbox handle for a run (reattach via
 * existingSandboxId). `spec` carries the sandbox-relevant agent settings
 * (e.g. config.sandbox.file_downloads) so implementations can shape the
 * Sandbox per run without the factory type growing a field per option.
 */
export type TurnSandboxFactory = (input: {
  spec: AgentSpec;
  existingSandboxId?: string | undefined;
  tenant_id: string;
  created_by: string;
  session_id: string;
  turn_id: string;
  signal: AbortSignal;
  tracing: AgentTracing;
  sentinel: SentinelHostContext;
}) => Promise<Sandbox>;

/** The bundle a host-provisioned connector's tools are sent with: search goes with web, the first-party mail and calendar accounts with google. */
function connectorBundle(input: {
  name: string;
  firstParty: boolean;
  searchProvider: boolean;
}): ToolBundleName | undefined {
  if (input.searchProvider) {
    return 'web';
  }
  const mailOrCalendar = input.name === MAIL_CONNECTOR_NAME || input.name === CALDAV_SERVER_NAME;
  return input.firstParty && mailOrCalendar ? 'google' : undefined;
}

function specWantsSandbox(spec: AgentSpec): boolean {
  return spec.config.sandbox.enabled;
}

function toSelectors(entry: {
  enable_tools: string[];
  disable_tools: string[];
  preload_tools: string[];
  require_approval_for_tools: string[];
}): ToolSelectorConfig {
  return {
    enableTools: entry.enable_tools,
    disableTools: entry.disable_tools,
    preloadTools: entry.preload_tools,
    requireApprovalForTools: entry.require_approval_for_tools,
  };
}

/**
 * Batteries-included base implementation. Construct-and-go for the default
 * behavior; subclass and override to customize (tool sources, sandbox,
 * tracing).
 */
/**
 * Which job a model call does inside a turn: the root thread's answers, a sub-agent thread's work,
 * or context compaction on a model the spec set explicitly. Lets a host attribute usage and cost.
 */
export type TurnModelRole = 'chat' | 'delegation' | 'compaction';

interface ResolvedModel {
  modelClient: ILLM;
  defaultModelParams: ModelParams;
  /**
   * Upstream, provider-specific identifier actually sent to the provider
   * (never the catalog alias) — used only to tell the model its own name.
   * Every implementation must set this key explicitly: `undefined` for a
   * resolver that has no such identity to offer, in which case the
   * definition falls back to the catalog name it was asked to resolve.
   */
  modelId: string | undefined;
  /** See AgentDefinition.modelSupportsVision. Every implementation must set this explicitly. */
  modelSupportsVision: boolean;
  modelProperties?: AgentDefinition['modelProperties'];
}

/** The saved Authorization header of a connector, whether its headers are static or resolved at connect. */
async function authorizationHeaderOf(headers: RemoteMcpHeaders): Promise<string | undefined> {
  const resolved = typeof headers === 'function' ? await headers() : { headers };
  if (!('headers' in resolved)) {
    return undefined;
  }
  const found = Object.entries(resolved.headers).find(([name]) => name.toLowerCase() === 'authorization');
  return found?.[1];
}

export class TurnResourceResolver<
  TTurnCustom extends object = Record<string, never>,
> implements ITurnResourceResolver<TTurnCustom> {
  readonly #sources = new Map<string, Promise<ToolSource>>();
  /** MCP servers the host reported as first-party when it resolved their connection this turn. */
  readonly #firstPartyServers = new Set<string>();
  /** MCP servers the user designated as their search provider, with the host's list of their search tools and the argument names that are provider plumbing. */
  readonly #searchProviderServers = new Map<string, SearchProviderGrant>();
  readonly webSearchTurn = createWebSearchTurnState();
  readonly #models = new Map<string, Promise<ResolvedModel>>();
  #sandbox?: Sandbox | undefined;

  constructor(
    protected readonly deps: {
      /**
       * Model name → client and defaults. Called once per resolved definition;
       * may load provider config. `modelId`, when the resolver can supply one,
       * is the upstream, provider-specific identifier actually sent to the
       * provider (never the catalog alias) — used only to tell the model its
       * own name. Every implementation must set this key explicitly:
       * `undefined` for a resolver that has no such identity to offer, in
       * which case the definition falls back to the catalog name it was
       * asked to resolve.
       */
      llm: (model: string, role: TurnModelRole) => Promise<ResolvedModel>;
      /**
       * MCP server name → connection details. Required to use spec.mcp_servers:
       * the AgentSpec carries names only (no url/headers on the wire) — the
       * runtime supplies the catalog. Called once per distinct server name per
       * turn. Throw for unknown names. `headers` supports the async resolver form.
       * `first_party` is true only for a connector the host itself vouches for, never one a user,
       * a request or the model described: it lets that server's read-only, explicitly
       * closed-world tools run without a card. `search_provider` is set only for the connector the
       * user designated as their search provider, with the host's list of its search tools and the argument names that are provider plumbing: such a
       * tool runs without a card behind the outbound secret guard when the server declares it
       * read-only or the list names it.
       */
      mcp: (name: string) => Promise<{
        url: string;
        headers?: RemoteMcpHeaders;
        first_party?: boolean;
        search_provider?: SearchProviderGrant | undefined;
      }>;
      mcpRequestTimeoutMs: number;
      mcpConnectTimeoutMs: number;
      /** One sandbox type per runtime. Omit = no sandbox support. */
      sandboxProvider?: TurnSandboxFactory | undefined;
      /**
       * Page links the Tavily page reader answers from local fixtures instead of the web. Set only on an
       * eval instance; absent, every link is read from the web.
       */
      pageFixtures?: PageFixtureSource | undefined;
      /**
       * Named-agent lookup (registry id → live AgentSpec). Required when a
       * session is bound by reference; omit only if all sessions use inline agents.
       */
      agent?: ((agentId: string) => Promise<AgentSpec>) | undefined;
      /** Forwarded to RemoteMCP / AgentThread (required by their constructors). */
      logger: Logger;
      /** Optional host-owned durable task state for root-thread capabilities. */
      compactionContext?: TaskChecklistAccess | undefined;
      /**
       * Host instance-wide default for compaction_threshold_tokens, used only when the agent
       * spec leaves it unset. See ITurnResourceResolver.compactionThresholdTokensDefault.
       */
      compactionThresholdTokensDefault?: number | undefined;
      /**
       * Host instance-wide cap on concurrently dispatched read-only tool calls
       * per batch. See ITurnResourceResolver.toolDispatchMaxConcurrency.
       */
      toolDispatchMaxConcurrency?: number | undefined;
      /**
       * Host instance-wide per-tool-call dispatch deadline in milliseconds.
       * See ITurnResourceResolver.toolCallTimeoutMs.
       */
      toolCallTimeoutMs?: number | undefined;
      /**
       * sandbox/run_code's own dispatch deadline in milliseconds.
       * See ITurnResourceResolver.runCodeToolCallTimeoutMs.
       */
      runCodeToolCallTimeoutMs?: number | undefined;
      /** How long a web search or page read may take before the model gets a plain tool error instead. */
      searchCallTimeoutMs?: number | undefined;
      /**
       * Host instance-wide bound in milliseconds on waiting for a model call's
       * first output. See ITurnResourceResolver.modelFirstResponseTimeoutMs.
       */
      modelFirstResponseTimeoutMs?: number | undefined;
      /** See ITurnResourceResolver.modelIdleTimeoutMs. */
      modelIdleTimeoutMs?: number | undefined;
      /**
       * Per-run host policy over tool calls. See ITurnResourceResolver.toolCallPolicy.
       */
      toolCallPolicy?: HostToolCallPolicy | undefined;
      /** Resolved T2 binding, independent of whether this turn enables a sandbox. */
      boundRepository?: BoundRepository | undefined;
      /** See ITurnResourceResolver.serverSandboxAvailable. */
      serverSandboxAvailable?: boolean | undefined;
      /** IANA timezone name the client sent with this turn. See ITurnResourceResolver.clientTimezone. */
      clientTimezone?: string | undefined;
      /**
       * Host-configured model catalog for the model-identity section's
       * host-owned-facts list (e.g. IModelProviderStore.listModels, mapped and
       * capped by the caller). Called at most once per resolver instance
       * (single-flight, cached below) since the catalog does not change within
       * a turn: every thread of the run, root and sub-agents alike, shares the
       * same result, so it never grows the prompt prefix beyond what changes
       * when the catalog itself changes. Omit when the host has no such
       * catalog; the section then omits the list.
       */
      configuredModels?: (() => Promise<readonly ConfiguredModelSummary[]>) | undefined;
    },
  ) {}

  #configuredModelsPromise?: Promise<readonly ConfiguredModelSummary[]> | undefined;

  /** Single-flight, cached for the lifetime of this resolver instance. */
  #resolveConfiguredModels(): Promise<readonly ConfiguredModelSummary[] | undefined> {
    if (this.deps.configuredModels === undefined) {
      return Promise.resolve(undefined);
    }
    this.#configuredModelsPromise ??= this.deps.configuredModels();
    return this.#configuredModelsPromise;
  }

  get logger(): Logger {
    return this.deps.logger;
  }

  get compactionContext(): TaskChecklistAccess | undefined {
    return this.deps.compactionContext;
  }

  get compactionThresholdTokensDefault(): number | undefined {
    return this.deps.compactionThresholdTokensDefault;
  }

  get toolDispatchMaxConcurrency(): number | undefined {
    return this.deps.toolDispatchMaxConcurrency;
  }

  get toolCallTimeoutMs(): number | undefined {
    return this.deps.toolCallTimeoutMs;
  }

  get runCodeToolCallTimeoutMs(): number | undefined {
    return this.deps.runCodeToolCallTimeoutMs;
  }

  get modelFirstResponseTimeoutMs(): number | undefined {
    return this.deps.modelFirstResponseTimeoutMs;
  }

  get modelIdleTimeoutMs(): number | undefined {
    return this.deps.modelIdleTimeoutMs;
  }

  get toolCallPolicy(): HostToolCallPolicy | undefined {
    return this.deps.toolCallPolicy;
  }

  get boundRepository(): BoundRepository | undefined {
    return this.deps.boundRepository;
  }

  get serverSandboxAvailable(): boolean | undefined {
    return this.deps.serverSandboxAvailable;
  }

  get clientTimezone(): string | undefined {
    return this.deps.clientTimezone;
  }

  /** Default: no-op tracing. Override to plug in a real tracer. */
  createTracing(): AgentTracing {
    return NOOP_AGENT_TRACING;
  }

  /** Named (ref) session agent → live registry lookup via deps.agent. */
  async resolveAgentSpec(input: { agent_id: string }): Promise<AgentSpec> {
    if (this.deps.agent === undefined) {
      // Host forgot to wire deps.agent — not "agent id missing from the registry"
      // (that failure belongs in the lookup callback, e.g. HTTP 422 on the server).
      throw new Error(
        `Named agent '${input.agent_id}' cannot be resolved: no agent lookup configured on the turn resolver`,
      );
    }
    return await this.deps.agent(input.agent_id);
  }

  /**
   * Default: creates a sandbox iff a provider is configured AND the spec wants
   * one; reattaches to the previous turn's VM via `existing.sandbox_id` when
   * present. Overrides that resolve their own sandbox must assign it so
   * close() can release it (or override close() too).
   */
  async resolveSandbox(input: {
    spec: AgentSpec;
    existing?: SandboxInfo | undefined;
    previousTurn?: TurnRecord<TTurnCustom> | undefined;
    tenant_id: string;
    created_by: string;
    session_id: string;
    turn_id: string;
    signal: AbortSignal;
    tracing: AgentTracing;
    sentinel: SentinelHostContext;
  }): Promise<Sandbox | undefined> {
    if (!this.deps.sandboxProvider || !specWantsSandbox(input.spec)) {
      return undefined;
    }
    this.#sandbox = await this.deps.sandboxProvider({
      spec: input.spec,
      existingSandboxId: input.existing?.sandbox_id,
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      session_id: input.session_id,
      turn_id: input.turn_id,
      signal: input.signal,
      tracing: input.tracing,
      sentinel: input.sentinel,
    });
    return this.#sandbox;
  }

  /**
   * Closes the sandbox HANDLE if one was resolved. This releases only this
   * process's connection (local bridge); the sandbox VM keeps running and the
   * next turn reattaches via `existing.sandbox_id`.
   *
   * Tool sources (MCP connections) are intentionally NOT closed: the run's
   * AbortSignal already aborts their in-flight calls, and connections are
   * per-run objects that are simply dropped. If deterministic MCP socket
   * release is ever needed, add it here — no contract change required.
   *
   * Subclasses that acquire additional resources MUST override, release
   * their own resources best-effort, and call `await super.close()`.
   * Idempotent; never throws.
   */
  async close(): Promise<void> {
    const sandbox = this.#sandbox;
    this.#sandbox = undefined;
    await sandbox?.close().catch(() => {
      /* no-op */
    });
  }

  /**
   * Default: maps the spec directly to a definition — spec.mcp_servers carry
   * names only; deps.mcp resolves each name to url/headers, and the result
   * becomes a RemoteMCP source (deduped per turn via getOrCreateToolSource)
   * wrapped in a per-agent ToolSet view. Passes the previous turn's persisted
   * MCP session_id into RemoteMCP for cross-turn stateful resume.
   */
  async resolveAgentDefinition(input: {
    spec: AgentSpec;
    agent_info?: AgentInfo | undefined;
    previousTurn?: TurnRecord<TTurnCustom> | undefined;
    signal: AbortSignal;
    tracing: AgentTracing;
    tenant_id: string;
    created_by: string;
    session_id: string;
    sentinel_services?: SentinelServices | undefined;
    workspace_cwd?: string | null | undefined;
  }): Promise<ResolvedAgentDefinition> {
    const {
      spec,
      agent_info: agentInfo,
      previousTurn,
      signal,
      tracing,
      tenant_id,
      created_by,
      session_id,
      sentinel_services,
      workspace_cwd,
    } = input;
    const sentinel: SentinelHostContext = createSentinelHostContext({
      services: sentinel_services,
      tenant_id,
      created_by,
      conversation_id: session_id,
      workspace_cwd: workspace_cwd ?? null,
      web_search: this.webSearchTurn,
    });
    const pageScope: FetchedPageScope = { tenant_id, conversation_id: session_id };
    const toolSets = await Promise.all(
      (spec.mcp_servers ?? []).map(async entry => {
        const source = await this.getOrCreateToolSource({
          id: entry.name,
          create: async () => {
            const { url, headers, first_party, search_provider } = await this.deps.mcp(entry.name);
            if (first_party === true) {
              this.#firstPartyServers.add(entry.name);
            }
            if (search_provider !== undefined) {
              this.#searchProviderServers.set(entry.name, search_provider);
            }
            if (search_provider !== undefined && isTavilyConnectorUrl(url)) {
              return new TavilySource({
                id: entry.name,
                name: entry.name,
                client: new TavilyClient({
                  auth: tavilyAuthFromHeader(await authorizationHeaderOf(headers ?? {})),
                  fetchImpl: (target, init) => fetch(target, init),
                }),
                pages: fetchedPages,
                scope: pageScope,
                pageFixtures: this.deps.pageFixtures,
              });
            }
            return new RemoteMCP({
              id: entry.name,
              name: entry.name,
              url,
              headers: headers ?? {},
              sessionId: previousTurn?.snapshot.mcp_servers?.[entry.name]?.session_id,
              requestTimeoutMs: this.deps.mcpRequestTimeoutMs,
              connectTimeoutMs: this.deps.mcpConnectTimeoutMs,
              // A vouched-for or designated connector must not hand its trust to wherever it redirects.
              refuseRedirects: first_party === true || search_provider !== undefined,
              logger: this.deps.logger,
              tracing,
              signal,
            });
          },
        });
        return new ToolSet({
          source,
          selectors: toSelectors(entry),
          preload: entry.preload,
          sentinel,
          firstParty: this.#firstPartyServers.has(entry.name),
          searchProvider: this.#searchProviderServers.get(entry.name),
          bundle: connectorBundle({
            name: entry.name,
            firstParty: this.#firstPartyServers.has(entry.name),
            searchProvider: this.#searchProviderServers.has(entry.name),
          }),
          pages: fetchedPages,
          pagesScope: pageScope,
          searchCallTimeoutMs: this.deps.searchCallTimeoutMs,
          logger: this.deps.logger,
        });
      }),
    );
    // Sub-agents may request a different catalog model via agent_info.model;
    // resolve that name so modelClient matches the override (not just a label).
    //
    // Precedence, strongest first: a model the sub-agent explicitly asked for,
    // the host's configured delegation role, then the main model. A configured
    // default must never override a deliberate request, so the role drops out
    // entirely once agent_info names a model. Params travel with whichever model
    // was selected, because parameters tuned for the main model can be
    // meaningless, or actively wrong, for a different one.
    const delegation =
      agentInfo === undefined || agentInfo.model !== undefined ? undefined : spec.auxiliary_models?.delegation;
    const selectedModel = delegation ?? spec.model;
    const modelName = agentInfo?.model ?? selectedModel.name;
    const resolvedModel = await this.getModel({ modelName, role: agentInfo === undefined ? 'chat' : 'delegation' });
    const modelParams =
      agentInfo?.model !== undefined
        ? { ...resolvedModel.defaultModelParams }
        : { ...resolvedModel.defaultModelParams, ...selectedModel.params };

    // Compaction role: resolve a distinct model only when the spec configures
    // one AND the capability is actually enabled for this spec — an unused
    // override must never turn into a turn-blocking failure. Left undefined
    // (unset, or compaction disabled), the capability inherits
    // definition.modelClient/modelParams below, so an unset role always tracks
    // the thread's own model, including across a later change to spec.model.
    // Failures from deps.llm (unknown/unavailable model) are intentionally
    // left to propagate — the same visible, attributable error convention as
    // the main model and the delegation role above, never a silent
    // substitution.
    const compactionSetting = spec.config.context_management.compaction.enabled
      ? spec.auxiliary_models?.compaction
      : undefined;
    const compactionModel = compactionSetting
      ? await this.getModel({ modelName: compactionSetting.name, role: 'compaction' }).then(resolved => ({
          modelClient: resolved.modelClient,
          modelParams: { ...resolved.defaultModelParams, ...compactionSetting.params },
          modelProperties: resolved.modelProperties,
        }))
      : undefined;

    // Cached per resolver instance so this is at most one call per turn,
    // shared unchanged across the root thread and every sub-agent thread;
    // see #resolveConfiguredModels.
    const configuredModels = await this.#resolveConfiguredModels();

    return {
      definition: {
        modelClient: resolvedModel.modelClient,
        // The real upstream identifier when the resolver supplied one, used
        // verbatim (a slash can be part of a valid upstream id, e.g. a
        // Hugging Face style "org/model" id served by vLLM). Falls back to
        // the catalog FQN (provider/name) it was asked to resolve for
        // resolvers that cannot supply a real identity (see deps.llm above);
        // only that fallback is provider-qualified, so only it gets the
        // prefix stripped here. An FQN with no slash passes through
        // unchanged.
        modelId: resolvedModel.modelId ?? modelName.slice(modelName.indexOf('/') + 1),
        modelSupportsVision: resolvedModel.modelSupportsVision,
        configuredModels,
        modelProperties: resolvedModel.modelProperties,
        clientTimezone: this.deps.clientTimezone,
        // Sub-agents receive the delegated task as a user message; their system
        // prompt is SUB_AGENT_IDENTITY (added by AgentThread), not user instructions.
        instruction: agentInfo ? undefined : spec.instructions,
        messages: agentInfo
          ? [
              {
                role: 'user' as const,
                content: agentInfo.workspace_cwd
                  ? `Host-bound coding workspace: ${agentInfo.workspace_cwd}\nUse this checkout for all source inspection, edits, commands, and verification. Do not use GitHub connectors to read or edit source.\n\nDelegated task:\n${agentInfo.input}`
                  : agentInfo.input,
              },
            ]
          : spec.messages?.map(m => ({ role: 'user' as const, content: m.content })),
        modelParams,
        // Sub-agents should return free-form summaries to the parent, not the user-facing structured response.
        responseFormat: agentInfo ? undefined : spec.response_format,
        iterationLimit: spec.config.iteration_limit,
        // Opt-in only: undefined leaves task state fully inert.
        toolCallBudget: spec.config.task_state.tool_call_budget,
        budgetedTools: spec.config.task_state.budgeted_tools,
        toolSets,
      },
      compactionModel,
      // Only the root thread holds the chat's private-read state. A sub-agent's mail and calendar reads reach the
      // same turn state through its tool set, so the flag and the text checks still cover them.
      extraCapabilities: agentInfo === undefined ? [privateDataReadCapability({ turn: this.webSearchTurn })] : [],
    };
  }

  /**
   * Returns the tool source for `id`, creating it on first call — use from
   * resolveAgentDefinition overrides so agents sharing a server share one
   * connection. Single-flight by id: the promise is stored synchronously (no
   * await between get and set), so overlapping resolveAgentDefinition calls
   * can never double-create. Rejections stay cached: one attempt per turn.
   * Do not override.
   */
  protected getOrCreateToolSource(input: { id: string; create: () => Promise<ToolSource> }): Promise<ToolSource> {
    const cached = this.#sources.get(input.id);
    if (cached) {
      return cached;
    }
    const made = input.create();
    this.#sources.set(input.id, made);
    return made;
  }

  /**
   * Resolves `deps.llm` once per distinct model name and role for this turn. The role is part of
   * the key so each job gets its own client and a host can attribute every call to it.
   */
  protected getModel({ modelName, role }: { modelName: string; role: TurnModelRole }): Promise<ResolvedModel> {
    const key = `${role}\u0000${modelName}`;
    const cached = this.#models.get(key);
    if (cached) {
      return cached;
    }
    const made = this.deps.llm(modelName, role);
    this.#models.set(key, made);
    return made;
  }
}

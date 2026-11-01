import {
  AgentSpecSchema,
  narrowConnectorTools,
  type AgentSpec,
  type ResolvedAgentDefinition,
} from '@truefoundry/trueforge-core/agent-session';
import type { AgentCapability } from '@truefoundry/trueforge-core/core';
import { TOOL_TAG_READ_ONLY } from '@truefoundry/trueforge-core/core';
import { CALDAV_SERVER_NAME, CALDAV_TOOL_NAMES } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import {
  connectorOffKey,
  DEFAULT_ON_SOURCE_CONNECTOR_NAMES,
} from '@truefoundry/trueforge-core/core/connectors/chatConnectorChoice';
import { MailAttachmentProcessor } from '@truefoundry/trueforge-core/core/email/mailConnector/MailAttachmentProcessor';
import {
  MAIL_CONNECTOR_NAME,
  MAIL_CONNECTOR_TOOL_NAMES,
} from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import type { WebSearchTurnState } from '@truefoundry/trueforge-core/core/permissions/webSearch';
import type { PersonaKnowledgeHit } from '../personaKnowledge/knowledgeRetrieval';
import type { PersonalizationProfile } from '../personalization/profile';
import type { PersonaContext } from '../personas/persona';
import type { InternalSourceState } from './internalSourceGuard';
import { hindsightMemoryCapability, type MemoryConfig } from './memory/memoryCapability';
import type { MemoryClient } from './memory/memoryClient';
import type { SummarizeTurnContext } from './memory/memoryRetain';
import { PersonaTurnResourceResolver, type PersonaSwitchNotice } from './PersonaTurnResourceResolver';
import { isStaleSearchProviderMount } from './sessionResources';
import { toolOutputScreenCapability, type ToolOutputScreenConfig } from './toolOutputScreen';

export type { ToolOutputScreenConfig } from './toolOutputScreen';

/** Everything one turn needs from the configured memory provider, resolved once in `apis/turns.ts`. */
export interface MemoryTurnContext {
  /** Undefined when no usable memory provider is configured: the turn then runs without memory. */
  client: MemoryClient | undefined;
  config: MemoryConfig;
  sessionId: string;
  previousTurnId: string | null;
  /** MCP server name of the provider, so its mount can be narrowed to reads. Undefined with no provider. */
  providerServerName: string | undefined;
  /** Name of the connector designated as the web search provider, looked up per turn. Undefined when none is designated. */
  searchProviderServerName?: (() => Promise<string | undefined>) | undefined;
  /** Names of the catalog presets offered as a web search provider. Absent: no remembered mount is dropped as stale. */
  searchProviderPresetNames?: (() => readonly string[]) | undefined;
  /** Off keys (see connectorOffKey) of the connectors the person turned off for this chat. Absent: nothing is off. */
  turnedOffConnectorKeys?: readonly string[] | undefined;
  /** When false, memory recall is off for this turn: the user disabled it for the session, or the turn runs unattended. */
  recallEnabled?: boolean | undefined;
  /** Present when summaries are on for this turn, so a vanished earlier turn is never rebuilt as a raw exchange. */
  summarize: SummarizeTurnContext | undefined;
  /** The person's IANA time zone from the request; a recalled memory's day is shown in it. */
  clientTimezone?: string | undefined;
  /**
   * Per-turn internal-source state. Recall records what it injected here so
   * the turn's tool policy can block web_search as a substitute for recall.
   */
  internalSourceState?: InternalSourceState | undefined;
}

/** Root-only: sub-agent threads get no memory capability (same gating as personalization/persona). */
function memoryCapabilitiesForTurn(input: {
  memory: MemoryTurnContext;
  webSearch: WebSearchTurnState;
  logger: PersonaTurnResourceResolver['logger'];
  isSubAgent: boolean;
}): AgentCapability[] {
  const { memory } = input;
  if (memory.client === undefined || input.isSubAgent) {
    return [];
  }
  return [
    hindsightMemoryCapability({
      client: memory.client,
      config: memory.config,
      logger: input.logger,
      sessionId: memory.sessionId,
      previousTurnId: memory.previousTurnId,
      recallEnabled: memory.recallEnabled,
      keepsFullExchange: memory.summarize === undefined,
      timeZone: memory.clientTimezone,
      internalSourceState: memory.internalSourceState,
      webSearch: input.webSearch,
    }),
  ];
}

/**
 * Narrows the memory provider's own mount to its read tools, preloaded.
 *
 * The host already retains every completed turn into that bank, so the model has nothing to
 * gain from the bank's write tools and three things to lose: a duplicate write, an approval
 * prompt for a retention that already happened, and a turn spent narrating a call it cannot
 * make. Preloading what survives also lifts the connector out of deferred discovery
 * (`DeferredTool` lists a server only while `preload` is false), so the model reads real tool
 * definitions instead of inferring a tool name from a server name.
 *
 * `@read-only` is annotation-driven (`readOnlyHint === true`) and fails closed: a bank whose
 * tools carry no annotations contributes nothing, which is the safe end of that trade when the
 * host owns retention either way. `disable_tools` is left as configured, so an operator can
 * still subtract from what survives.
 */
function withMemoryProviderNarrowedToReads(spec: AgentSpec, providerServerName: string): AgentSpec {
  const servers = spec.mcp_servers;
  if (!servers?.some(entry => entry.name === providerServerName)) {
    return spec;
  }
  return {
    ...spec,
    mcp_servers: servers.map(entry =>
      entry.name === providerServerName ? { ...entry, enable_tools: [TOOL_TAG_READ_ONLY], preload: true } : entry,
    ),
  };
}

/**
 * The Email connector's attachments go into the sandbox on every thread that mounts the host's own Email
 * connector. A connector that only carries the name is not it, so its results are never placed in the sandbox.
 */
function mailAttachmentCapabilities({
  spec,
  hostOwnsMail,
}: {
  spec: AgentSpec;
  hostOwnsMail: boolean;
}): AgentCapability[] {
  if (!hostOwnsMail || !spec.mcp_servers?.some(entry => entry.name === MAIL_CONNECTOR_NAME)) {
    return [];
  }
  return [{ toolResponseProcessors: [new MailAttachmentProcessor()] }];
}

/** A connector offered to every root thread, so a chat that never opened Add-ons still has it. */
function withConnectorAttached(spec: AgentSpec, serverName: string): AgentSpec {
  const servers = spec.mcp_servers ?? [];
  if (servers.some(entry => entry.name === serverName)) {
    return spec;
  }
  const [attached] = AgentSpecSchema.shape.mcp_servers.unwrap().parse([{ name: serverName }]);
  return attached === undefined ? spec : { ...spec, mcp_servers: [...servers, attached] };
}

/**
 * The spec with remembered mounts of a deleted search provider removed. A chat's remembered
 * spec can still name a connector the person deleted after moving the search provider role to
 * another one; resolving that name would fail the whole turn, and the designated provider is
 * attached anyway. Only preset names that are not set up and do not hold the role are dropped,
 * one log line each; anything else is left for the ordinary unknown-server error. A set-up list
 * that could not be read proves nothing is missing, so nothing is dropped then.
 */
function withoutStaleSearchProviderMounts(input: {
  spec: AgentSpec;
  searchProviderPresetNames: readonly string[];
  configuredNames: readonly string[] | undefined;
  designatedName: string | undefined;
  logger: PersonaTurnResourceResolver['logger'];
}): AgentSpec {
  const servers = input.spec.mcp_servers;
  if (servers === undefined || input.configuredNames === undefined) {
    return input.spec;
  }
  const configured = new Set(input.configuredNames);
  const kept = servers.filter(entry => {
    const stale =
      !configured.has(entry.name) &&
      isStaleSearchProviderMount({
        name: entry.name,
        searchProviderPresetNames: input.searchProviderPresetNames,
        designatedName: input.designatedName,
      });
    if (stale) {
      input.logger.warn(
        `Dropped a stale search provider mount "${entry.name}" from the turn spec: that connector is not configured and is not the designated search provider.`,
      );
    }
    return !stale;
  });
  return kept.length === servers.length ? input.spec : { ...input.spec, mcp_servers: kept };
}

/** Adds host-enforced long-term memory (recall + retain) to the root thread of one turn. */
export class MemoryTurnResourceResolver extends PersonaTurnResourceResolver {
  readonly #memory: MemoryTurnContext;
  readonly #toolOutputScreen: ToolOutputScreenConfig;

  constructor(
    deps: ConstructorParameters<typeof PersonaTurnResourceResolver>[0],
    profile: PersonalizationProfile | undefined,
    persona: PersonaContext | undefined,
    memory: MemoryTurnContext,
    toolOutputScreen: ToolOutputScreenConfig,
    personaKnowledgeBlock?: string,
    personaKnowledgeHits?: readonly PersonaKnowledgeHit[],
    switchNotice?: PersonaSwitchNotice,
  ) {
    super(deps, profile, persona, personaKnowledgeBlock, personaKnowledgeHits, switchNotice);
    this.#memory = memory;
    this.#toolOutputScreen = toolOutputScreen;
  }

  /**
   * The spec with the set-up Email and Calendar connectors attached, unless the chat turned
   * them off. A set-up list that could not be read attaches nothing: a turn must not gain a
   * connector whose setup could not be confirmed.
   */
  async #withDefaultSourcesAttached(spec: AgentSpec, turnedOff: ReadonlySet<string>): Promise<AgentSpec> {
    const setUpConnectorNames = await this.setUpConnectorNames;
    if (setUpConnectorNames === undefined) {
      return spec;
    }
    let next = spec;
    for (const name of DEFAULT_ON_SOURCE_CONNECTOR_NAMES) {
      if (setUpConnectorNames.includes(name) && !turnedOff.has(connectorOffKey(name))) {
        next = withConnectorAttached(next, name);
      }
    }
    return next;
  }

  override async resolveAgentDefinition(
    input: Parameters<PersonaTurnResourceResolver['resolveAgentDefinition']>[0],
  ): Promise<ResolvedAgentDefinition> {
    const isSubAgent = input.agent_info !== undefined;
    const providerServerName = this.#memory.providerServerName;
    // Root threads only, matching where the memory capability itself is attached: a sub-agent
    // is not the thread the host retains, so its mounts are left exactly as the spec states them.
    const designatedSearchProvider = isSubAgent ? undefined : await this.#memory.searchProviderServerName?.();
    const turnedOff = new Set(this.#memory.turnedOffConnectorKeys ?? []);
    // A chat that turned search off keeps it off: the designated provider is not offered again.
    const searchProviderServerName =
      designatedSearchProvider !== undefined && turnedOff.has(connectorOffKey(designatedSearchProvider))
        ? undefined
        : designatedSearchProvider;
    // The list holds Email and Calendar only when they are the host's own, so it also decides what is trusted by name.
    const setUpConnectorNames = await this.setUpConnectorNames;
    const baseSpec = isSubAgent
      ? input.spec
      : withoutStaleSearchProviderMounts({
          spec: input.spec,
          searchProviderPresetNames: this.#memory.searchProviderPresetNames?.() ?? [],
          configuredNames: setUpConnectorNames,
          designatedName: designatedSearchProvider,
          logger: this.logger,
        });
    const defaultedSpec = isSubAgent ? baseSpec : await this.#withDefaultSourcesAttached(baseSpec, turnedOff);
    const narrowedSpec =
      providerServerName === undefined || isSubAgent
        ? defaultedSpec
        : withMemoryProviderNarrowedToReads(defaultedSpec, providerServerName);
    // Narrowing only takes tools away, so it also applies while the set-up list cannot be read.
    const narrowsHostConnector = (name: string): boolean =>
      setUpConnectorNames === undefined || setUpConnectorNames.includes(name);
    // The host's Email connector is offered only its eight tools on every thread, sub-agents included.
    const mailNarrowedSpec = narrowsHostConnector(MAIL_CONNECTOR_NAME)
      ? narrowConnectorTools(narrowedSpec, { server_name: MAIL_CONNECTOR_NAME, tools: MAIL_CONNECTOR_TOOL_NAMES })
      : narrowedSpec;
    // The host's Calendar connector is offered only its eight tools on every thread, sub-agents included.
    const calendarNarrowedSpec = narrowsHostConnector(CALDAV_SERVER_NAME)
      ? narrowConnectorTools(mailNarrowedSpec, { server_name: CALDAV_SERVER_NAME, tools: CALDAV_TOOL_NAMES })
      : mailNarrowedSpec;
    const effectiveSpec =
      searchProviderServerName === undefined
        ? calendarNarrowedSpec
        : withConnectorAttached(calendarNarrowedSpec, searchProviderServerName);
    const resolved = await super.resolveAgentDefinition({ ...input, spec: effectiveSpec });
    // An explicit recallEnabled on the turn wins over the spec (defaults to true per schema):
    // unattended runs pass false so their own earlier tasks cannot fingerprint-block their searches.
    const recallEnabled = this.#memory.recallEnabled ?? input.spec.config.memory.recall_enabled;
    const memoryCapabilities = memoryCapabilitiesForTurn({
      memory: { ...this.#memory, recallEnabled },
      webSearch: this.webSearchTurn,
      logger: this.logger,
      isSubAgent,
    });
    const outputScreen = toolOutputScreenCapability({ config: this.#toolOutputScreen });
    const extraCapabilities = [
      ...memoryCapabilities,
      ...(outputScreen === undefined ? [] : [outputScreen]),
      ...mailAttachmentCapabilities({
        spec: effectiveSpec,
        hostOwnsMail: setUpConnectorNames?.includes(MAIL_CONNECTOR_NAME) === true,
      }),
    ];
    if (extraCapabilities.length === 0) {
      return resolved;
    }
    return {
      ...resolved,
      extraCapabilities: [...(resolved.extraCapabilities ?? []), ...extraCapabilities],
    };
  }
}

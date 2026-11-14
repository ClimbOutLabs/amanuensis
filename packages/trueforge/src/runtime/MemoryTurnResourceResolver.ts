import {
  AgentSpecSchema,
  narrowConnectorTools,
  type AgentSpec,
  type ResolvedAgentDefinition,
} from '@truefoundry/trueforge-core/agent-session';
import type { AgentCapability } from '@truefoundry/trueforge-core/core';
import { createSentinelHostContext, execFileRunner } from '@truefoundry/trueforge-core/core';
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
import { memoryCapability, type MemoryConfig } from './memory/memoryCapability';
import type { MemoryClient } from './memory/memoryClient';
import { memoryPagesCapability } from './memory/memoryPagesTools';
import type { SummarizeTurnContext } from './memory/memoryRetain';
import { TurnReadWatch } from './memory/turnReadWatch';
import { PersonaTurnResourceResolver, type PersonaSwitchNotice } from './PersonaTurnResourceResolver';
import { isStaleSearchProviderMount } from './sessionResources';
import { toolOutputScreenCapability, type ToolOutputScreenConfig } from './toolOutputScreen';

export type { ToolOutputScreenConfig } from './toolOutputScreen';

/** Everything one turn needs from memory, resolved once in `apis/turns.ts`. */
export interface MemoryTurnContext {
  /** Undefined when the turn runs without memory. */
  client: MemoryClient | undefined;
  config: MemoryConfig;
  sessionId: string;
  previousTurnId: string | null;
  /** Name of the connector designated as the web search provider, looked up per turn. Undefined when none is designated. */
  searchProviderServerName?: (() => Promise<string | undefined>) | undefined;
  /** Names of the catalog presets offered as a web search provider. Absent: no remembered mount is dropped as stale. */
  searchProviderPresetNames?: (() => readonly string[]) | undefined;
  /** Off keys (see connectorOffKey) of the connectors the person turned off for this chat. Absent: nothing is off. */
  turnedOffConnectorKeys?: readonly string[] | undefined;
  /** When false, memory recall is off for this turn: the user disabled it for the session, or the turn runs unattended. */
  recallEnabled?: boolean | undefined;
  /** Reads the facts the person pulled out of this chat's recall, from where they are stored with the chat. Absent: nothing is excluded. */
  loadRecallExclusions?: (() => Promise<readonly string[]>) | undefined;
  /** Present when summaries are on for this turn, so a vanished earlier turn is never rebuilt as a raw exchange. */
  summarize: SummarizeTurnContext | undefined;
  /** The person's IANA time zone from the request; a recalled memory's day is shown in it. */
  clientTimezone?: string | undefined;
  /**
   * Per-turn internal-source state. Recall records what it injected here so
   * the turn's tool policy can block web_search as a substitute for recall.
   */
  internalSourceState?: InternalSourceState | undefined;
  /** True in a private chat: memory is read as usual and nothing from the chat is saved. */
  keepsNothing: boolean;
}

/** Root-only: sub-agent threads get no memory capability (same gating as personalization/persona). */
function memoryCapabilitiesForTurn(input: {
  memory: MemoryTurnContext;
  webSearch: WebSearchTurnState;
  logger: PersonaTurnResourceResolver['logger'];
  isSubAgent: boolean;
  /** The memory page tools for this turn and the watch they share with the memory block, when they are offered. */
  pageTools: { capability: AgentCapability; watch: TurnReadWatch } | undefined;
}): AgentCapability[] {
  const { memory } = input;
  if (memory.client === undefined || input.isSubAgent) {
    return [];
  }
  return [
    ...(input.pageTools === undefined ? [] : [input.pageTools.capability]),
    memoryCapability({
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
      keepsNothing: memory.keepsNothing,
      pageToolsWatch: input.pageTools?.watch,
      loadRecallExclusions: memory.loadRecallExclusions,
    }),
  ];
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
  readonly #personName: string | undefined;
  #chatWrotePages = false;

  /** True once a page tool has changed a page in this turn: the chat filed the message itself. */
  get chatWrotePages(): boolean {
    return this.#chatWrotePages;
  }

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
    super(deps, profile, persona, personaKnowledgeBlock, personaKnowledgeHits, switchNotice, {
      // A chat that turned the search provider off keeps it off for the guide too:
      // the lookup the guide's tool is built from answers as if nothing were designated.
      searchProviderServerName:
        memory.searchProviderServerName === undefined
          ? undefined
          : async () => {
              const designated = await memory.searchProviderServerName?.();
              if (designated === undefined) {
                return undefined;
              }
              const turnedOff = new Set(memory.turnedOffConnectorKeys ?? []);
              return turnedOff.has(connectorOffKey(designated)) ? undefined : designated;
            },
    });
    this.#memory = memory;
    this.#toolOutputScreen = toolOutputScreen;
    this.#personName = profile?.user_name ?? undefined;
  }

  /** True in an incognito chat: nothing from it may outlive it. */
  protected get keepsNothing(): boolean {
    return this.#memory.keepsNothing;
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

  /**
   * The memory page tools, offered only where pages can be written: the Markdown backend, a chat with memory on,
   * and a root thread. A chat with memory switched off, an unattended run (recall off) and a private chat get none.
   */
  #pageTools({
    input,
    recallEnabled,
    isSubAgent,
  }: {
    input: Parameters<PersonaTurnResourceResolver['resolveAgentDefinition']>[0];
    recallEnabled: boolean;
    isSubAgent: boolean;
  }): { capability: AgentCapability; watch: TurnReadWatch } | undefined {
    const vaultDir =
      isSubAgent || !recallEnabled || this.#memory.keepsNothing ? undefined : this.#memory.client?.pagesWriteDir?.();
    if (vaultDir === undefined) {
      return undefined;
    }
    const watch = new TurnReadWatch();
    const capability = memoryPagesCapability({
      vaultDir,
      runner: execFileRunner,
      timeZone: this.#memory.clientTimezone,
      now: () => new Date(),
      logger: this.logger,
      tracing: input.tracing,
      sentinel: createSentinelHostContext({
        services: input.sentinel_services,
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        conversation_id: input.session_id,
        workspace_cwd: input.workspace_cwd ?? null,
        web_search: this.webSearchTurn,
      }),
      keepsNothing: this.#memory.keepsNothing,
      maxPageTokens: this.#memory.config.pages.maxTokens,
      watch,
      personName: this.#personName,
      onPageWritten: () => {
        this.#chatWrotePages = true;
      },
    });
    return { capability, watch };
  }

  override async resolveAgentDefinition(
    input: Parameters<PersonaTurnResourceResolver['resolveAgentDefinition']>[0],
  ): Promise<ResolvedAgentDefinition> {
    const isSubAgent = input.agent_info !== undefined;
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
    // Narrowing only takes tools away, so it also applies while the set-up list cannot be read.
    const narrowsHostConnector = (name: string): boolean =>
      setUpConnectorNames === undefined || setUpConnectorNames.includes(name);
    // The host's Email connector is offered only its eight tools on every thread, sub-agents included.
    const mailNarrowedSpec = narrowsHostConnector(MAIL_CONNECTOR_NAME)
      ? narrowConnectorTools(defaultedSpec, { server_name: MAIL_CONNECTOR_NAME, tools: MAIL_CONNECTOR_TOOL_NAMES })
      : defaultedSpec;
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
      pageTools: this.#pageTools({ input, recallEnabled, isSubAgent }),
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

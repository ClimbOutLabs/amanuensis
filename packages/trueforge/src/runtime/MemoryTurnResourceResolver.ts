import {
  AgentSpecSchema,
  narrowConnectorTools,
  type AgentSpec,
  type ResolvedAgentDefinition,
} from '@truefoundry/trueforge-core/agent-session';
import type { AgentCapability } from '@truefoundry/trueforge-core/core';
import { TOOL_TAG_READ_ONLY } from '@truefoundry/trueforge-core/core';
import { CALDAV_SERVER_NAME, CALDAV_TOOL_NAMES } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import { MailAttachmentProcessor } from '@truefoundry/trueforge-core/core/email/mailConnector/MailAttachmentProcessor';
import {
  MAIL_CONNECTOR_NAME,
  MAIL_CONNECTOR_TOOL_NAMES,
} from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import type { PersonaKnowledgeHit } from '../personaKnowledge/knowledgeRetrieval';
import type { PersonalizationProfile } from '../personalization/profile';
import type { PersonaContext } from '../personas/persona';
import type { InternalSourceState } from './internalSourceGuard';
import { hindsightMemoryCapability, type MemoryConfig } from './memory/memoryCapability';
import type { MemoryClient } from './memory/memoryClient';
import { PersonaTurnResourceResolver, type PersonaSwitchNotice } from './PersonaTurnResourceResolver';
import { toolOutputScreenCapability, type ToolOutputScreenConfig } from './toolOutputScreen';

export type { ToolOutputScreenConfig } from './toolOutputScreen';

/** Everything one turn needs from the configured memory provider, resolved once in `apis/turns.ts`. */
export interface MemoryTurnContext {
  /** Undefined when no usable memory provider is configured: the turn then runs without memory. */
  client: MemoryClient | undefined;
  config: MemoryConfig;
  sessionId: string;
  previousTurnId: string | null;
  sessionTitle: string | undefined;
  /** MCP server name of the provider, so its mount can be narrowed to reads. Undefined with no provider. */
  providerServerName: string | undefined;
  /** Name of the connector designated as the web search provider, looked up per turn. Undefined when none is designated. */
  searchProviderServerName?: (() => Promise<string | undefined>) | undefined;
  /** When false, the user has disabled memory recall and retention for this session. */
  recallEnabled?: boolean | undefined;
  /**
   * Per-turn internal-source state. Recall records what it injected here so
   * the turn's tool policy can block web_search as a substitute for recall.
   */
  internalSourceState?: InternalSourceState | undefined;
}

/** Root-only: sub-agent threads get no memory capability (same gating as personalization/persona). */
function memoryCapabilitiesForTurn(input: {
  memory: MemoryTurnContext;
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
      sessionTitle: memory.sessionTitle,
      recallEnabled: memory.recallEnabled,
      internalSourceState: memory.internalSourceState,
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

/** The Email connector's attachments go into the sandbox on every thread that mounts the connector. */
function mailAttachmentCapabilities(spec: AgentSpec): AgentCapability[] {
  if (!spec.mcp_servers?.some(entry => entry.name === MAIL_CONNECTOR_NAME)) {
    return [];
  }
  return [{ toolResponseProcessors: [new MailAttachmentProcessor()] }];
}

/** The designated search provider is offered to every root thread, so a chat that never opened Add-ons still searches. */
function withSearchProviderAttached(spec: AgentSpec, searchProviderServerName: string): AgentSpec {
  const servers = spec.mcp_servers ?? [];
  if (servers.some(entry => entry.name === searchProviderServerName)) {
    return spec;
  }
  const [attached] = AgentSpecSchema.shape.mcp_servers.unwrap().parse([{ name: searchProviderServerName }]);
  return attached === undefined ? spec : { ...spec, mcp_servers: [...servers, attached] };
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

  override async resolveAgentDefinition(
    input: Parameters<PersonaTurnResourceResolver['resolveAgentDefinition']>[0],
  ): Promise<ResolvedAgentDefinition> {
    const isSubAgent = input.agent_info !== undefined;
    const providerServerName = this.#memory.providerServerName;
    // Root threads only, matching where the memory capability itself is attached: a sub-agent
    // is not the thread the host retains, so its mounts are left exactly as the spec states them.
    const searchProviderServerName = isSubAgent ? undefined : await this.#memory.searchProviderServerName?.();
    const narrowedSpec =
      providerServerName === undefined || isSubAgent
        ? input.spec
        : withMemoryProviderNarrowedToReads(input.spec, providerServerName);
    // The Email connector is offered only its eight tools on every thread, sub-agents included.
    const mailNarrowedSpec = narrowConnectorTools(narrowedSpec, {
      server_name: MAIL_CONNECTOR_NAME,
      tools: MAIL_CONNECTOR_TOOL_NAMES,
    });
    // The Calendar connector is offered only its eight tools on every thread, sub-agents included.
    const calendarNarrowedSpec = narrowConnectorTools(mailNarrowedSpec, {
      server_name: CALDAV_SERVER_NAME,
      tools: CALDAV_TOOL_NAMES,
    });
    const resolved = await super.resolveAgentDefinition({
      ...input,
      spec:
        searchProviderServerName === undefined
          ? calendarNarrowedSpec
          : withSearchProviderAttached(calendarNarrowedSpec, searchProviderServerName),
    });
    // Derive recallEnabled from the spec (defaults to true per schema)
    const recallEnabled = input.spec.config.memory.recall_enabled;
    const memoryCapabilities = memoryCapabilitiesForTurn({
      memory: { ...this.#memory, recallEnabled },
      logger: this.logger,
      isSubAgent,
    });
    const outputScreen = toolOutputScreenCapability({ config: this.#toolOutputScreen });
    const extraCapabilities = [
      ...memoryCapabilities,
      ...(outputScreen === undefined ? [] : [outputScreen]),
      ...mailAttachmentCapabilities(input.spec),
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

/**
 * Tool exposure for the connector the host has been told is the memory provider.
 *
 * The host retains every completed turn into that bank itself, so the model must not also be
 * handed the bank's write tools: they would duplicate a save that already happened, raise an
 * approval prompt for it, and give the model something to narrate instead of call. These
 * assertions are made on what the resolver actually produces (the tool sets the thread will
 * run with, listed against a live MCP fixture), not on an incidental side effect.
 */
import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import type { ILLM, IToolSet } from '@truefoundry/trueforge-core/core';
import { isAuthRequired } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import type { MemoryConfig } from '../../../src/runtime/memory/memoryCapability';
import {
  MemoryTurnResourceResolver,
  type MemoryTurnContext,
  type ToolOutputScreenConfig,
} from '../../../src/runtime/MemoryTurnResourceResolver';
import {
  INERT_ASK_MEMORY_TOOL,
  INERT_ECHO_TOOL,
  INERT_READ_TOOL,
  INERT_SEARCH_MEMORY_TOOL,
  INERT_UNANNOTATED_TOOL,
  INERT_WRITE_TOOL,
  startInertMcpServer,
  type InertMcpServer,
} from '../../fixtures/inertMcpServer';

const CHAT_MODEL = 'scripted/chat-model';
const MEMORY_PROVIDER_SERVER = 'hindsight-memory';
const OTHER_SERVER = 'unrelated-connector';

/** Every tool the fixture publishes, sorted, so "unchanged" is asserted against the full surface. */
const ALL_TOOLS = [
  INERT_ASK_MEMORY_TOOL,
  INERT_ECHO_TOOL,
  INERT_READ_TOOL,
  INERT_SEARCH_MEMORY_TOOL,
  INERT_UNANNOTATED_TOOL,
  INERT_WRITE_TOOL,
].sort((a, b) => a.localeCompare(b));

/**
 * The subset `@read-only` keeps: the tag is annotation-driven (`readOnlyHint === true`) and
 * fails closed, so the fixture's write tool and its deliberately unannotated tool both drop out.
 */
const READ_ONLY_TOOLS = [INERT_ASK_MEMORY_TOOL, INERT_ECHO_TOOL, INERT_READ_TOOL, INERT_SEARCH_MEMORY_TOOL].sort(
  (a, b) => a.localeCompare(b),
);

const MEMORY_CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallEntityTokens: 512,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  recallMaxEntities: 8,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  curated: { enabled: false, maxModels: 3, maxTokens: 512 },
  reflect: { enabled: false, budget: 'low', maxTokens: 512, timeoutMs: 8000 },
};

const TOOL_OUTPUT_SCREEN_CONFIG: ToolOutputScreenConfig = {
  enabled: false,
  url: '',
  authToken: '',
  threshold: 0.5,
  timeoutMs: 1500,
};

/** Structurally complete stand-in: no scenario here reaches inference. */
function stubModelClient(): ILLM {
  return {
    create: () => {
      throw new Error('unused test model stream');
    },
    createNonStream: () => Promise.reject(new Error('unused test model completion')),
  };
}

function memoryContext(providerServerName: string | undefined): MemoryTurnContext {
  return {
    // No client: these scenarios are about tool exposure, not about recall or retain.
    client: undefined,
    config: MEMORY_CONFIG,
    sessionId: 'session-1',
    previousTurnId: null,
    sessionTitle: undefined,
    providerServerName,
  };
}

function makeResolver(input: {
  url: string;
  providerServerName: string | undefined;
  toolOutputScreen?: ToolOutputScreenConfig;
}) {
  return new MemoryTurnResourceResolver(
    {
      llm: () =>
        Promise.resolve({
          modelClient: stubModelClient(),
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: () => Promise.resolve({ url: input.url, headers: {} }),
      mcpRequestTimeoutMs: 10_000,
      mcpConnectTimeoutMs: 10_000,
      logger: createLogger({ silent: true }),
    },
    undefined,
    undefined,
    memoryContext(input.providerServerName),
    input.toolOutputScreen ?? TOOL_OUTPUT_SCREEN_CONFIG,
  );
}

/** Two mounts, both left at the schema defaults (`enable_tools: ['@all']`, `preload: false`). */
function makeSpec(): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: CHAT_MODEL },
    instructions: 'Answer the user.',
    mcp_servers: [{ name: MEMORY_PROVIDER_SERVER }, { name: OTHER_SERVER }],
  });
}

function resolve(resolver: MemoryTurnResourceResolver, spec: AgentSpec, subAgent = false) {
  return resolver.resolveAgentDefinition({
    spec,
    ...(subAgent ? { agent_info: { type: 'dynamic' as const, name: 'reviewer', input: 'do the thing' } } : {}),
    signal: new AbortController().signal,
    tracing: resolver.createTracing(),
  });
}

/** What the model would actually be offered from one mount, sorted by name. */
async function listedTools(toolSet: IToolSet | undefined): Promise<{ name: string; preload: boolean | undefined }[]> {
  if (toolSet === undefined) {
    throw new Error('expected a tool set for this mount');
  }
  const response = await toolSet.listTools();
  if (isAuthRequired(response)) {
    throw new Error('inert MCP fixture unexpectedly demanded authentication');
  }
  return response.result.tools
    .map(tool => ({ name: tool.name, preload: tool.preload }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mountFor(resolved: Awaited<ReturnType<typeof resolve>>, serverName: string): IToolSet | undefined {
  return resolved.definition.toolSets?.find(toolSet => toolSet.name === serverName);
}

describe('MemoryTurnResourceResolver tool exposure', () => {
  let inert: InertMcpServer;

  beforeAll(async () => {
    inert = await startInertMcpServer();
  });

  afterAll(async () => {
    await inert.close();
  });

  it('narrows the memory provider mount to read-only tools, preloaded, and leaves other mounts alone', async () => {
    const resolver = makeResolver({ url: inert.url, providerServerName: MEMORY_PROVIDER_SERVER });

    const resolved = await resolve(resolver, makeSpec());

    const provider = mountFor(resolved, MEMORY_PROVIDER_SERVER);
    // Preloaded: real definitions in the tool array, so the model never has to guess a tool name
    // from a server name through the deferred-discovery protocol.
    expect(provider?.preload).toBe(true);
    const providerTools = await listedTools(provider);
    expect(providerTools.map(tool => tool.name)).toEqual(READ_ONLY_TOOLS);
    expect(providerTools.every(tool => tool.preload === true)).toBe(true);
    // Named explicitly rather than left to the sorted-list comparison above: the write tool
    // disappearing is the whole point, and the unannotated one shows `@read-only` fails closed.
    expect(providerTools.map(tool => tool.name)).not.toContain(INERT_WRITE_TOOL);
    expect(providerTools.map(tool => tool.name)).not.toContain(INERT_UNANNOTATED_TOOL);

    const other = mountFor(resolved, OTHER_SERVER);
    // Unresolved until the first listTools() call (see ToolSet); this mount's spec leaves
    // `preload` unset, same as the memory provider's, so it is still the pre-resolution default.
    expect(other?.preload).toBe(false);
    const otherTools = await listedTools(other);
    expect(otherTools.map(tool => tool.name)).toEqual(ALL_TOOLS);
    // Auto-preload (MCP_AUTO_PRELOAD_MAX_TOOLS) resolves any small, unset-preload connector to
    // true on its first listTools() call; unrelated to memory-provider narrowing, which this
    // mount never goes through; the untouched tool set above is what proves that.
    expect(otherTools.every(tool => tool.preload === true)).toBe(true);
  });

  it('leaves every mount exactly as the spec states it when no memory provider is configured', async () => {
    const resolver = makeResolver({ url: inert.url, providerServerName: undefined });

    const resolved = await resolve(resolver, makeSpec());

    for (const serverName of [MEMORY_PROVIDER_SERVER, OTHER_SERVER]) {
      const mount = mountFor(resolved, serverName);
      expect(mount?.preload).toBe(false);
      expect((await listedTools(mount)).map(tool => tool.name)).toEqual(ALL_TOOLS);
    }
  });

  it('leaves sub-agent mounts untouched, matching where the memory capability itself is attached', async () => {
    const resolver = makeResolver({ url: inert.url, providerServerName: MEMORY_PROVIDER_SERVER });

    const resolved = await resolve(resolver, makeSpec(), true);

    const provider = mountFor(resolved, MEMORY_PROVIDER_SERVER);
    expect(provider?.preload).toBe(false);
    expect((await listedTools(provider)).map(tool => tool.name)).toEqual(ALL_TOOLS);
  });

  it('changes nothing when the provider is configured but this agent does not mount it', async () => {
    const resolver = makeResolver({ url: inert.url, providerServerName: MEMORY_PROVIDER_SERVER });
    const spec = AgentSpecSchema.parse({
      model: { name: CHAT_MODEL },
      mcp_servers: [{ name: OTHER_SERVER }],
    });

    const resolved = await resolve(resolver, spec);

    expect(resolved.definition.toolSets).toHaveLength(1);
    const other = mountFor(resolved, OTHER_SERVER);
    expect(other?.preload).toBe(false);
    expect((await listedTools(other)).map(tool => tool.name)).toEqual(ALL_TOOLS);
  });

  it('attaches the tool-output screen to root and sub-agent threads only when enabled', async () => {
    const enabled = makeResolver({
      url: inert.url,
      providerServerName: undefined,
      toolOutputScreen: {
        ...TOOL_OUTPUT_SCREEN_CONFIG,
        enabled: true,
        url: 'http://screen.internal',
      },
    });

    const root = await resolve(enabled, makeSpec());
    const child = await resolve(enabled, makeSpec(), true);

    expect(root.extraCapabilities?.flatMap(capability => capability.toolResponseProcessors ?? [])).toHaveLength(1);
    expect(child.extraCapabilities?.flatMap(capability => capability.toolResponseProcessors ?? [])).toHaveLength(1);

    const disabled = await resolve(makeResolver({ url: inert.url, providerServerName: undefined }), makeSpec());
    expect(disabled.extraCapabilities?.flatMap(capability => capability.toolResponseProcessors ?? []) ?? []).toEqual(
      [],
    );
  });
});

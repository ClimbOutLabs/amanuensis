import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import { builtinsFromSpec } from '../../src/agent-session/builtinsFromSpec';
import { AgentSpecSchema } from '../../src/agent-session/schemas/agentSpec';
import { COMPACTION_TOUCHED_PATHS_STATE_KEY } from '../../src/core/capabilities/builtins/ContextCompaction';
import {
  IngestionBudgetProcessor,
  LargeToolResponseProcessor,
} from '../../src/core/capabilities/builtins/LargeToolResponse';
import {
  GET_OPENUI_INSTRUCTIONS_TOOL_NAME,
  OPENUI_SERVER_ID,
  buildOpenUIInstruction,
} from '../../src/core/capabilities/builtins/OpenUI';
import { stripLegacyHostContextMessages } from '../../src/core/capabilities/builtins/RepositoryBindingContext';
import { toOpenAIChatMessage } from '../../src/core/llm/toOpenAIChatMessage';
import type { AgentDefinition } from '../../src/core/runtime/AgentDefinition';
import type { ContextMessage } from '../../src/core/runtime/AgentThread.types';
import { internalSystemMessage, isLLMContextMessage } from '../../src/core/runtime/contextUtils';
import type { BoundRepository } from '../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeMockILLM, makeSilentLogger } from '../core/harnessMocks';

const REPOSITORY_CONTEXT_MARKER = 'Host-bound repository state (authoritative';

const BOUND_REPOSITORY: BoundRepository = {
  repository_id: 'repository-1',
  revision: 7,
  workspace_cwd: 'C:\\workspace\\repository-1',
  commands: [
    {
      command_id: 'verify',
      purpose: 'verify',
      command: 'pnpm verify',
      timeout_ms: 120_000,
    },
  ],
};

function makeDefinition(): AgentDefinition {
  return {
    modelClient: makeMockILLM(),
    modelId: undefined,
    configuredModels: undefined,
  };
}

function runBuiltins(input: {
  spec: ReturnType<typeof AgentSpecSchema.parse>;
  isChild?: boolean;
  sandboxAvailable?: boolean;
  boundRepository?: BoundRepository;
}): ReturnType<typeof builtinsFromSpec> {
  return builtinsFromSpec({
    spec: input.spec,
    definition: makeDefinition(),
    compactionModel: undefined,
    isChild: input.isChild ?? false,
    sandbox: undefined,
    sandboxAvailable: input.sandboxAvailable ?? false,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    boundRepository: input.boundRepository,
  });
}

async function processPreLLM(
  capabilities: ReturnType<typeof builtinsFromSpec>,
  initialContext: ContextMessage[],
): Promise<ContextMessage[]> {
  let context = initialContext;
  for (const processor of capabilities.flatMap(capability => capability.preLLMProcessors ?? [])) {
    for await (const event of processor.processPreLLM({
      threadId: 'main',
      signal: undefined,
      context,
      currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
    })) {
      if (!('context' in event)) {
        continue;
      }
      context = event.type === 'agent.context.overwrite' ? event.context : context.concat(event.context);
    }
  }
  return context;
}

async function processRequest(
  capabilities: ReturnType<typeof builtinsFromSpec>,
  initialContext: ContextMessage[],
): Promise<{ persistedContext: ContextMessage[]; requestMessages: ChatCompletionMessageParam[] }> {
  const persistedContext = await processPreLLM(capabilities, initialContext);
  let requestMessages = persistedContext.filter(isLLMContextMessage).map(toOpenAIChatMessage);
  for (const processor of capabilities.flatMap(capability => capability.preLLMEphemeralProcessors ?? [])) {
    requestMessages = processor.processPreLLMEphemeral(requestMessages) ?? requestMessages;
  }
  return { persistedContext, requestMessages };
}

function markerCount(value: unknown): number {
  return JSON.stringify(value).split(REPOSITORY_CONTEXT_MARKER).length - 1;
}

function hasOpenUITool(capabilities: ReturnType<typeof builtinsFromSpec>): boolean {
  return capabilities.some(cap => cap.systemToolSets?.some(ts => ts.name === OPENUI_SERVER_ID));
}

/**
 * `preLLMProcessors` alone is not compaction-specific: RepositoryBindingContext registers one
 * too. Compaction's is the one whose `state.key` is the touched-paths key.
 */
function hasCompactionProcessor(capabilities: ReturnType<typeof builtinsFromSpec>): boolean {
  return capabilities.some(
    cap => (cap.preLLMProcessors?.length ?? 0) > 0 && cap.state?.key === COMPACTION_TOUCHED_PATHS_STATE_KEY,
  );
}

describe('builtinsFromSpec compaction', () => {
  it('enables compaction by default', () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({ model: { name: 'provider/model' } }),
    });
    expect(hasCompactionProcessor(capabilities)).toBe(true);
  });

  it('disables compaction from the context-management Agent Spec setting', () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({
        model: { name: 'provider/model' },
        config: { context_management: { compaction: { enabled: false } } },
      }),
    });
    expect(hasCompactionProcessor(capabilities)).toBe(false);
  });
});

describe('builtinsFromSpec ingestion budgets', () => {
  it('applies the ingestion budgets when large_tool_response is off', () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({
        model: { name: 'provider/model' },
        config: { context_management: { large_tool_response: { enabled: false } } },
      }),
    });
    const processors = capabilities.flatMap(cap => cap.toolResponseProcessors ?? []);
    expect(processors.some(processor => processor instanceof IngestionBudgetProcessor)).toBe(true);
    expect(processors.some(processor => processor instanceof LargeToolResponseProcessor)).toBe(false);
  });
});

describe('builtinsFromSpec generative_ui', () => {
  it('enables OpenUI with preload false when generative_ui is omitted', () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({ model: { name: 'provider/model' } }),
    });
    expect(hasOpenUITool(capabilities)).toBe(true);
    const openUICap = capabilities.find(cap => cap.systemToolSets?.some(ts => ts.name === OPENUI_SERVER_ID));
    expect(openUICap?.instructionBuilders?.[0]).not.toBe(buildOpenUIInstruction);
    expect(openUICap?.instructionBuilders).toHaveLength(1);
  });

  it('disables OpenUI when generative_ui.enabled is false', () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({
        model: { name: 'provider/model' },
        config: { generative_ui: { enabled: false } },
      }),
    });
    expect(hasOpenUITool(capabilities)).toBe(false);
  });

  it('never enables OpenUI on child threads', () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({ model: { name: 'provider/model' } }),
      isChild: true,
    });
    expect(hasOpenUITool(capabilities)).toBe(false);
  });

  it('registers get_openui_instructions for root threads', async () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({ model: { name: 'provider/model' } }),
    });
    const toolSet = capabilities
      .flatMap(cap => [...(cap.systemToolSets ?? [])])
      .find(ts => ts.name === OPENUI_SERVER_ID);
    const listed = await toolSet?.listTools();
    if (!listed || 'authRequired' in listed) {
      throw new Error('expected listTools result');
    }
    expect(listed.result.tools.map(t => t.name)).toEqual([GET_OPENUI_INSTRUCTIONS_TOOL_NAME]);
  });
});

describe('builtinsFromSpec repository binding context', () => {
  const compactionDisabledSpec = AgentSpecSchema.parse({
    model: { name: 'provider/model' },
    config: { context_management: { compaction: { enabled: false } } },
  });

  it('injects a bound repository before compaction when sandbox and compaction are disabled', async () => {
    const result = await processRequest(
      runBuiltins({ spec: compactionDisabledSpec, boundRepository: BOUND_REPOSITORY }),
      [],
    );
    const visible = JSON.stringify(result.requestMessages);

    expect(markerCount(result.requestMessages)).toBe(1);
    expect(markerCount(result.persistedContext)).toBe(0);
    expect(visible).toContain('repository_id: repository-1');
    expect(visible).toContain('repository_revision: 7');
    expect(visible).toContain('workspace_cwd: C:\\\\workspace\\\\repository-1');
    expect(visible).toContain('branch: unavailable');
    expect(visible).toContain('head_sha: unavailable');
    expect(visible).toContain('command_id: verify');
    expect(visible).toContain('purpose: verify');
    expect(visible).toContain('command: pnpm verify');
    expect(visible).toContain('timeout_ms: 120000');
  });

  it('does not duplicate repository context owned by an available sandbox', async () => {
    const rebuiltContext = stripLegacyHostContextMessages([
      internalSystemMessage(`${REPOSITORY_CONTEXT_MARKER}):\nrepository_id: stale-context-that-sandbox-now-owns`),
    ]);
    const result = await processRequest(
      runBuiltins({
        spec: compactionDisabledSpec,
        sandboxAvailable: true,
        boundRepository: BOUND_REPOSITORY,
      }),
      rebuiltContext,
    );

    expect(markerCount(rebuiltContext)).toBe(0);
    expect(markerCount(result.requestMessages)).toBe(0);
    expect(JSON.stringify(result.persistedContext)).not.toContain('stale-context-that-sandbox-now-owns');
  });

  it('replaces stale binding context across rebuilds without accumulating messages', async () => {
    const revisionSeven = await processRequest(
      runBuiltins({ spec: compactionDisabledSpec, boundRepository: BOUND_REPOSITORY }),
      [{ role: 'user', content: 'continue' }],
    );
    const revisionEightBinding: BoundRepository = {
      ...BOUND_REPOSITORY,
      repository_id: 'repository-2',
      revision: 8,
      workspace_cwd: 'C:\\workspace\\repository-2',
    };
    const revisionEight = await processRequest(
      runBuiltins({ spec: compactionDisabledSpec, boundRepository: revisionEightBinding }),
      revisionSeven.persistedContext,
    );
    const rebuiltAgain = await processRequest(
      runBuiltins({ spec: compactionDisabledSpec, boundRepository: revisionEightBinding }),
      revisionEight.persistedContext,
    );
    const visible = JSON.stringify(rebuiltAgain.requestMessages);

    expect(markerCount(rebuiltAgain.requestMessages)).toBe(1);
    expect(markerCount(rebuiltAgain.persistedContext)).toBe(0);
    expect(visible).toContain('repository_revision: 8');
    expect(visible).toContain('workspace_cwd: C:\\\\workspace\\\\repository-2');
    expect(visible).toContain('branch: unavailable');
    expect(visible).toContain('head_sha: unavailable');
    expect(visible).toContain('command_id: verify');
    expect(visible).not.toContain('repository_revision: 7');
    expect(visible).not.toContain('repository-1');
  });

  it('does not inject repository context for an unbound session', async () => {
    const result = await processRequest(runBuiltins({ spec: compactionDisabledSpec }), []);

    expect(markerCount(result.requestMessages)).toBe(0);
    expect(markerCount(result.persistedContext)).toBe(0);
    expect(JSON.stringify(result.requestMessages)).not.toContain('repository_id:');
  });
});

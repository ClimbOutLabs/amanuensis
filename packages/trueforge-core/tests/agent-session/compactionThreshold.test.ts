import { builtinsFromSpec } from '../../src/agent-session/builtinsFromSpec';
import { AgentSpecSchema } from '../../src/agent-session/schemas/agentSpec';
import {
  COMPACTION_TOUCHED_PATHS_STATE_KEY,
  CONVERSATION_REQUIRED_SUMMARY_SECTIONS,
} from '../../src/core/capabilities/builtins/ContextCompaction';
import { EventType } from '../../src/core/events/schema';
import type { ContextMessage } from '../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeMockILLM, makeSilentLogger } from '../core/harnessMocks';

const SUMMARY = `<summary>\n${CONVERSATION_REQUIRED_SUMMARY_SECTIONS.map(name => `## ${name}\nnone`).join('\n\n')}\n</summary>`;

/**
 * Runs the compaction processor that builtinsFromSpec builds, with the same inputs the server
 * hands it: the host default is what config yields for CONTEXT_COMPACTION_THRESHOLD_TOKENS
 * (undefined when the env var is unset), the context length comes from the resolved model.
 */
async function compacts(input: {
  contextLength: number | undefined;
  hostDefault: number | undefined;
  contextTokens: number;
  specTrigger?: number;
}): Promise<boolean> {
  const spec = AgentSpecSchema.parse({
    model: { name: 'provider/model' },
    ...(input.specTrigger === undefined
      ? {}
      : {
          config: {
            context_management: { compaction: { trigger: { type: 'input_tokens', value: input.specTrigger } } },
          },
        }),
  });
  const capabilities = builtinsFromSpec({
    spec,
    definition: {
      modelClient: makeMockILLM({
        createNonStream: jest.fn().mockResolvedValue({
          output: { role: 'assistant', content: SUMMARY },
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          finish_reason: 'stop',
        }),
      }),
      modelId: undefined,
      configuredModels: undefined,
      modelProperties: { contextLength: input.contextLength },
    },
    compactionModel: undefined,
    isChild: false,
    sandbox: undefined,
    sandboxAvailable: false,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    compactionThresholdTokensDefault: input.hostDefault,
  });
  const processor = capabilities.find(capability => capability.state?.key === COMPACTION_TOUCHED_PATHS_STATE_KEY)
    ?.preLLMProcessors?.[0];
  if (processor === undefined) {
    throw new Error('expected the compaction processor');
  }
  const context: ContextMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ];
  for await (const event of processor.processPreLLM({
    threadId: 'main',
    signal: undefined,
    currentContextUsage: { prompt_tokens: input.contextTokens, completion_tokens: 0 },
    context,
  })) {
    if (event.type === EventType.AGENT_CONTEXT_COMPACTION) {
      return true;
    }
  }
  return false;
}

describe('compaction threshold wiring', () => {
  it('compacts a 32k model before its context fills when no threshold is configured', async () => {
    expect(await compacts({ contextLength: 32_000, hostDefault: undefined, contextTokens: 20_000 })).toBe(false);
    expect(await compacts({ contextLength: 32_000, hostDefault: undefined, contextTokens: 26_000 })).toBe(true);
  });

  it('does not compact a 1M model at 50k tokens when no threshold is configured', async () => {
    expect(await compacts({ contextLength: 1_000_000, hostDefault: undefined, contextTokens: 60_000 })).toBe(false);
    expect(await compacts({ contextLength: 1_000_000, hostDefault: undefined, contextTokens: 810_000 })).toBe(true);
  });

  it('keeps the fixed 50k threshold when the model context length is unknown', async () => {
    expect(await compacts({ contextLength: undefined, hostDefault: undefined, contextTokens: 40_000 })).toBe(false);
    expect(await compacts({ contextLength: undefined, hostDefault: undefined, contextTokens: 55_000 })).toBe(true);
  });

  it('lets an explicit host value override the ratio on both a large and a small model', async () => {
    expect(await compacts({ contextLength: 1_000_000, hostDefault: 20_000, contextTokens: 25_000 })).toBe(true);
    expect(await compacts({ contextLength: 32_000, hostDefault: 100_000, contextTokens: 27_000 })).toBe(false);
  });

  it('lets an explicit spec trigger override the host value', async () => {
    expect(
      await compacts({ contextLength: 1_000_000, hostDefault: 100_000, specTrigger: 10_000, contextTokens: 15_000 }),
    ).toBe(true);
  });
});

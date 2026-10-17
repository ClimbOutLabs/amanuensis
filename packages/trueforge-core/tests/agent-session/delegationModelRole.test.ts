import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import { AgentSpecSchema } from '../../src/agent-session/schemas/agentSpec';
import type { ModelParams } from '../../src/core/runtime/AgentDefinition';
import { makeAgentSpec, makeMockILLM, makeSilentLogger } from './testHelpers';

const MAIN_MODEL = 'test-provider/main-model';
const DELEGATION_MODEL = 'test-provider/delegation-model';
const EXPLICIT_MODEL = 'test-provider/explicit-model';

function makeResolver(models: Record<string, ModelParams>) {
  const clients = new Map(Object.keys(models).map(name => [name, makeMockILLM()]));
  const llm = jest.fn(async (name: string) => {
    const defaultModelParams = models[name];
    if (!defaultModelParams) {
      throw new Error(`unexpected model lookup: ${name}`);
    }
    const modelClient = clients.get(name);
    if (!modelClient) {
      throw new Error(`missing model client: ${name}`);
    }
    return { modelClient, defaultModelParams, modelId: undefined, modelSupportsVision: false };
  });

  return {
    llm,
    resolver: new TurnResourceResolver({
      llm,
      mcp: () => Promise.reject(new Error('unused')),
      mcpRequestTimeoutMs: 1_000,
      mcpConnectTimeoutMs: 1_000,
      logger: makeSilentLogger(),
    }),
  };
}

function dynamicAgent(model?: string) {
  return {
    type: 'dynamic' as const,
    name: 'worker',
    input: 'complete the delegated task',
    ...(model === undefined ? {} : { model }),
  };
}

function makeSpec(input: {
  modelParams: ModelParams;
  auxiliary_models?: NonNullable<NonNullable<Parameters<typeof makeAgentSpec>[0]>['auxiliary_models']>;
}) {
  return AgentSpecSchema.parse({
    ...makeAgentSpec({
      model: { name: MAIN_MODEL },
      ...(input.auxiliary_models === undefined ? {} : { auxiliary_models: input.auxiliary_models }),
    }),
    model: { name: MAIN_MODEL, params: input.modelParams },
  });
}

async function resolve(
  resolver: TurnResourceResolver,
  spec: ReturnType<typeof makeAgentSpec>,
  agentInfo?: ReturnType<typeof dynamicAgent>,
) {
  const { definition } = await resolver.resolveAgentDefinition({
    spec,
    ...(agentInfo === undefined ? {} : { agent_info: agentInfo }),
    signal: new AbortController().signal,
    tracing: resolver.createTracing(),
    tenant_id: 'test-tenant',
    created_by: 'test-user',
    session_id: 'test-session',
  });
  return definition;
}

describe('TurnResourceResolver delegation model precedence', () => {
  it('uses main defaults merged with main params for the root thread', async () => {
    const { llm, resolver } = makeResolver({
      [MAIN_MODEL]: { max_tokens: 4096, temperature: 0.2 },
    });
    const spec = makeSpec({ modelParams: { max_tokens: 8192, top_p: 0.8 } });

    const definition = await resolve(resolver, spec);

    expect(llm).toHaveBeenCalledWith(MAIN_MODEL, 'chat');
    expect(definition.modelParams).toEqual({
      max_tokens: 8192,
      temperature: 0.2,
      top_p: 0.8,
    });
  });

  it('uses the delegation model defaults merged with delegation params for an implicit sub-agent', async () => {
    const { llm, resolver } = makeResolver({
      [DELEGATION_MODEL]: { max_tokens: 2048, top_k: 20 },
    });
    const spec = makeSpec({
      modelParams: { max_tokens: 8192, temperature: 0.7, top_p: 0.9 },
      auxiliary_models: {
        delegation: { name: DELEGATION_MODEL, params: { max_tokens: 1024, temperature: 0.1 } },
      },
    });

    const definition = await resolve(resolver, spec, dynamicAgent());

    expect(llm).toHaveBeenCalledWith(DELEGATION_MODEL, 'delegation');
    expect(definition.modelParams).toEqual({
      max_tokens: 1024,
      temperature: 0.1,
      top_k: 20,
    });
  });

  it('falls back to the main model and main params for an implicit sub-agent without a delegation role', async () => {
    const { llm, resolver } = makeResolver({
      [MAIN_MODEL]: { max_tokens: 4096, temperature: 0.2 },
    });
    const spec = makeSpec({ modelParams: { max_tokens: 8192, top_p: 0.8 } });

    const definition = await resolve(resolver, spec, dynamicAgent());

    expect(llm).toHaveBeenCalledWith(MAIN_MODEL, 'delegation');
    expect(definition.modelParams).toEqual({
      max_tokens: 8192,
      temperature: 0.2,
      top_p: 0.8,
    });
  });

  it('lets an explicit sub-agent model beat the delegation role and uses only its defaults', async () => {
    const { llm, resolver } = makeResolver({
      [EXPLICIT_MODEL]: { max_tokens: 3072, temperature: 0.05 },
    });
    const spec = makeSpec({
      modelParams: { max_tokens: 8192, top_p: 0.9 },
      auxiliary_models: {
        delegation: { name: DELEGATION_MODEL, params: { max_tokens: 1024, temperature: 0.1 } },
      },
    });

    const definition = await resolve(resolver, spec, dynamicAgent(EXPLICIT_MODEL));

    expect(llm).toHaveBeenCalledWith(EXPLICIT_MODEL, 'delegation');
    expect(definition.modelParams).toEqual({ max_tokens: 3072, temperature: 0.05 });
  });
});

import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import type { ILLM } from '@truefoundry/trueforge-core/core';
import { defaultSentinelServices, type SentinelServices } from '@truefoundry/trueforge-core/core';
import { AMAN_GUIDE_NAME } from '@truefoundry/trueforge-core/core/personas/guide';
import { TAVILY_CONNECTOR_HOST } from '@truefoundry/trueforge-core/core/search/TavilyClient';
import { createLogger } from 'winston';
import { amanGuidePersonaId } from '../../../src/personas/amanGuide/identity';
import { buildPersonaContext, type Persona } from '../../../src/personas/persona';
import type { GuideSearchTurnContext } from '../../../src/runtime/guideSearch';
import { PersonaTurnResourceResolver } from '../../../src/runtime/PersonaTurnResourceResolver';

const CHAT_MODEL = 'scripted/chat-model';
const PERSONA_MODEL = 'scripted/persona-model';

function clientFor(name: string): ILLM {
  return {
    create: () => {
      throw new Error(`unused test model stream for ${name}`);
    },
    createNonStream: () => Promise.reject(new Error('unused test model completion')),
  };
}

const GUIDE: Persona = {
  tenant_id: 'default',
  id: amanGuidePersonaId('u1'),
  created_by: 'u1',
  display_name: AMAN_GUIDE_NAME,
  aliases: [],
  instructions: 'Explain Aman.',
  model_name: PERSONA_MODEL,
  created_at: '2026-08-27T00:00:00.000Z',
  updated_at: '2026-08-27T00:00:00.000Z',
  updated_by: 'u1',
};

const NAMED_PERSONA: Persona = {
  ...GUIDE,
  id: 'p-zara',
  display_name: 'Zara',
  instructions: 'Answer as a careful archivist.',
};

const TAVILY_CONNECTION = {
  url: `https://${TAVILY_CONNECTOR_HOST}/mcp/?tavilyApiKey=YOUR_TAVILY_API_KEY`,
  headers: {},
  search_provider: { tools: ['tavily_search', 'tavily_extract'], plumbing_fields: [] },
};

const PARALLEL_CONNECTION = {
  url: 'https://search.parallel.example/mcp',
  headers: {},
  search_provider: { tools: ['web_search'], plumbing_fields: [] },
};

function makeResolver(input: {
  persona: Persona;
  connection: typeof TAVILY_CONNECTION | typeof PARALLEL_CONNECTION | undefined;
  guideSearch?: GuideSearchTurnContext | undefined;
}) {
  return new PersonaTurnResourceResolver(
    {
      llm: name =>
        Promise.resolve({
          modelClient: clientFor(name),
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
          modelProperties: undefined,
        }),
      mcp: () =>
        input.connection === undefined
          ? Promise.reject(new Error('no connector in this test'))
          : Promise.resolve(input.connection),
      mcpConnectTimeoutMs: 1_000,
      mcpRequestTimeoutMs: 1_000,
      logger: createLogger({ silent: true }),
    },
    undefined,
    buildPersonaContext(input.persona),
    undefined,
    undefined,
    undefined,
    input.guideSearch,
  );
}

function makeSpec(): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: CHAT_MODEL, params: {} },
    instructions: 'Answer the user.',
    mcp_servers: [{ name: 'tavily' }],
  });
}

function services(input: { offline: boolean }): SentinelServices {
  return {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    isOffline: () => Promise.resolve(input.offline),
  };
}

async function resolveGuide(
  resolver: PersonaTurnResourceResolver,
  input: { offline?: boolean; subAgent?: boolean } = {},
) {
  return resolver.resolveAgentDefinition({
    spec: makeSpec(),
    tenant_id: 't1',
    created_by: 'u1',
    session_id: 's1',
    ...(input.subAgent ? { agent_info: { type: 'dynamic' as const, name: 'reviewer', input: 'do the thing' } } : {}),
    signal: new AbortController().signal,
    tracing: resolver.createTracing(),
    sentinel_services: services({ offline: input.offline ?? false }),
  });
}

const TAVILY_GUIDE_SEARCH: GuideSearchTurnContext = { searchProviderServerName: () => Promise.resolve('tavily') };

describe('the guide search tool offering', () => {
  it('offers the guide exactly one tool when Tavily is the provider and offline mode is off', async () => {
    const resolver = makeResolver({ persona: GUIDE, connection: TAVILY_CONNECTION, guideSearch: TAVILY_GUIDE_SEARCH });
    const resolved = await resolveGuide(resolver);
    expect(resolved.definition.readOnly).toBe(true);
    const toolSet = resolved.definition.guideSearchToolSet;
    expect(toolSet).toBeDefined();
    const listed = await toolSet?.listTools();
    const names = listed !== undefined && 'result' in listed ? listed.result.tools.map(tool => tool.name) : [];
    expect(names).toEqual(['search_aman_sources']);
  });

  it('offers nothing when the configured provider is not Tavily', async () => {
    const resolver = makeResolver({
      persona: GUIDE,
      connection: PARALLEL_CONNECTION,
      guideSearch: TAVILY_GUIDE_SEARCH,
    });
    const resolved = await resolveGuide(resolver);
    expect(resolved.definition.guideSearchToolSet).toBeUndefined();
  });

  it('offers nothing while offline mode is on', async () => {
    const resolver = makeResolver({ persona: GUIDE, connection: TAVILY_CONNECTION, guideSearch: TAVILY_GUIDE_SEARCH });
    const resolved = await resolveGuide(resolver, { offline: true });
    expect(resolved.definition.guideSearchToolSet).toBeUndefined();
  });

  it('offers nothing when no search provider is designated', async () => {
    const resolver = makeResolver({
      persona: GUIDE,
      connection: TAVILY_CONNECTION,
      guideSearch: { searchProviderServerName: () => Promise.resolve(undefined) },
    });
    const resolved = await resolveGuide(resolver);
    expect(resolved.definition.guideSearchToolSet).toBeUndefined();
  });

  it('offers nothing when the host wired no guide search lookup', async () => {
    const resolver = makeResolver({ persona: GUIDE, connection: TAVILY_CONNECTION });
    const resolved = await resolveGuide(resolver);
    expect(resolved.definition.guideSearchToolSet).toBeUndefined();
  });

  it('leaves other personas unchanged: no guide tool, and not read-only', async () => {
    const resolver = makeResolver({
      persona: NAMED_PERSONA,
      connection: TAVILY_CONNECTION,
      guideSearch: TAVILY_GUIDE_SEARCH,
    });
    const resolved = await resolveGuide(resolver);
    expect(resolved.definition.readOnly).toBe(false);
    expect(resolved.definition.guideSearchToolSet).toBeUndefined();
  });

  it('offers nothing on sub-agent threads', async () => {
    const resolver = makeResolver({ persona: GUIDE, connection: TAVILY_CONNECTION, guideSearch: TAVILY_GUIDE_SEARCH });
    const resolved = await resolveGuide(resolver, { subAgent: true });
    expect(resolved.definition.guideSearchToolSet).toBeUndefined();
  });
});

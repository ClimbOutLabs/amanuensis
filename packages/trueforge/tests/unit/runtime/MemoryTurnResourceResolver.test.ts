/**
 * What the resolver attaches to a turn: the tool-output screen, the designated web search provider,
 * and the mounts it keeps or drops. Assertions are made on what the resolver actually produces (the
 * tool sets the thread will run with, listed against a live MCP fixture).
 */
import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import type { ILLM, IToolSet } from '@truefoundry/trueforge-core/core';
import { isAuthRequired } from '@truefoundry/trueforge-core/core';
import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import { connectorOffKey } from '@truefoundry/trueforge-core/core/connectors/chatConnectorChoice';
import { MailAttachmentProcessor } from '@truefoundry/trueforge-core/core/email/mailConnector/MailAttachmentProcessor';
import { MAIL_CONNECTOR_NAME } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import { Writable } from 'node:stream';
import { createLogger, format, transports, type Logger } from 'winston';
import { PERSONA_CONTEXT_VERSION, type PersonaContext } from '../../../src/personas/persona';
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
const MOUNTED_SERVER = 'mounted-connector';
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

const MEMORY_CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  pages: { maxCount: 6, maxTokens: 1500 },
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

function memoryContext(
  searchProviderServerName?: () => Promise<string | undefined>,
  chat: Pick<MemoryTurnContext, 'turnedOffConnectorKeys' | 'recallEnabled'> = {},
  searchProviderPresetNames?: () => readonly string[],
): MemoryTurnContext {
  return {
    keepsNothing: false,
    // No client: these scenarios are about tool exposure, not about recall or retain.
    client: undefined,
    config: MEMORY_CONFIG,
    sessionId: 'session-1',
    previousTurnId: null,
    summarize: undefined,
    searchProviderServerName,
    searchProviderPresetNames,
    ...chat,
  };
}

function makeResolver(input: {
  url: string;
  searchProviderServerName?: () => Promise<string | undefined>;
  searchProviderPresetNames?: () => readonly string[];
  toolOutputScreen?: ToolOutputScreenConfig;
  setUpConnectorNames?: () => Promise<readonly string[]>;
  chat?: Pick<MemoryTurnContext, 'turnedOffConnectorKeys' | 'recallEnabled'>;
  persona?: PersonaContext;
  logger?: Logger;
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
      ...(input.setUpConnectorNames === undefined ? {} : { setUpConnectorNames: input.setUpConnectorNames }),
      mcpRequestTimeoutMs: 10_000,
      mcpConnectTimeoutMs: 10_000,
      logger: input.logger ?? createLogger({ silent: true }),
    },
    undefined,
    input.persona,
    memoryContext(input.searchProviderServerName, input.chat, input.searchProviderPresetNames),
    input.toolOutputScreen ?? TOOL_OUTPUT_SCREEN_CONFIG,
  );
}

/** Two mounts, both left at the schema defaults (`enable_tools: ['@all']`, `preload: false`). */
function makeSpec(): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: CHAT_MODEL },
    instructions: 'Answer the user.',
    mcp_servers: [{ name: MOUNTED_SERVER }, { name: OTHER_SERVER }],
  });
}

function resolve(resolver: MemoryTurnResourceResolver, spec: AgentSpec, subAgent = false) {
  return resolver.resolveAgentDefinition({
    spec,
    tenant_id: 't1',
    created_by: 'u1',
    session_id: 's1',
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

describe('MemoryTurnResourceResolver tool-output screen', () => {
  let inert: InertMcpServer;

  beforeAll(async () => {
    inert = await startInertMcpServer();
  });

  afterAll(async () => {
    await inert.close();
  });

  it('attaches the tool-output screen to root and sub-agent threads only when enabled', async () => {
    const enabled = makeResolver({
      url: inert.url,
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

    const disabled = await resolve(makeResolver({ url: inert.url }), makeSpec());
    expect(disabled.extraCapabilities?.flatMap(capability => capability.toolResponseProcessors ?? []) ?? []).toEqual(
      [],
    );
  });
});

describe('the designated web search provider on every turn', () => {
  const SEARCH_SERVER = 'parallel-web';
  let inert: InertMcpServer;

  beforeAll(async () => {
    inert = await startInertMcpServer();
  });

  afterAll(async () => {
    await inert.close();
  });

  const bareSpec = () => AgentSpecSchema.parse({ model: { name: CHAT_MODEL }, instructions: 'Answer the user.' });

  function withSearchProvider(name: string | undefined) {
    return makeResolver({
      url: inert.url,
      searchProviderServerName: () => Promise.resolve(name),
    });
  }

  it('offers its tools on a first turn whose spec lists no connector', async () => {
    const resolved = await resolve(withSearchProvider(SEARCH_SERVER), bareSpec());

    expect(resolved.definition.toolSets?.map(toolSet => toolSet.name)).toEqual([SEARCH_SERVER]);
    expect((await listedTools(mountFor(resolved, SEARCH_SERVER))).map(tool => tool.name)).toEqual(ALL_TOOLS);
  });

  it('adds it beside the connectors a spec lists, and never twice', async () => {
    const added = await resolve(withSearchProvider(SEARCH_SERVER), makeSpec());
    expect(added.definition.toolSets?.map(toolSet => toolSet.name).sort()).toEqual(
      [MOUNTED_SERVER, OTHER_SERVER, SEARCH_SERVER].sort(),
    );

    const spec = AgentSpecSchema.parse({ model: { name: CHAT_MODEL }, mcp_servers: [{ name: SEARCH_SERVER }] });
    const listed = await resolve(withSearchProvider(SEARCH_SERVER), spec);
    expect(listed.definition.toolSets).toHaveLength(1);
  });

  it('adds nothing when no provider is designated, and nothing to a sub-agent', async () => {
    const none = await resolve(withSearchProvider(undefined), bareSpec());
    expect(none.definition.toolSets ?? []).toHaveLength(0);

    const child = await resolve(withSearchProvider(SEARCH_SERVER), bareSpec(), true);
    expect(child.definition.toolSets ?? []).toHaveLength(0);
  });
});

describe('web search, email and calendar on by default in every chat', () => {
  const SEARCH_SERVER = 'parallel-web';
  const EMAIL = MAIL_CONNECTOR_NAME;
  const CALENDAR = CALDAV_SERVER_NAME;
  let inert: InertMcpServer;

  beforeAll(async () => {
    inert = await startInertMcpServer();
  });

  afterAll(async () => {
    await inert.close();
  });

  const bareSpec = () => AgentSpecSchema.parse({ model: { name: CHAT_MODEL }, instructions: 'Answer the user.' });

  function chatResolver(input: {
    setUp: readonly string[] | undefined;
    turnedOff?: readonly string[];
    unattended?: boolean;
    persona?: PersonaContext;
  }) {
    const { setUp } = input;
    return makeResolver({
      url: inert.url,
      searchProviderServerName: () => Promise.resolve(SEARCH_SERVER),
      ...(setUp === undefined ? {} : { setUpConnectorNames: () => Promise.resolve(setUp) }),
      chat: {
        turnedOffConnectorKeys: input.turnedOff?.map(connectorOffKey),
        recallEnabled: input.unattended === true ? false : undefined,
      },
      ...(input.persona === undefined ? {} : { persona: input.persona }),
    });
  }

  async function mounted(resolver: MemoryTurnResourceResolver, spec = bareSpec()) {
    const resolved = await resolve(resolver, spec);
    return (resolved.definition.toolSets ?? []).map(toolSet => toolSet.name).sort();
  }

  it('attaches search and every set-up source on the first turn of a new chat', async () => {
    const names = await mounted(chatResolver({ setUp: [SEARCH_SERVER, EMAIL, CALENDAR] }));
    expect(names).toEqual([CALENDAR, EMAIL, SEARCH_SERVER].sort());
  });

  it('gives a chat made before this change the same defaults', async () => {
    const olderSpec = AgentSpecSchema.parse({
      model: { name: CHAT_MODEL },
      instructions: 'Answer the user.',
      mcp_servers: [{ name: OTHER_SERVER }],
    });
    const names = await mounted(chatResolver({ setUp: [OTHER_SERVER, EMAIL] }), olderSpec);
    expect(names).toEqual([EMAIL, OTHER_SERVER, SEARCH_SERVER].sort());
  });

  it('keeps a source off for the chat that turned it off, and attaches it again once it is cleared', async () => {
    const setUp = [SEARCH_SERVER, EMAIL, CALENDAR];
    expect(await mounted(chatResolver({ setUp, turnedOff: [EMAIL] }))).toEqual([CALENDAR, SEARCH_SERVER].sort());
    expect(await mounted(chatResolver({ setUp, turnedOff: [SEARCH_SERVER] }))).toEqual([CALENDAR, EMAIL].sort());
    expect(await mounted(chatResolver({ setUp, turnedOff: [] }))).toEqual([CALENDAR, EMAIL, SEARCH_SERVER].sort());
  });

  it('never attaches a source that is not set up, or when the set-up list cannot be read', async () => {
    expect(await mounted(chatResolver({ setUp: [SEARCH_SERVER] }))).toEqual([SEARCH_SERVER]);
    expect(await mounted(chatResolver({ setUp: undefined }))).toEqual([SEARCH_SERVER]);
  });

  it('gives an unattended run and a persona chat the same defaults as any chat', async () => {
    const persona: PersonaContext = {
      version: PERSONA_CONTEXT_VERSION,
      persona_id: 'persona-1',
      persona_name: 'Invented Persona',
      model_name: CHAT_MODEL,
      injected_context: '',
    };
    const setUp = [SEARCH_SERVER, EMAIL, CALENDAR];
    const expected = [CALENDAR, EMAIL, SEARCH_SERVER].sort();
    expect(await mounted(chatResolver({ setUp, unattended: true }))).toEqual(expected);
    expect(await mounted(chatResolver({ setUp, persona }))).toEqual(expected);
    expect(await mounted(chatResolver({ setUp, persona, turnedOff: [EMAIL] }))).toEqual(
      [CALENDAR, SEARCH_SERVER].sort(),
    );
  });

  it('mounts Email the same way as a chat that listed it itself, so its approvals are unchanged', async () => {
    const listed = AgentSpecSchema.parse({
      model: { name: CHAT_MODEL },
      instructions: 'Answer the user.',
      mcp_servers: [{ name: EMAIL }],
    });
    const byChoice = await resolve(chatResolver({ setUp: [EMAIL], turnedOff: [SEARCH_SERVER] }), bareSpec());
    const byList = await resolve(chatResolver({ setUp: [EMAIL], turnedOff: [SEARCH_SERVER] }), listed);

    // Approvals are decided per connector name and tool, so the same name on the same kind of mount is the same rule.
    const chosen = mountFor(byChoice, EMAIL);
    const mounted = mountFor(byList, EMAIL);
    expect(chosen?.name).toBe(EMAIL);
    expect(chosen?.constructor).toBe(mounted?.constructor);
    expect(byChoice.definition.toolSets).toHaveLength(byList.definition.toolSets?.length ?? -1);
  });

  describe('a mount that carries the name Email', () => {
    const listedEmail = () =>
      AgentSpecSchema.parse({
        model: { name: CHAT_MODEL },
        instructions: 'Answer the user.',
        mcp_servers: [{ name: EMAIL }],
      });

    function takesAttachments(resolved: Awaited<ReturnType<typeof resolve>>): boolean {
      return (resolved.extraCapabilities ?? []).some(capability =>
        (capability.toolResponseProcessors ?? []).some(processor => processor instanceof MailAttachmentProcessor),
      );
    }

    it("is narrowed to the mail tools and has its attachments placed only when it is the host's own", async () => {
      const resolved = await resolve(chatResolver({ setUp: [EMAIL] }), listedEmail());
      expect(mountFor(resolved, EMAIL)?.preload).toBe(true);
      expect(takesAttachments(resolved)).toBe(true);
    });

    it('is left as listed, with no attachments placed, when the host has no Email of its own set up', async () => {
      const resolved = await resolve(chatResolver({ setUp: [SEARCH_SERVER] }), listedEmail());
      expect(mountFor(resolved, EMAIL)?.preload).toBe(false);
      expect(takesAttachments(resolved)).toBe(false);
    });

    it('is still narrowed, but places no attachments, when the set-up list cannot be read', async () => {
      const resolved = await resolve(chatResolver({ setUp: undefined }), listedEmail());
      expect(mountFor(resolved, EMAIL)?.preload).toBe(true);
      expect(takesAttachments(resolved)).toBe(false);
    });
  });

  it('adds nothing to a sub-agent', async () => {
    const resolved = await resolve(chatResolver({ setUp: [SEARCH_SERVER, EMAIL, CALENDAR] }), bareSpec(), true);
    expect(resolved.definition.toolSets ?? []).toHaveLength(0);
  });
});

describe('a remembered mount of a search provider that was deleted', () => {
  const STALE = 'parallel-web';
  const DESIGNATED = 'tavily';
  const PRESETS = ['parallel-web', 'tavily'];
  let inert: InertMcpServer;

  beforeAll(async () => {
    inert = await startInertMcpServer();
  });

  afterAll(async () => {
    await inert.close();
  });

  function capturingLogger(lines: string[]): Logger {
    const stream = new Writable({
      write(chunk: Buffer, _encoding: string, callback: () => void) {
        lines.push(chunk.toString());
        callback();
      },
    });
    return createLogger({ level: 'warn', format: format.simple(), transports: [new transports.Stream({ stream })] });
  }

  function staleResolver(input: { setUp: readonly string[] | undefined; logger?: Logger }) {
    const setUp = input.setUp;
    return makeResolver({
      url: inert.url,
      searchProviderServerName: () => Promise.resolve(DESIGNATED),
      searchProviderPresetNames: () => PRESETS,
      // An unreadable set-up list is the dep being absent: the resolver reads it as unknown.
      ...(setUp === undefined ? {} : { setUpConnectorNames: () => Promise.resolve(setUp) }),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
  }

  async function mountedNames(resolver: MemoryTurnResourceResolver, spec: AgentSpec, subAgent = false) {
    const resolved = await resolve(resolver, spec, subAgent);
    return (resolved.definition.toolSets ?? []).map(toolSet => toolSet.name).sort();
  }

  const staleSpec = () =>
    AgentSpecSchema.parse({
      model: { name: CHAT_MODEL },
      instructions: 'Answer the user.',
      mcp_servers: [{ name: STALE }, { name: OTHER_SERVER }],
    });

  it('drops the stale mount, still attaches the designated provider, and logs the drop', async () => {
    const lines: string[] = [];
    const resolver = staleResolver({ setUp: [DESIGNATED, OTHER_SERVER], logger: capturingLogger(lines) });

    expect(await mountedNames(resolver, staleSpec())).toEqual([DESIGNATED, OTHER_SERVER].sort());
    expect(lines.join('')).toContain(STALE);
  });

  it('keeps the designated provider mount even when the set-up list does not name it', async () => {
    const spec = AgentSpecSchema.parse({
      model: { name: CHAT_MODEL },
      mcp_servers: [{ name: DESIGNATED }],
    });

    expect(await mountedNames(staleResolver({ setUp: [] }), spec)).toEqual([DESIGNATED]);
  });

  it('does not drop an unknown mount that is not a search provider preset', async () => {
    const spec = AgentSpecSchema.parse({
      model: { name: CHAT_MODEL },
      mcp_servers: [{ name: 'missing-mcp' }],
    });

    expect(await mountedNames(staleResolver({ setUp: [DESIGNATED] }), spec)).toEqual(
      [DESIGNATED, 'missing-mcp'].sort(),
    );
  });

  it('drops nothing when the set-up list cannot be read', async () => {
    const spec = AgentSpecSchema.parse({
      model: { name: CHAT_MODEL },
      mcp_servers: [{ name: STALE }],
    });

    expect(await mountedNames(staleResolver({ setUp: undefined }), spec)).toEqual([DESIGNATED, STALE].sort());
  });

  it('leaves a sub-agent spec exactly as stated', async () => {
    expect(await mountedNames(staleResolver({ setUp: [DESIGNATED, OTHER_SERVER] }), staleSpec(), true)).toEqual(
      [OTHER_SERVER, STALE].sort(),
    );
  });
});

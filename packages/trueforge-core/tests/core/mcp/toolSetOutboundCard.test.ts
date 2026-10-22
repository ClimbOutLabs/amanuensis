import { createLogger } from 'winston';
import { RemoteMCP, ToolSet, createSentinelHostContext, defaultSentinelServices } from '../../../src/core';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import type { ToolSchema } from '../../../src/core/mcp/IMCPServer';
import type { ToolSelectorConfig } from '../../../src/core/mcp/ToolSelectorPolicy';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import type { SentinelServices } from '../../../src/core/permissions/context';
import { DeferredTool } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

jest.mock('../../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../../src/core/mcp/remoteMcpClient')>(
    '../../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);
const noopLogger = createLogger({ silent: true });
const schema = { type: 'object' as const, properties: {} };

const webSearch: ToolSchema = {
  name: 'web_search',
  description: 'Search the web.',
  inputSchema: schema,
  annotations: { readOnlyHint: true },
};
const sendEmail: ToolSchema = { name: 'send_email', description: 'Send an email.', inputSchema: schema };
const mystery: ToolSchema = { name: 'frobnicate', description: 'Does something.', inputSchema: schema };

function makeToolSet(input: { name: string; url: string; tools: ToolSchema[]; services?: SentinelServices }): ToolSet {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: input.tools }),
      callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
      close: () => Promise.resolve(),
    }),
  );
  const remote = new RemoteMCP({
    name: input.name,
    id: input.name,
    url: input.url,
    headers: {},
    logger: noopLogger,
    tracing: NOOP_AGENT_TRACING,
    requestTimeoutMs: 60_000,
    connectTimeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  const selectors: ToolSelectorConfig = { enableTools: ['@all'], disableTools: [], preloadTools: [] };
  return new ToolSet({
    source: remote,
    selectors,
    preload: false,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'c1',
      services: input.services ?? defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    }),
  });
}

describe('approval card for connector calls', () => {
  it('shows a direct web search in plain words with the connector host and the exact query', async () => {
    const toolSet = makeToolSet({ name: 'exa', url: 'https://mcp.exa.ai/mcp?exaApiKey=secret', tools: [webSearch] });
    const info = await toolSet.toolCallInfo({ name: 'web_search', arguments: { query: 'my salary history' } });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
    expect(info.tier3_card).toMatchObject({
      plain_what: 'Search the web with web_search on exa.',
      destination_host: 'mcp.exa.ai',
      outbound_text: 'query: my salary history',
    });
  });

  it('never puts the connector URL path or query string on the card', async () => {
    const toolSet = makeToolSet({ name: 'exa', url: 'https://mcp.exa.ai/mcp?exaApiKey=secret', tools: [webSearch] });
    const info = await toolSet.toolCallInfo({ name: 'web_search', arguments: { query: 'q' } });
    expect(JSON.stringify(info.tier3_card)).not.toContain('exaApiKey');
    expect(JSON.stringify(info.tier3_card)).not.toContain('secret');
  });

  it('shows the same card when the model reaches the search through call_tool', async () => {
    const toolSet = makeToolSet({ name: 'exa', url: 'https://mcp.exa.ai/mcp', tools: [webSearch] });
    const deferred = new DeferredTool([toolSet], { tracing: NOOP_AGENT_TRACING, logger: noopLogger });
    const info = await deferred.toolCallInfo({
      name: 'call_tool',
      arguments: { mcp_server: 'exa', tool_name: 'web_search', input: { query: 'my salary history' } },
    });
    expect(info.is_deferred).toBe(true);
    expect(info.tier).toBe(3);
    expect(info.tier3_card).toMatchObject({
      plain_what: 'Search the web with web_search on exa.',
      destination_host: 'mcp.exa.ai',
      outbound_text: 'query: my salary history',
    });
  });

  it.each([
    [
      'web_fetch',
      { urls: ['https://www.usps.com/'], objective: 'o' },
      'Fetch the web page at https://www.usps.com/.',
    ],
    ['web_search', { objective: 'o', search_queries: ['q'] }, 'Search the web with web_search on parallel-web.'],
  ])('shows %s on the Parallel connector the same way directly and through call_tool', async (name, input, what) => {
    const tool: ToolSchema = { name, description: 'Parallel tool.', inputSchema: schema };
    const toolSet = makeToolSet({ name: 'parallel-web', url: 'https://search.parallel.ai/mcp', tools: [tool] });
    const deferred = new DeferredTool([toolSet], { tracing: NOOP_AGENT_TRACING, logger: noopLogger });
    const direct = await toolSet.toolCallInfo({ name, arguments: input });
    const wrapped = await deferred.toolCallInfo({
      name: 'call_tool',
      arguments: { mcp_server: 'parallel-web', tool_name: name, input },
    });
    for (const info of [direct, wrapped]) {
      expect(info.tier).toBe(3);
      expect(info.tier3_card).toMatchObject({ plain_what: what, destination_host: 'search.parallel.ai' });
    }
    expect(direct.tier3_card).toEqual(wrapped.tier3_card);
  });

  it('shows a Gmail send through call_tool with recipients, subject and body', async () => {
    const toolSet = makeToolSet({ name: 'gmail', url: 'https://gmail.example.com/mcp', tools: [sendEmail] });
    const deferred = new DeferredTool([toolSet], { tracing: NOOP_AGENT_TRACING, logger: noopLogger });
    const info = await deferred.toolCallInfo({
      name: 'call_tool',
      arguments: {
        mcp_server: 'gmail',
        tool_name: 'send_email',
        input: { to: ['alice@example.com'], subject: 'Plan', body: 'See attached.' },
      },
    });
    expect(info.tier).toBe(3);
    expect(info.tier3_card).toMatchObject({
      plain_what: 'Send an email to alice@example.com.',
      recipient: 'alice@example.com',
      destination_host: 'gmail.example.com',
    });
    expect(info.tier3_card?.outbound_text).toContain('subject: Plan');
    expect(info.tier3_card?.outbound_text).toContain('body: See attached.');
  });

  it('keeps an unknown connector tool on the fail-closed card, through call_tool too', async () => {
    const toolSet = makeToolSet({ name: 'misc', url: 'https://misc.example.com/mcp', tools: [mystery] });
    const direct = await toolSet.toolCallInfo({ name: 'frobnicate', arguments: { id: '7' } });
    const deferred = new DeferredTool([toolSet], { tracing: NOOP_AGENT_TRACING, logger: noopLogger });
    const wrapped = await deferred.toolCallInfo({
      name: 'call_tool',
      arguments: { mcp_server: 'misc', tool_name: 'frobnicate', input: { id: '7' } },
    });
    for (const info of [direct, wrapped]) {
      expect(info.tier).toBe(3);
      expect(info.tier3_card?.plain_what).toBe("This is a new tool from misc. Check what it will do before you allow it.");
      expect(info.tier3_card?.destination_host).toBe('misc.example.com');
      expect(info.tier3_card?.outbound_text).toBe('id: 7');
    }
  });
});

describe('approval is bound to the connector it was granted for', () => {
  const identity = {
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
  };

  async function approveThenDispatch(input: { cardUrl: string; dispatchUrl: string; viaCallTool: boolean }) {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const atCard = makeToolSet({ name: 'exa', url: input.cardUrl, tools: [webSearch], services });
    const wireArgs = { query: 'my salary history' };
    const wrapperArgs = { mcp_server: 'exa', tool_name: 'web_search', input: wireArgs };
    const cardSource = input.viaCallTool
      ? new DeferredTool([atCard], { tracing: NOOP_AGENT_TRACING, logger: noopLogger })
      : atCard;
    const info = await cardSource.toolCallInfo(
      input.viaCallTool ? { name: 'call_tool', arguments: wrapperArgs } : { name: 'web_search', arguments: wireArgs },
    );
    expect(info.tier).toBe(3);
    const atDispatch = makeToolSet({ name: 'exa', url: input.dispatchUrl, tools: [webSearch], services });
    const dispatchSource = input.viaCallTool
      ? new DeferredTool([atDispatch], { tracing: NOOP_AGENT_TRACING, logger: noopLogger })
      : atDispatch;
    const wireName = input.viaCallTool ? 'call_tool' : 'web_search';
    const message: InternalEnrichedAssistantMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: wireName, arguments: JSON.stringify(input.viaCallTool ? wrapperArgs : wireArgs) },
          tool_info: info,
        },
      ],
    };
    const result = await executeToolCalls({
      assistantMessage: message,
      toolMapping: new Map([[wireName, { toolSet: dispatchSource, originalToolName: wireName }]]),
      threadId: 'main',
      approvalDecisions: new Map<string, ApprovalDecision>([['call-1', { status: 'allow' }]]),
      memoState: createToolCallMemoState(),
      sentinel: { services, identity, web_search: createWebSearchTurnState() },
    });
    const outcome = result.toolCallResults[0];
    if (outcome === undefined) {
      throw new Error('expected one tool call result');
    }
    return outcome;
  }

  it.each([false, true])(
    'runs the approved call when the connector is unchanged (call_tool: %s)',
    async viaCallTool => {
      const outcome = await approveThenDispatch({
        cardUrl: 'https://mcp.exa.ai/mcp',
        dispatchUrl: 'https://mcp.exa.ai/mcp',
        viaCallTool,
      });
      expect(outcome.failure).toBe(false);
      expect(outcome.disposition).not.toBe('policy_blocked');
    },
  );

  it.each([false, true])(
    'denies the approved call when the connector URL changed after the card (call_tool: %s)',
    async viaCallTool => {
      const outcome = await approveThenDispatch({
        cardUrl: 'https://mcp.exa.ai/mcp',
        dispatchUrl: 'https://collector.evil.example/mcp',
        viaCallTool,
      });
      expect(outcome.failure).toBe(true);
      expect(outcome.disposition).toBe('policy_blocked');
      expect(outcome.rawContent).toContain('Approval invalid');
    },
  );
});

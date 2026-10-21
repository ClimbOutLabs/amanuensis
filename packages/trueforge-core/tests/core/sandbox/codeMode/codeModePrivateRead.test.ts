import { createLogger } from 'winston';
import {
  RemoteMCP,
  ToolSet,
  createSentinelHostContext,
  createWebSearchTurnState,
  defaultSentinelServices,
} from '../../../../src/core';
import type { ToolSchema } from '../../../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../../../src/core/mcp/remoteMcpClient';
import { CodeModeDispatcher } from '../../../../src/core/sandbox/codeMode/CodeModeDispatcher';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../../harnessMocks';

jest.mock('../../../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../../../src/core/mcp/remoteMcpClient')>(
    '../../../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);
const noopLogger = createLogger({ silent: true });
const schema = { type: 'object' as const, properties: {} };

const MAIL = JSON.stringify({
  from: 'Maria Costa <maria.costa@harbour-clinic.example>',
  body: 'Please bring your booking reference 4417829 before Friday.',
});

const readTool: ToolSchema = {
  name: 'read_email',
  description: 'Reads one email.',
  inputSchema: schema,
  annotations: { readOnlyHint: true, openWorldHint: false },
};
const searchTool: ToolSchema = {
  name: 'lookup',
  description: 'Looks things up on the web.',
  inputSchema: schema,
  annotations: { readOnlyHint: true, openWorldHint: true },
};

/** A Gmail connector whose read returns the mail, inside a turn that has a search provider. */
function makeToolSet() {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: [readTool, searchTool] }),
      callTool: callParams =>
        Promise.resolve({
          content: [{ type: 'text', text: callParams.name === 'read_email' ? MAIL : 'ok' }],
        }),
      close: () => Promise.resolve(),
    }),
  );
  const host = createSentinelHostContext({
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    web_search: createWebSearchTurnState(),
  });
  const toolSet = new ToolSet({
    source: new RemoteMCP({
      name: 'gmail',
      id: 'gmail',
      url: 'https://gmail.example.com/mcp',
      headers: {},
      logger: noopLogger,
      tracing: NOOP_AGENT_TRACING,
      requestTimeoutMs: 60_000,
      connectTimeoutMs: 5_000,
      signal: new AbortController().signal,
    }),
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [] },
    preload: false,
    sentinel: host,
    firstParty: true,
    searchProvider: { tools: ['lookup'], plumbing_fields: [] },
  });
  return toolSet;
}

describe('a connector read made through Code Mode', () => {
  it('holds a later search that carries a sender name, as a read through the model would', async () => {
    const toolSet = makeToolSet();
    const dispatcher = new CodeModeDispatcher({ toolSets: [toolSet], logger: makeSilentLogger() });

    const reply = await dispatcher.dispatch({
      request: { op: 'call_tool', server: 'gmail', tool: 'read_email', arguments: { message_id: 'm1' } },
      traceCarrier: {},
    });
    expect(reply).toEqual({ ok: true, result: expect.anything() });

    const info = await toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'Maria Costa clinic reviews' } });
    expect(info).toMatchObject({ tier: 3, is_approval_required: true, tier_reason: 'mcp_search_after_private_read' });
  });
});

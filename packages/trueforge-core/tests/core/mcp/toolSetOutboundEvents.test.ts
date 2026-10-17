import { createLogger } from 'winston';
import {
  RemoteMCP,
  ToolSet,
  createSentinelHostContext,
  createWebSearchTurnState,
  defaultSentinelServices,
  type OutboundEventInput,
} from '../../../src/core';
import type { ToolSchema } from '../../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';

jest.mock('../../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../../src/core/mcp/remoteMcpClient')>(
    '../../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);
const ALLOW_ONCE = { status: 'allow', scope: 'once' } as const;
const schema = { type: 'object' as const, properties: {} };

const tools: ToolSchema[] = [
  {
    name: 'lookup',
    description: 'Looks things up on the web.',
    inputSchema: schema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  { name: 'send_email', description: 'Sends an email.', inputSchema: schema },
  { name: 'send_draft', description: 'Sends a saved draft.', inputSchema: schema },
  {
    name: 'list_things',
    description: 'Lists things.',
    inputSchema: schema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

function harness(options: { url?: string; searchProvider?: boolean; withWriter?: boolean }) {
  const events: OutboundEventInput[] = [];
  const dispatched: string[] = [];
  const services = {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    outbound:
      options.withWriter === false
        ? null
        : {
            record: (input: OutboundEventInput) => {
              events.push(input);
              return Promise.resolve();
            },
          },
  };
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools }),
      callTool: params => {
        dispatched.push(params.name);
        return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
      },
      close: () => Promise.resolve(),
    }),
  );
  const toolSet = new ToolSet({
    source: new RemoteMCP({
      name: 'svc',
      id: 'svc',
      url: options.url ?? 'https://svc.example.com/mcp',
      headers: {},
      logger: createLogger({ silent: true }),
      tracing: NOOP_AGENT_TRACING,
      requestTimeoutMs: 60_000,
      connectTimeoutMs: 5_000,
      signal: new AbortController().signal,
    }),
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: undefined },
    preload: false,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'c1',
      services,
      web_search: createWebSearchTurnState(),
    }),
    searchProvider: options.searchProvider === true ? { tools: [] } : undefined,
  });
  return { toolSet, events, dispatched };
}

describe('ToolSet outbound event recording', () => {
  it('records a designated search provider call as a web search, without the query', async () => {
    const h = harness({ searchProvider: true });
    await h.toolSet.callTool({ name: 'lookup', arguments: { query: 'secret-query-text' } });

    expect(h.dispatched).toEqual(['lookup']);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      tenant_id: 't1',
      kind: 'web_search',
      host: 'svc.example.com',
      tool_name: 'lookup',
      conversation_id: 'c1',
      model: null,
      recipient_count: null,
      subject: null,
    });
    expect(h.events[0]?.request_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(h.events)).not.toContain('secret-query-text');
  });

  it('records an approved email send with recipient count and subject but not the body', async () => {
    const h = harness({});
    await h.toolSet.callTool(
      {
        name: 'send_email',
        arguments: {
          to: ['a@example.com', 'b@example.com'],
          cc: 'c@example.com',
          subject: 'Lunch on  Thursday',
          body: 'private-body-text',
        },
      },
      ALLOW_ONCE,
    );

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      kind: 'email_sent',
      host: 'svc.example.com',
      tool_name: 'send_email',
      recipient_count: 3,
      subject: 'Lunch on Thursday',
    });
    expect(JSON.stringify(h.events)).not.toContain('private-body-text');
    expect(JSON.stringify(h.events)).not.toContain('a@example.com');
  });

  it('shortens a long subject', async () => {
    const h = harness({});
    await h.toolSet.callTool(
      { name: 'send_email', arguments: { to: 'a@example.com', subject: 'x'.repeat(300) } },
      ALLOW_ONCE,
    );

    expect(h.events[0]?.subject).toBe(`${'x'.repeat(120)}...`);
  });

  it('reports no recipient count when the call names none', async () => {
    const h = harness({});
    await h.toolSet.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } }, ALLOW_ONCE);

    expect(h.events[0]).toMatchObject({ kind: 'email_sent', recipient_count: null, subject: null });
  });

  it('records any other connector call as a connector call', async () => {
    const h = harness({});
    await h.toolSet.callTool({ name: 'list_things', arguments: {} }, ALLOW_ONCE);

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ kind: 'connector_call', tool_name: 'list_things' });
  });

  it('records nothing for a call that waits for approval or is denied', async () => {
    const h = harness({});
    const pending = await h.toolSet.callTool({ name: 'send_email', arguments: { to: 'a@example.com' } });
    const denied = await h.toolSet.callTool(
      { name: 'send_email', arguments: { to: 'a@example.com' } },
      { status: 'deny', reason: 'no' },
    );

    expect('approvalRequired' in pending).toBe(true);
    expect('approvalRequired' in denied).toBe(false);
    expect(h.dispatched).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('hands the writer the host of a connector on this computer, which decides what counts as leaving', async () => {
    const h = harness({ url: 'http://127.0.0.1:9000/mcp' });
    await h.toolSet.callTool({ name: 'list_things', arguments: {} }, ALLOW_ONCE);

    expect(h.dispatched).toEqual(['list_things']);
    expect(h.events.map(event => event.host)).toEqual(['127.0.0.1:9000']);
  });

  it('dispatches normally when no writer is configured', async () => {
    const h = harness({ withWriter: false });
    await h.toolSet.callTool({ name: 'list_things', arguments: {} }, ALLOW_ONCE);

    expect(h.dispatched).toEqual(['list_things']);
  });
});

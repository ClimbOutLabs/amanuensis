import { createLogger } from 'winston';
import {
  isApprovalRequiredResponse,
  isAuthRequired,
  isCallToolResponseResult,
} from '../../../src/core/mcp/IMCPServer';
import { RemoteMCP } from '../../../src/core/mcp/RemoteMCP';
import { ToolSet } from '../../../src/core/mcp/ToolSet';
import { mcpOutboundBaseFetch } from '../../../src/core/util/outboundFetch';

// The connector's network seam is the shared outbound fetch; stubbing it here keeps every other
// layer real (RemoteMCP, connectRemoteMcp, the Parallel connection, ToolSet policy and dispatch)
// while no test traffic leaves the process.
jest.mock('../../../src/core/util/outboundFetch', () => {
  const actual = jest.requireActual<Record<string, unknown>>('../../../src/core/util/outboundFetch');
  return { __esModule: true, ...actual, mcpOutboundBaseFetch: jest.fn() };
});

const mockFetch = jest.mocked(mcpOutboundBaseFetch);

const key = 'fixture-parallel-key';
const logger = createLogger({ silent: true });

beforeEach(() => {
  mockFetch.mockReset();
});

/** Builds the connector exactly as a turn does: a RemoteMCP for the catalog URL and the headers saved in Settings, wrapped in a ToolSet with the default selectors. */
function parallelToolSet(headers: Record<string, string>): ToolSet {
  const source = new RemoteMCP({
    id: 'parallel-api',
    name: 'parallel-api',
    url: 'https://api.parallel.ai/',
    headers,
    logger,
    requestTimeoutMs: 5000,
    connectTimeoutMs: 5000,
    signal: new AbortController().signal,
  });
  return new ToolSet({
    source,
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [] },
    preload: undefined,
  });
}

test('a configured Parallel connector lists its tools for a chat without exposing the key', async () => {
  const toolSet = parallelToolSet({ 'x-api-key': key });
  const listed = await toolSet.listTools();
  if (isAuthRequired(listed)) throw new Error('Expected the tool list, not an auth request.');
  const { tools } = listed.result;
  const names = tools.map(tool => tool.name);
  expect(names).toHaveLength(44);
  expect(new Set(names).size).toBe(44);
  expect(names).toEqual(
    expect.arrayContaining([
      'web_search',
      'flight_search',
      'hotel_search',
      'image_search',
      'place_search',
      'shopping_search',
      'extract_pages',
      'web_decisions',
      'create_task_run',
      'create_findall_run',
      'create_monitor',
      'clear_research_memory',
      'chat_completions',
      'create_response',
      'suggest_task',
      'suggest_processor',
    ]),
  );
  // The tool list is what the model sees: the key from Settings never appears in it.
  expect(JSON.stringify(tools)).not.toContain(key);
  // A remote server's tools carry no offline marker, so offline mode treats them as needing the network.
  expect(tools.every(tool => tool.requires_network === undefined)).toBe(true);
  expect(mockFetch).not.toHaveBeenCalled();
});

test('paid, recurring and destructive calls wait for approval and never reach Parallel unapproved', async () => {
  const toolSet = parallelToolSet({ 'x-api-key': key });
  const gatedCalls = [
    // A paid read.
    { name: 'web_search', arguments: { body: { search_queries: ['walking routes near me'] } } },
    { name: 'list_monitors', arguments: {} },
    // Paid work creation.
    { name: 'create_task_run', arguments: { body: { processor: 'base', input: 'Summarize the town council minutes' } } },
    { name: 'create_findall_run', arguments: { body: { objective: 'Find all community garden nonprofits', entity_type: 'companies', match_conditions: [{ name: 'is_nonprofit', description: 'The organization is a registered nonprofit' }], generator: 'core', match_limit: 10 } } },
    // Recurring work: creating, changing and triggering a monitor.
    { name: 'create_monitor', arguments: { body: { type: 'event_stream', frequency: '1d', settings: { query: 'New posts about community gardens' } } } },
    { name: 'update_monitor', arguments: { monitor_id: 'mon_123', body: { frequency: '12h' } } },
    { name: 'trigger_monitor_run', arguments: { monitor_id: 'mon_123' } },
    // Destructive actions.
    { name: 'cancel_monitor', arguments: { monitor_id: 'mon_123' } },
    { name: 'cancel_findall_run', arguments: { findall_id: 'findall_1' } },
    { name: 'clear_research_memory', arguments: { body: {} } },
    { name: 'evict_from_research_memory', arguments: { body: { kind: 'task', id: 'trun_123' } } },
  ];
  for (const call of gatedCalls) {
    const response = await toolSet.callTool(call);
    expect(isApprovalRequiredResponse(response)).toBe(true);
  }
  expect(mockFetch).not.toHaveBeenCalled();
});

test('an approved search runs through the dispatcher with the configured key and keeps the key out of the answer', async () => {
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ echo: key, results: [] }), { headers: { 'content-type': 'application/json' } }),
  );
  const toolSet = parallelToolSet({ 'x-api-key': key });
  const response = await toolSet.callTool(
    { name: 'web_search', arguments: { body: { objective: 'local walking routes', search_queries: ['walking routes near me'] } } },
    { status: 'allow' },
  );
  if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result, not an approval or auth request.');
  expect(response.result.isError).toBeUndefined();
  // Parallel echoed the key back in its answer; the model-visible result must not contain it.
  expect(JSON.stringify(response.result)).not.toContain(key);
  expect(JSON.stringify(response.result)).toContain('[redacted]');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const url = mockFetch.mock.calls[0]?.[0];
  const init = mockFetch.mock.calls[0]?.[1];
  expect(String(url)).toBe('https://api.parallel.ai/v1/search');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('x-api-key')).toBe(key);
});

test('a denied call does not run', async () => {
  const toolSet = parallelToolSet({ 'x-api-key': key });
  const response = await toolSet.callTool(
    { name: 'cancel_monitor', arguments: { monitor_id: 'mon_123' } },
    { status: 'deny', reason: 'Not now' },
  );
  expect(isApprovalRequiredResponse(response)).toBe(false);
  if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result, not an approval or auth request.');
  expect(response.result.isError).toBe(true);
  expect(mockFetch).not.toHaveBeenCalled();
});

test('without a key an approved call stops with the Settings message and sends nothing', async () => {
  const toolSet = parallelToolSet({});
  const response = await toolSet.callTool(
    { name: 'web_search', arguments: { body: { search_queries: ['walking routes near me'] } } },
    { status: 'allow' },
  );
  if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result, not an approval or auth request.');
  expect(response.result.isError).toBe(true);
  expect(JSON.stringify(response.result)).toContain('Add your Parallel API key in Settings');
  expect(mockFetch).not.toHaveBeenCalled();
});

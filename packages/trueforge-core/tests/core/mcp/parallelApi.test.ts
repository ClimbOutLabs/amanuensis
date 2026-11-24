import { PARALLEL_PRODUCT_URL, parallelProductConnection } from '../../../src/core/connectors/parallel/parallelApi';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';

const key = 'private-fixture-credential';

function fixture(response: Response, maxBytes = 1024) {
  const fetch = jest.fn((_url: string | URL, _init?: RequestInit) => Promise.resolve(response));
  const connection = parallelProductConnection({
    fetch,
    signal: new AbortController().signal,
    headers: { 'x-api-key': key },
    requestTimeoutMs: 1000,
    maxBytes,
  });
  return { connection, fetch };
}

test('the configured product endpoint advertises distinct typed tools for every product family', async () => {
  const connection = await connectRemoteMcp({
    url: PARALLEL_PRODUCT_URL, headers: {}, requestTimeoutMs: 1000, connectTimeoutMs: 1000, signal: new AbortController().signal,
  });
  const { tools } = await connection.listTools();
  const names = tools.map(tool => tool.name);
  expect(new Set(names).size).toBe(44);
  expect(names).toHaveLength(44);
  expect(names).toEqual(expect.arrayContaining(['web_search', 'extract_pages', 'web_decisions', 'image_search', 'flight_search', 'hotel_search', 'place_search', 'shopping_search', 'create_task_run', 'create_task_group', 'create_findall_run', 'ingest_findall_run', 'create_monitor', 'clear_research_memory', 'chat_completions', 'create_response', 'suggest_task', 'suggest_processor']));
  expect(tools.find(tool => tool.name === 'create_monitor')?.inputSchema.properties).toHaveProperty('body');
  expect((await connection.callTool({name: 'list_monitors'})).isError).toBe(true);
});

test('sends a typed body only to the product origin and refuses redirects', async () => {
  const { connection, fetch } = fixture(Response.json({ result: 'found' }));
  // The documented search contract requires at least one keyword query; an objective alone is refused with a 422.
  const body = { objective: 'local walking routes', search_queries: ['walking routes near me'] };
  const result = await connection.callTool({ name: 'web_search', arguments: { body } });
  const url = fetch.mock.calls[0]?.[0];
  const request = fetch.mock.calls[0]?.[1];
  expect(String(url)).toBe('https://api.parallel.ai/v1/search');
  expect(request).toMatchObject({ method: 'POST', body: JSON.stringify(body), redirect: 'error' });
  expect(new Headers(request?.headers).get('x-api-key')).toBe(key);
  expect(result.content).toEqual([{ type: 'text', text: '{"result":"found"}' }]);
});

test('routes named path and query parameters without promoting arbitrary arguments to headers or URL', async () => {
  const { connection, fetch } = fixture(Response.json({ items: [] }));
  await connection.callTool({ name: 'list_monitor_events', arguments: { monitor_id: 'mon_123', limit: 3, cursor: 'page 2', origin: 'elsewhere' } });
  const url = fetch.mock.calls[0]?.[0];
  const request = fetch.mock.calls[0]?.[1];
  expect(String(url)).toBe('https://api.parallel.ai/v1/monitors/mon_123/events?cursor=page+2&limit=3');
  expect(request?.body).toBeUndefined();
  expect(request?.method).toBe('GET');
});

test('rejects an invalid path, missing request body and an unknown tool before any request', async () => {
  const { connection, fetch } = fixture(Response.json({}));
  for (const call of [{ name: 'retrieve_monitor', arguments: { monitor_id: '../billing' } }, { name: 'web_search' }, { name: 'revoke_api_key' }]) {
    expect((await connection.callTool(call)).isError).toBe(true);
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('withholds error payloads and limits successful responses', async () => {
  const denied = fixture(new Response(key, { status: 403 }));
  const result = await denied.connection.callTool({ name: 'list_monitors' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('403');
  expect(JSON.stringify(result)).not.toContain(key);
  const echoed = fixture(new Response(key));
  expect(JSON.stringify(await echoed.connection.callTool({ name: 'list_monitors' }))).not.toContain(key);
  const oversized = fixture(new Response('five!'), 4);
  await expect(oversized.connection.callTool({ name: 'list_monitors' })).rejects.toThrow('too much data');
});

test('cursor-based streams skip heartbeat frames and return the resumable event including its ID', async () => {
  const { connection } = fixture(new Response(': ping\r\n\r\nid: 25\r\ndata: {"status":"done"}\r\n\r\n', {headers:{'content-type':'text/event-stream'}}));
  const result = await connection.callTool({name: 'stream_task_group_events', arguments: {taskgroup_id:'group_1', last_event_id:'24'}});
  expect(result.content).toEqual([{type:'text',text:'id: 25\r\ndata: {"status":"done"}'}]);
});

test('sends the beta header only when a beta operation is given a beta value', async () => {
  const created = fixture(Response.json({ run_id: 'trun_123', status: 'queued' }, { status: 202 }));
  const body = { processor: 'base', input: 'Summarize the town council minutes' };
  const result = await created.connection.callTool({
    name: 'create_task_run',
    arguments: { body, parallel_beta: 'mcp-server-2025-07-17' },
  });
  expect(result.isError).toBeUndefined();
  const request = created.fetch.mock.calls[0]?.[1];
  expect(new Headers(request?.headers).get('parallel-beta')).toBe('mcp-server-2025-07-17');
  expect(request?.body).toBe(JSON.stringify(body));

  const search = fixture(Response.json({ results: [] }));
  await search.connection.callTool({
    name: 'web_search',
    arguments: { body: { search_queries: ['council minutes'] }, parallel_beta: 'mcp-server-2025-07-17' },
  });
  const searchRequest = search.fetch.mock.calls[0]?.[1];
  expect(new Headers(searchRequest?.headers).get('parallel-beta')).toBeNull();
});

test('accepts empty 204 answers and sends no body for actions that take none', async () => {
  const cancelled = fixture(new Response(null, { status: 204 }));
  const result = await cancelled.connection.callTool({
    name: 'cancel_monitor',
    arguments: { monitor_id: 'mon_123', body: { ignored: true } },
  });
  expect(result.isError).toBeUndefined();
  expect(result.content).toEqual([{ type: 'text', text: '' }]);
  const request = cancelled.fetch.mock.calls[0]?.[1];
  expect(request?.method).toBe('POST');
  expect(request?.body).toBeUndefined();

  const triggered = fixture(new Response(null, { status: 204 }));
  const triggerResult = await triggered.connection.callTool({
    name: 'trigger_monitor_run',
    arguments: { monitor_id: 'mon_123' },
  });
  expect(triggerResult.isError).toBeUndefined();
});

test('expands repeated query filters and passes the pagination cursor through', async () => {
  const { connection, fetch } = fixture(Response.json({ monitors: [], next_cursor: null }));
  await connection.callTool({
    name: 'list_monitors',
    arguments: { type: ['event_stream', 'snapshot'], status: ['active', 'cancelled'], limit: 5, cursor: 'next-page' },
  });
  const url = new URL(String(fetch.mock.calls[0]?.[0]));
  expect(url.pathname).toBe('/v1/monitors');
  expect(url.searchParams.getAll('type')).toEqual(['event_stream', 'snapshot']);
  expect(url.searchParams.getAll('status')).toEqual(['active', 'cancelled']);
  expect(url.searchParams.get('limit')).toBe('5');
  expect(url.searchParams.get('cursor')).toBe('next-page');
});

test('creates a monitor with the fields the documented contract requires', async () => {
  const { connection, fetch } = fixture(Response.json({ monitor_id: 'mon_123', status: 'active' }, { status: 201 }));
  const body = { type: 'event_stream', frequency: '1d', settings: { query: 'New posts about community gardens' } };
  const result = await connection.callTool({ name: 'create_monitor', arguments: { body } });
  expect(result.isError).toBeUndefined();
  const url = fetch.mock.calls[0]?.[0];
  const request = fetch.mock.calls[0]?.[1];
  expect(String(url)).toBe('https://api.parallel.ai/v1/monitors');
  expect(request).toMatchObject({ method: 'POST', body: JSON.stringify(body) });
});

test('extracts pages with the documented required urls field', async () => {
  const { connection, fetch } = fixture(Response.json({ extract_id: 'extract_1', results: [], errors: [] }));
  const body = { urls: ['https://example.com/community-gardens'] };
  const result = await connection.callTool({ name: 'extract_pages', arguments: { body } });
  expect(result.isError).toBeUndefined();
  expect(String(fetch.mock.calls[0]?.[0])).toBe('https://api.parallel.ai/v1/extract');
  expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(body));
});

test('creates a FindAll run with every documented required field', async () => {
  const { connection, fetch } = fixture(Response.json({ findall_id: 'findall_1' }, { status: 202 }));
  const body = {
    objective: 'Find all community garden nonprofits in the Bay Area',
    entity_type: 'companies',
    match_conditions: [{ name: 'is_nonprofit', description: 'The organization is a registered nonprofit' }],
    generator: 'core',
    match_limit: 10,
  };
  const result = await connection.callTool({ name: 'create_findall_run', arguments: { body } });
  expect(result.isError).toBeUndefined();
  expect(String(fetch.mock.calls[0]?.[0])).toBe('https://api.parallel.ai/v1beta/findall/runs');
  expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(body));
});

test('reads a streamed chat completion to the end instead of stopping at the first event', async () => {
  const stream = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" there"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const { connection } = fixture(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
  const body = { model: 'parallel-chat', messages: [{ role: 'user', content: 'Say hello' }] };
  const result = await connection.callTool({ name: 'chat_completions', arguments: { body } });
  expect(result.isError).toBeUndefined();
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  expect(text).toContain('Hello');
  expect(text).toContain(' there');
  expect(text).toContain('[DONE]');
});

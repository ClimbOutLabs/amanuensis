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
  const body = { objective: 'local walking routes' };
  const result = await connection.callTool({ name: 'web_search', arguments: { body } });
  const [url, request] = fetch.mock.calls[0]!;
  expect(String(url)).toBe('https://api.parallel.ai/v1/search');
  expect(request).toMatchObject({ method: 'POST', body: JSON.stringify(body), redirect: 'error' });
  expect(new Headers(request?.headers).get('x-api-key')).toBe(key);
  expect(result.content).toEqual([{ type: 'text', text: '{"result":"found"}' }]);
});

test('routes named path and query parameters without promoting arbitrary arguments to headers or URL', async () => {
  const { connection, fetch } = fixture(Response.json({ items: [] }));
  await connection.callTool({ name: 'list_monitor_events', arguments: { monitor_id: 'mon_123', limit: 3, cursor: 'page 2', origin: 'elsewhere' } });
  const [url, request] = fetch.mock.calls[0]!;
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

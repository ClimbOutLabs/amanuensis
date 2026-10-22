import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from 'winston';
import {
  isCallToolResponseResult,
  toolResultResponse,
  type AgentToolSchema,
  type CallToolResponse,
  type ToolSource,
} from '../../../src/core/mcp/IMCPServer';
import { SEARCH_TOO_SLOW_MESSAGE, ToolSet } from '../../../src/core/mcp/ToolSet';

const SEARCH_DEADLINE_MS = 120_000;

const searchTool: AgentToolSchema = {
  preload: true,
  name: 'web_search',
  description: 'Searches the web.',
  inputSchema: {
    type: 'object',
    properties: { objective: { type: 'string' }, search_queries: { type: 'array', items: { type: 'string' } } },
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

const freeFormTool: AgentToolSchema = {
  preload: true,
  name: 'note',
  description: 'Takes any input.',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

/** A connector whose calls answer only when the test says so, recording what each call sent. */
function fakeSource(answer: (name: string) => Promise<CallToolResponse>): {
  source: ToolSource;
  sent: CallToolRequest['params'][];
} {
  const sent: CallToolRequest['params'][] = [];
  const source: ToolSource = {
    name: 'parallel',
    id: 'parallel',
    listTools: () => Promise.resolve({ result: { tools: [searchTool, freeFormTool] }, wasInitialized: undefined }),
    callTool: params => {
      sent.push(params);
      return answer(params.name);
    },
    toolCallInfo: params =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: 'parallel',
        mcp_server_name: 'parallel',
        original_tool_name: params.name,
        is_approval_required: false,
      }),
  };
  return { source, sent };
}

function toolSet(input: { source: ToolSource; searchProvider: boolean }): ToolSet {
  return new ToolSet({
    source: input.source,
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [] },
    preload: true,
    searchCallTimeoutMs: SEARCH_DEADLINE_MS,
    logger: createLogger({ silent: true }),
    ...(input.searchProvider ? { searchProvider: { tools: ['web_search'], plumbing_fields: [] } } : {}),
  });
}

function textOf(response: CallToolResponse): string {
  if (!isCallToolResponseResult(response)) {
    throw new Error('expected a tool result');
  }
  return response.result.content.map(part => (part.type === 'text' ? part.text : '')).join('');
}

describe('search deadline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops a search that never answers and gives the model a plain error, so the reply goes on', async () => {
    const { source } = fakeSource(() => new Promise(() => undefined));
    const result = toolSet({ source, searchProvider: true }).callTool({
      name: 'web_search',
      arguments: { objective: 'Find the agenda' },
    });
    await jest.advanceTimersByTimeAsync(SEARCH_DEADLINE_MS);
    const response = await result;

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(textOf(response)).toContain(SEARCH_TOO_SLOW_MESSAGE);
  });

  it('returns a search that answers in time unchanged', async () => {
    const { source } = fakeSource(() => Promise.resolve(toolResultResponse({ text: 'three results' })));
    const response = await toolSet({ source, searchProvider: true }).callTool({
      name: 'web_search',
      arguments: { objective: 'Find the agenda' },
    });

    expect(textOf(response)).toBe('three results');
  });

  it('leaves calls to a connector that is not the search provider to the general tool deadline', async () => {
    let answer: (response: CallToolResponse) => void = () => undefined;
    const { source } = fakeSource(
      () =>
        new Promise(resolve => {
          answer = resolve;
        }),
    );
    const result = toolSet({ source, searchProvider: false }).callTool({ name: 'web_search', arguments: {} });
    await jest.advanceTimersByTimeAsync(SEARCH_DEADLINE_MS * 2);
    answer(toolResultResponse({ text: 'late but fine' }));

    expect(textOf(await result)).toBe('late but fine');
  });
});

describe('arguments the tool does not take', () => {
  it('drops a made-up argument before the connector sees it', async () => {
    const { source, sent } = fakeSource(() => Promise.resolve(toolResultResponse({ text: 'ok' })));
    await toolSet({ source, searchProvider: true }).callTool({
      name: 'web_search',
      arguments: { objective: 'Find the agenda', search_queries: ['agenda'], session_id: 'made-up' },
    });

    expect(sent[0]?.arguments).toEqual({ objective: 'Find the agenda', search_queries: ['agenda'] });
  });

  it('keeps every argument for a tool whose schema names none', async () => {
    const { source, sent } = fakeSource(() => Promise.resolve(toolResultResponse({ text: 'ok' })));
    await toolSet({ source, searchProvider: false }).callTool({
      name: 'note',
      arguments: { anything: 'goes', session_id: 'kept' },
    });

    expect(sent[0]?.arguments).toEqual({ anything: 'goes', session_id: 'kept' });
  });
});

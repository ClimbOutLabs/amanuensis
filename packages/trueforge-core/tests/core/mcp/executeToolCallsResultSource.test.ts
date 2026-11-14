import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { isTrustedLink, type ChatProvenance } from '../../../src/core/permissions/provenance';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

// Invented hosts only.
const RESULT_LINK = 'https://news.example.org/2024/06/oslo-weather';
const SEARCH_RESULT = JSON.stringify({ results: [{ title: 'Oslo weather', url: RESULT_LINK }] });

/** Runs one search-named tool that needs no card, and returns where the links of its result are recorded as from. */
async function provenanceAfterSearch(
  stamp: Pick<InternalToolCallInfo, 'search_provider_call' | 'search_result_call'>,
): Promise<ChatProvenance> {
  const callTool = jest.fn(() => Promise.resolve(toolResultResponse({ text: SEARCH_RESULT })));
  const toolSet: IToolSet = {
    name: 'finder',
    id: 'finder',
    preload: true,
    hasPreloadedTools: true,
    listTools: jest.fn(),
    toolCallInfo: jest.fn(),
    callTool,
  };
  const assistantMessage: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'web_search', arguments: JSON.stringify({ query: 'oslo weather' }) },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'finder',
          mcp_server_name: 'finder',
          original_tool_name: 'web_search',
          is_approval_required: false,
          tier: 1,
          ...stamp,
        },
      },
    ],
  };
  const web_search = createWebSearchTurnState();
  const result = await executeToolCalls({
    assistantMessage,
    toolMapping: new Map([['web_search', { toolSet, originalToolName: 'web_search' }]]),
    threadId: 'main',
    approvalDecisions: new Map(),
    memoState: createToolCallMemoState(),
    sentinel: {
      services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      web_search,
      identity: {
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 'conv-1',
        repository_id: null,
        workspace_cwd: null,
        agent_intent: null,
      },
    },
  });
  expect(callTool).toHaveBeenCalledTimes(1);
  expect(result.toolCallResults[0]?.failure).toBe(false);
  return web_search.provenance;
}

describe('where the links of a fresh search result come from', () => {
  it('counts the links the chosen search provider returned as found for the person', async () => {
    const provenance = await provenanceAfterSearch({ search_provider_call: true, search_result_call: true });
    expect(isTrustedLink({ provenance, url: RESULT_LINK })).toBe(true);
  });

  it('treats the links another connector returned from a tool named web_search as something read', async () => {
    const provenance = await provenanceAfterSearch({});
    expect(isTrustedLink({ provenance, url: RESULT_LINK })).toBe(false);
    expect(provenance.untrusted.urls.size).toBe(1);
  });
});

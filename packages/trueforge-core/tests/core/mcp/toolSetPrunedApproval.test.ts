import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import { toolResultResponse, type ToolSource } from '../../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../../src/core/mcp/ToolSet';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';
import { DeferredTool } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

test('an approved call_tool call with a made-up inner argument runs with only the arguments the tool takes', async () => {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  const sentinel = createSentinelHostContext({ tenant_id: 't1', created_by: 'u1', conversation_id: 'c1', services });
  const sent: CallToolRequest['params'][] = [];
  const source: ToolSource = {
    name: 'notes',
    id: 'notes',
    listTools: () =>
      Promise.resolve({
        result: {
          tools: [
            {
              name: 'send_note',
              description: 'Send a note',
              preload: false,
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
          ],
        },
        wasInitialized: undefined,
      }),
    callTool: params => {
      sent.push(params);
      return Promise.resolve(toolResultResponse({ text: 'ok' }));
    },
    toolCallInfo: params =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: 'notes',
        mcp_server_name: 'notes',
        original_tool_name: params.name,
      }),
  };
  const toolSet = new ToolSet({
    source,
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [] },
    preload: false,
    sentinel,
  });
  const deferred = new DeferredTool([toolSet], { tracing: NOOP_AGENT_TRACING, logger: makeSilentLogger() });
  const wire = { mcp_server: 'notes', tool_name: 'send_note', input: { text: 'hi', session_id: 'made-up' } };
  const info = await deferred.toolCallInfo({ name: 'call_tool', arguments: wire });
  expect(info.approval_token_id).toBeTruthy();
  expect(info.tier3_card?.outbound_text).toBe('text: hi');
  const message: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'call_tool', arguments: JSON.stringify(wire) }, tool_info: info },
    ],
  };
  const result = await executeToolCalls({
    assistantMessage: message,
    toolMapping: new Map([['call_tool', { toolSet: deferred, originalToolName: 'call_tool' }]]),
    threadId: 'main',
    approvalDecisions: new Map<string, ApprovalDecision>([['c1', { status: 'allow' }]]),
    memoState: createToolCallMemoState(),
    sentinel: {
      services,
      web_search: createWebSearchTurnState(),
      identity: {
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 'c1',
        repository_id: null,
        workspace_cwd: null,
        agent_intent: null,
      },
    },
  });
  expect(result.toolCallResults[0]?.failure).toBe(false);
  expect(sent.map(call => call.arguments)).toEqual([{ text: 'hi' }]);
});

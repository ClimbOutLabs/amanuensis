/**
 * An embedded map call through the builtin tool-call path: classify the unstamped call the way the turn
 * does, then check whether the turn would hold it for approval and whether it runs through
 * executeToolCalls. The map tool declares no MCP annotations, the same as the production maps tool set,
 * so the default approval selectors cannot match it; only the classifier's stamp decides whether it asks.
 */
import { z } from 'zod';
import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../../src/core/mcp/LocalToolMCP';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { classifyUnstampedToolCall } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const handler = jest.fn(() => Promise.resolve(toolResultResponse({ text: '{"ok":true}' })));

class MapLikeTools extends LocalToolMCP {
  readonly name = 'maps';
  readonly displayName = 'Maps';

  constructor() {
    super({ tracing: NOOP_AGENT_TRACING });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: 'render_map',
      description: 'Renders a map for a place.',
      schema: z.object({ place_name: z.string() }).strict(),
      handler,
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }
}

const ARGS = { place_name: 'Paris' };

async function runMap({ maps_without_asking }: { maps_without_asking: boolean }) {
  handler.mockClear();
  const tools = new MapLikeTools();
  const services: SentinelServices = {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    mapsWithoutAsking: () => Promise.resolve(maps_without_asking),
  };
  const sentinel = createSentinelHostContext({
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    services,
  });
  const info = await tools.toolCallInfo({ name: 'render_map', arguments: ARGS });
  const stamped: InternalToolCallInfo = await classifyUnstampedToolCall({
    sentinel,
    canonical_params: ARGS,
    info,
  });
  const assistantMessage: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'render_map', arguments: JSON.stringify(ARGS) },
        tool_info: stamped,
      },
    ],
  };
  // The turn holds a call whose stamp requires approval before it reaches executeToolCalls.
  const held = (assistantMessage.tool_calls ?? []).filter(call => call.tool_info.is_approval_required === true);
  if (held.length > 0) {
    return { stamped, ran: handler.mock.calls.length };
  }
  await executeToolCalls({
    assistantMessage,
    toolMapping: new Map([['render_map', { toolSet: tools, originalToolName: 'render_map' }]]),
    threadId: 'main',
    approvalDecisions: new Map(),
    memoState: createToolCallMemoState(),
    sentinel: {
      services,
      web_search: createWebSearchTurnState(),
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
  return { stamped, ran: handler.mock.calls.length };
}

describe('an embedded map through the builtin tool-call path', () => {
  it('runs with no approval card on a clean chat when maps run without asking', async () => {
    const { stamped, ran } = await runMap({ maps_without_asking: true });
    expect(stamped.tier).toBe(1);
    expect(stamped.is_approval_required).toBe(false);
    expect(ran).toBe(1);
  });

  it('still asks when maps do not run without asking', async () => {
    const { stamped, ran } = await runMap({ maps_without_asking: false });
    expect(stamped.tier).toBe(3);
    expect(stamped.is_approval_required).toBe(true);
    expect(ran).toBe(0);
  });
});

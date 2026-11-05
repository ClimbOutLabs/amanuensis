/**
 * A browser click reaches its tool set with the page read it was classified from, so the browser
 * can refuse the click when the element at its ref no longer reads that way.
 */
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { BrowserElementReview, InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import type { IToolSet, ToolInvocationContext } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import { BROWSER_CLICK_TOOL_NAME } from '../../../src/core/permissions/browserToolNames';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const CHECKED: BrowserElementReview = {
  site: 'shop.example',
  accessible_name: 'Help center',
  role: 'link',
  is_form_submit: false,
  form_values: {},
  link_url: 'https://shop.example/help',
};

async function dispatchClicks(reviews: (BrowserElementReview | undefined)[]): Promise<(ToolInvocationContext | undefined)[]> {
  const contexts: (ToolInvocationContext | undefined)[] = [];
  const toolSet: IToolSet = {
    name: 'browser',
    id: 'browser',
    preload: true,
    hasPreloadedTools: true,
    listTools: jest.fn(),
    toolCallInfo: jest.fn(),
    callTool: jest.fn((_params, _decision, context?: ToolInvocationContext) => {
      contexts.push(context);
      return Promise.resolve(toolResultResponse({ text: 'ok' }));
    }),
  };
  const assistantMessage: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: reviews.map((review, index) => ({
      id: `call-${String(index)}`,
      type: 'function',
      function: { name: BROWSER_CLICK_TOOL_NAME, arguments: JSON.stringify({ ref: 'e1' }) },
      tool_info: {
        type: 'truefoundry-system',
        mcp_server_id: 'browser',
        mcp_server_name: 'browser',
        original_tool_name: BROWSER_CLICK_TOOL_NAME,
        is_approval_required: false,
        tier: 1,
        ...(review === undefined ? {} : { browser_element: review }),
      },
    })),
  };
  await executeToolCalls({
    assistantMessage,
    toolMapping: new Map([[BROWSER_CLICK_TOOL_NAME, { toolSet, originalToolName: BROWSER_CLICK_TOOL_NAME }]]),
    threadId: 'main',
    approvalDecisions: new Map<string, ApprovalDecision>(),
    memoState: createToolCallMemoState(),
    sentinel: {
      services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
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
  return contexts;
}

describe('executeToolCalls: browser clicks carry their checked read', () => {
  test('each click reaches the tool set with the read it was classified from', async () => {
    const second: BrowserElementReview = { ...CHECKED, accessible_name: 'Pricing', link_url: 'https://shop.example/p' };
    const contexts = await dispatchClicks([CHECKED, second]);
    expect(contexts.map(context => context?.browser_element_precondition)).toEqual([CHECKED, second]);
  });

  test('a click with no read reaches the tool set with none, so the tool set refuses it', async () => {
    const contexts = await dispatchClicks([undefined]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.browser_element_precondition).toBeUndefined();
  });
});

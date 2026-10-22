/**
 * A private read's result is recorded by the dispatch loop itself, so a later search that copies it is held even
 * though the tool that returned it never mentioned the check.
 */
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import { classifyTier, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelDispatchContext } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const MAIL_ATTACHMENT_TEXT = 'Invoice 4471 is due to Harbour Clinic on Friday, paid by bank transfer only.';

function searchFor(query: string): SentinelAction {
  return {
    tool_name: 'web_search',
    canonical_params: { query },
    tool_type: 'mcp',
    mcp_server_name: 'search',
    mcp_search_provider: true,
    mcp_search_tool: true,
    mcp_hints: { read_only_hint: true, open_world_hint: true },
  };
}

/** Runs one document read through the real dispatch loop, with the turn's state shared as a sub-agent would share it. */
async function dispatchDocumentRead(input: {
  text: string;
  isError?: boolean;
  turn: ReturnType<typeof createWebSearchTurnState>;
  toolName?: string;
}) {
  const toolName = input.toolName ?? 'extract_document_text';
  const callTool = jest.fn(() =>
    Promise.resolve(toolResultResponse({ text: input.text, isError: input.isError === true })),
  );
  const toolSet: IToolSet = {
    name: 'documents',
    id: 'documents',
    preload: true,
    hasPreloadedTools: true,
    listTools: jest.fn(),
    toolCallInfo: jest.fn(),
    callTool,
  };
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  const sentinel: SentinelDispatchContext = {
    services,
    identity: {
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'c1',
      repository_id: null,
      workspace_cwd: null,
      agent_intent: null,
    },
    web_search: input.turn,
  };
  const assistantMessage: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: toolName, arguments: '{"file_paths":["/workspace/mail/invoice.pdf"]}' },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'documents',
          mcp_server_name: 'documents',
          is_approval_required: false,
          tier: 1,
          original_tool_name: toolName,
          read_only_hint: true,
        },
      },
    ],
  };
  const result = await executeToolCalls({
    assistantMessage,
    toolMapping: new Map([[toolName, { toolSet, originalToolName: toolName }]]),
    threadId: 'main',
    approvalDecisions: new Map<string, ApprovalDecision>(),
    memoState: createToolCallMemoState(),
    sentinel,
  });
  return result.toolCallResults;
}

describe('the dispatch loop records private reads before the model sees them', () => {
  it('holds a search that copies text from a document read through the loop', async () => {
    const turn = createWebSearchTurnState();
    const toolResults = await dispatchDocumentRead({ text: MAIL_ATTACHMENT_TEXT, turn });
    expect(toolResults[0]?.message.content).toContain('Harbour Clinic');
    const decision = await classifyTier(searchFor('is due to Harbour Clinic on Friday'), {
      services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'c1',
      repository_id: null,
      workspace_cwd: null,
      agent_intent: null,
      web_search: turn,
    });
    expect(decision).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
  });

  it('marks the turn when a mail read dispatches through the loop, so a later search is checked', async () => {
    const turn = createWebSearchTurnState();
    await dispatchDocumentRead({ text: 'Subject: Invoice 4471', turn, toolName: 'read_email' });
    expect(turn.privateDataRead).toBe(true);
  });

  it('holds later searches when the private read fails inside the loop', async () => {
    const turn = createWebSearchTurnState();
    await dispatchDocumentRead({ text: 'document service unavailable', isError: true, turn });
    const decision = await classifyTier(searchFor('best tapas in Lisbon'), {
      services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'c1',
      repository_id: null,
      workspace_cwd: null,
      agent_intent: null,
      web_search: turn,
    });
    expect(decision).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
  });
});

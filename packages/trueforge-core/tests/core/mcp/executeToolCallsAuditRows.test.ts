/**
 * Audit rows for calls stopped after approval: a pre-dispatch verification failure leaves one
 * auto_denied row, and a mail send the sidecar refuses after approval leaves one denied row
 * beside the row that records the person's decision.
 */
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import type { CallToolResponse, IToolSet } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import { actionIdFor } from '../../../src/core/permissions/approvalTokens';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';
import { TEST_TOKEN_SCOPE, testApprovalOwner } from '../permissions/approvalTokenFixtures';

const CARD = {
  plain_what: 'Send an email to dana@example.com?',
  plain_why: null,
  cannot_be_undone: null,
  why_asked_again: null,
  destination: null,
  recipient: null,
  amount: null,
  parsed_command: null,
  outbound_text: null,
  destination_host: null,
  outbound_truncated: false,
};

function servicesWithAudit(): { services: SentinelServices; records: AuditRecordInput[] } {
  const records: AuditRecordInput[] = [];
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  services.audit = {
    record: input => {
      records.push(input);
      return Promise.resolve();
    },
  };
  return { services, records };
}

async function mintToken(input: {
  services: SentinelServices;
  tool_name: string;
  canonical_params: Record<string, unknown>;
}): Promise<string> {
  const token = await input.services.token_store.mint({
    ...testApprovalOwner(),
    action_id: actionIdFor({ tool_name: input.tool_name, canonical_params: input.canonical_params }),
    canonical_params: input.canonical_params,
  });
  return token.token_id;
}

async function dispatch(input: {
  services: SentinelServices;
  wireArgs: Record<string, unknown>;
  toolInfo: Partial<InternalToolCallInfo> & { original_tool_name: string };
  result: CallToolResponse;
}): Promise<{ disposition: string | undefined; executed: boolean }> {
  const callTool = jest.fn(() => Promise.resolve(input.result));
  const toolSet: IToolSet = {
    name: 'test',
    id: 'test',
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
        function: { name: 'test_tool', arguments: JSON.stringify(input.wireArgs) },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'test',
          mcp_server_name: 'test',
          is_approval_required: true,
          tier: 3,
          ...input.toolInfo,
        },
      },
    ],
  };
  const result = await executeToolCalls({
    assistantMessage,
    toolMapping: new Map([['test_tool', { toolSet, originalToolName: 'test_tool' }]]),
    threadId: 'main',
    approvalDecisions: new Map<string, ApprovalDecision>([['call-1', { status: 'allow' }]]),
    memoState: createToolCallMemoState(),
    sentinel: {
      services: input.services,
      web_search: createWebSearchTurnState(),
      identity: {
        tenant_id: TEST_TOKEN_SCOPE.tenant_id,
        created_by: TEST_TOKEN_SCOPE.created_by,
        conversation_id: 'conv-1',
        repository_id: null,
        workspace_cwd: null,
        agent_intent: null,
      },
    },
  });
  const outcome = result.toolCallResults[0];
  if (outcome === undefined) {
    throw new Error('expected one tool call result');
  }
  return { disposition: outcome.disposition, executed: callTool.mock.calls.length === 1 };
}

describe('a call stopped by pre-dispatch verification', () => {
  it('leaves exactly one auto_denied row naming that it no longer matched its approval', async () => {
    const { services, records } = servicesWithAudit();
    const approved = { path: 'notes.md', content: 'x' };
    const tokenId = await mintToken({
      services,
      tool_name: 'write_file',
      canonical_params: { ...approved, content: 'y' },
    });

    const outcome = await dispatch({
      services,
      wireArgs: approved,
      toolInfo: { original_tool_name: 'write_file', tier: 2, tier3_card: CARD, approval_token_id: tokenId },
      result: toolResultResponse({ text: 'ok' }),
    });

    expect(outcome.disposition).toBe('policy_blocked');
    expect(outcome.executed).toBe(false);
    const stopped = records.filter(record => record.outcome === 'auto_denied');
    expect(stopped).toEqual([
      expect.objectContaining({
        tenant_id: TEST_TOKEN_SCOPE.tenant_id,
        created_by: TEST_TOKEN_SCOPE.created_by,
        conversation_id: 'conv-1',
        tool_name: 'write_file',
        description: 'This call no longer matched the approval it was given, so it was not run.',
        auto_deny_reason: null,
      }),
    ]);
  });
});

describe('a mail send the sidecar refuses after approval', () => {
  const args = { recipients: ['dana@example.com'], subject: 'Lunch', body: 'Noon?' };

  async function dispatchMail(result: CallToolResponse) {
    const { services, records } = servicesWithAudit();
    const tokenId = await mintToken({ services, tool_name: 'send_email', canonical_params: args });
    const outcome = await dispatch({
      services,
      wireArgs: args,
      toolInfo: {
        original_tool_name: 'send_email',
        tier: 3,
        tier3_card: CARD,
        approval_token_id: tokenId,
        mail_send: true,
      },
      result,
    });
    return { outcome, records };
  }

  it('adds one denied row beside the approved row when the sidecar refuses the recipient', async () => {
    const { outcome, records } = await dispatchMail(
      toolResultResponse({
        text: JSON.stringify({ error: 'recipient policy denied one or more addresses' }),
        isError: true,
      }),
    );

    expect(outcome.executed).toBe(true);
    expect(records.map(record => record.outcome)).toEqual(['approved', 'denied']);
    expect(records[1]).toMatchObject({
      tool_name: 'send_email',
      tier: 3,
      description:
        'The mail service refused the recipient after this send was approved, so the message was not sent.',
      auto_deny_reason: null,
    });
  });

  it('adds no denied row when the send goes through', async () => {
    const { records } = await dispatchMail(toolResultResponse({ text: 'sent' }));
    expect(records.map(record => record.outcome)).toEqual(['approved']);
  });

  it('adds no denied row for a failure that is not the recipient policy', async () => {
    const { records } = await dispatchMail(
      toolResultResponse({ text: JSON.stringify({ error: 'The mailbox is full.' }), isError: true }),
    );
    expect(records.map(record => record.outcome)).toEqual(['approved']);
  });
});

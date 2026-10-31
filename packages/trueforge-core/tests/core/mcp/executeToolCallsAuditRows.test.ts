/**
 * Audit rows for calls stopped after approval: a pre-dispatch verification failure leaves one
 * auto_denied row, and a mail send the sidecar refuses after approval leaves one denied row
 * beside the row that records the person's decision.
 */
import { MailConnectorSource } from '../../../src/core/email/mailConnector/MailConnectorSource';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import type { CallToolResponse, IToolSet, ToolSource } from '../../../src/core/mcp/IMCPServer';
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

function servicesWithAudit(input?: {
  /** Rows the log refuses to write, as a log that is down for that write. */
  failOn?: ((record: AuditRecordInput) => boolean) | undefined;
}): { services: SentinelServices; records: AuditRecordInput[] } {
  const records: AuditRecordInput[] = [];
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  services.audit = {
    record: record => {
      if (input?.failOn?.(record) === true) {
        return Promise.reject(new Error('activity log is down'));
      }
      records.push(record);
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
  /** The call as the host would run it, when the canned result alone would skip a real layer. */
  callTool?: IToolSet['callTool'] | undefined;
  /** The wire name the call goes out under; the connector layer keys on it. */
  toolName?: string | undefined;
}): Promise<{ disposition: string | undefined; executed: boolean }> {
  const toolName = input.toolName ?? 'test_tool';
  const callTool = jest.fn(input.callTool ?? (() => Promise.resolve(input.result)));
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
        function: { name: toolName, arguments: JSON.stringify(input.wireArgs) },
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
    toolMapping: new Map([[toolName, { toolSet, originalToolName: toolName }]]),
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

  async function dispatchMail(
    result: CallToolResponse,
    bundle: { services: SentinelServices; records: AuditRecordInput[] } = servicesWithAudit(),
  ) {
    const tokenId = await mintToken({ services: bundle.services, tool_name: 'send_email', canonical_params: args });
    const outcome = await dispatch({
      services: bundle.services,
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
    return { outcome, records: bundle.records };
  }

  /**
   * The same send through the layers the product composes: the raw sidecar source behind the
   * Email connector layer, which fills in the account and replaces the sidecar's raw refusal
   * with a plain stop before the dispatch ever sees the result.
   */
  async function dispatchMailThroughConnector(
    result: CallToolResponse,
    bundle: { services: SentinelServices; records: AuditRecordInput[] } = servicesWithAudit(),
  ) {
    const tokenId = await mintToken({ services: bundle.services, tool_name: 'send_email', canonical_params: args });
    const inner: ToolSource = {
      name: 'Email',
      id: 'Email',
      listTools: jest.fn(),
      toolCallInfo: jest.fn(),
      callTool: jest.fn(() => Promise.resolve(result)),
    };
    const source = new MailConnectorSource({
      inner,
      accounts: () => Promise.resolve(['main']),
      now: () => new Date(),
      timeZone: undefined,
    });
    const outcome = await dispatch({
      services: bundle.services,
      wireArgs: args,
      toolInfo: {
        original_tool_name: 'send_email',
        tier: 3,
        tier3_card: CARD,
        approval_token_id: tokenId,
        mail_send: true,
      },
      result,
      toolName: 'send_email',
      callTool: (params, decision, context) => source.callTool(params, decision, context),
    });
    return { outcome, records: bundle.records };
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

  it('adds one denied row when the refusal arrives through the Email connector layer', async () => {
    const { outcome, records } = await dispatchMailThroughConnector(
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

  it('settles the send exactly as before when the refused-send row cannot be written', async () => {
    const raw = toolResultResponse({
      text: JSON.stringify({ error: 'recipient policy denied one or more addresses' }),
      isError: true,
    });
    const working = await dispatchMail(raw);
    const failing = await dispatchMail(
      raw,
      servicesWithAudit({ failOn: record => record.outcome === 'denied' }),
    );

    expect(failing.outcome.executed).toBe(true);
    expect(failing.outcome.disposition).toBe(working.outcome.disposition);
    expect(failing.records.map(record => record.outcome)).toEqual(['approved']);
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

/**
 * Sentinel pre-dispatch verification through executeToolCalls.
 *
 * Covers the approval-token identity paths added for the token param
 * mismatch fix: the mint-site recorded identity (mint_tool_name /
 * mint_canonical_params), the deferred call_tool unwrap, and the wrapper-
 * classified fallback. Each test mints a real token over the exact identity
 * the classifier would have used, then dispatches the approved Tier 3 call
 * through the real executeToolCalls verify path.
 */
import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import { actionIdFor, toJsonSafeParams } from '../../../src/core/permissions/approvalTokens';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';

function mockToolSet(): { toolSet: IToolSet; callTool: jest.Mock } {
  const callTool = jest.fn(() => Promise.resolve(toolResultResponse({ text: 'ok' })));
  const toolSet: IToolSet = {
    name: 'test',
    id: 'test',
    preload: true,
    hasPreloadedTools: true,
    listTools: jest.fn(),
    toolCallInfo: jest.fn(),
    callTool,
  };
  return { toolSet, callTool };
}

function toolCall(input: {
  id: string;
  wireName: string;
  wireArgs: Record<string, unknown>;
  toolInfo: Partial<InternalToolCallInfo> & { original_tool_name: string };
}): InternalEnrichedAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: input.id,
        type: 'function',
        function: { name: input.wireName, arguments: JSON.stringify(input.wireArgs) },
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
}

async function dispatchApproved(input: {
  services: SentinelServices;
  wireName: string;
  wireArgs: Record<string, unknown>;
  toolInfo: Partial<InternalToolCallInfo> & { original_tool_name: string };
}): Promise<{
  failure: boolean;
  disposition: string | undefined;
  reasonCode: string | undefined;
  executed: boolean;
}> {
  const { toolSet, callTool } = mockToolSet();
  const result = await executeToolCalls({
    assistantMessage: toolCall({
      id: 'call-1',
      wireName: input.wireName,
      wireArgs: input.wireArgs,
      toolInfo: input.toolInfo,
    }),
    toolMapping: new Map([[input.wireName, { toolSet, originalToolName: input.wireName }]]),
    threadId: 'main',
    approvalDecisions: new Map([['call-1', { status: 'allow' }]]),
    memoState: createToolCallMemoState(),
    sentinel: {
      services: input.services,
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
  const outcome = result.toolCallResults[0];
  if (outcome === undefined) {
    throw new Error('expected one tool call result');
  }
  return {
    failure: outcome.failure,
    disposition: outcome.disposition,
    reasonCode: outcome.remediation?.reason_code,
    executed: callTool.mock.calls.length === 1,
  };
}

function mintToken(input: {
  services: SentinelServices;
  tool_name: string;
  canonical_params: Record<string, unknown>;
}): string {
  return input.services.token_store.mint({
    action_id: actionIdFor({ tool_name: input.tool_name, canonical_params: input.canonical_params }),
    canonical_params: input.canonical_params,
  }).token_id;
}

describe('executeToolCalls sentinel pre-dispatch: mint identity', () => {
  test('verifies against mint_tool_name when the display name was remapped', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const params = { command: 'ls -la' };
    // The sandbox mints over the invoked name ('exec') while
    // original_tool_name is remapped for display ('sandbox:exec').
    const tokenId = mintToken({ services, tool_name: 'exec', canonical_params: params });
    const outcome = await dispatchApproved({
      services,
      wireName: 'test_tool',
      wireArgs: params,
      toolInfo: {
        original_tool_name: 'sandbox:exec',
        mint_tool_name: 'exec',
        approval_token_id: tokenId,
      },
    });
    expect(outcome.disposition).not.toBe('policy_blocked');
    expect(outcome.executed).toBe(true);
  });

  test('falls back to original_tool_name when mint_tool_name is absent', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const params = { command: 'ls -la' };
    const tokenId = mintToken({ services, tool_name: 'exec', canonical_params: params });
    const outcome = await dispatchApproved({
      services,
      wireName: 'test_tool',
      wireArgs: params,
      toolInfo: {
        original_tool_name: 'exec',
        approval_token_id: tokenId,
      },
    });
    expect(outcome.disposition).not.toBe('policy_blocked');
    expect(outcome.executed).toBe(true);
  });

  test('fails closed when mint_tool_name does not match the minted identity', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const params = { command: 'ls -la' };
    const tokenId = mintToken({ services, tool_name: 'exec', canonical_params: params });
    const outcome = await dispatchApproved({
      services,
      wireName: 'test_tool',
      wireArgs: params,
      toolInfo: {
        original_tool_name: 'exec',
        mint_tool_name: 'rm',
        approval_token_id: tokenId,
      },
    });
    expect(outcome.disposition).toBe('policy_blocked');
    expect(outcome.reasonCode).toBe('sentinel_verification_failed');
    expect(outcome.failure).toBe(true);
    expect(outcome.executed).toBe(false);
  });
});

describe('executeToolCalls sentinel pre-dispatch: mint_canonical_params', () => {
  test('verifies structured-edit args against the recorded normalized params', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    // Structured-edit args carry values that do not survive a JSON
    // round-trip (Date); the sandbox normalizes before minting and records
    // the normalized form for the verifier.
    const liveParams = {
      path: '/tmp/notes.md',
      edits: [{ old_text: 'a', new_text: 'b' }],
      observed_at: new Date('2026-01-02T03:04:05.006Z'),
    };
    const liveRecord: Record<string, unknown> = { ...liveParams };
    const normalized = toJsonSafeParams(liveRecord);
    const tokenId = mintToken({ services, tool_name: 'apply_patch', canonical_params: normalized });
    const wireForm: Record<string, unknown> = JSON.parse(JSON.stringify(liveParams));
    const outcome = await dispatchApproved({
      services,
      wireName: 'test_tool',
      wireArgs: wireForm,
      toolInfo: {
        original_tool_name: 'apply_patch',
        mint_tool_name: 'apply_patch',
        mint_canonical_params: normalized,
        approval_token_id: tokenId,
      },
    });
    expect(outcome.disposition).not.toBe('policy_blocked');
    expect(outcome.executed).toBe(true);
  });

  test('mint_canonical_params takes precedence over the wire arguments', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const params = { path: '/a' };
    const tokenId = mintToken({ services, tool_name: 'apply_patch', canonical_params: params });
    // The recorded mint params differ from both the token and the wire
    // args: verification must hash the recorded values and fail.
    const outcome = await dispatchApproved({
      services,
      wireName: 'test_tool',
      wireArgs: params,
      toolInfo: {
        original_tool_name: 'apply_patch',
        mint_canonical_params: { path: '/b' },
        approval_token_id: tokenId,
      },
    });
    expect(outcome.disposition).toBe('policy_blocked');
    expect(outcome.reasonCode).toBe('sentinel_verification_failed');
    expect(outcome.executed).toBe(false);
  });
});

describe('executeToolCalls sentinel pre-dispatch: deferred call_tool', () => {
  test('unwraps the wrapper and verifies the underlying tool identity', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const innerInput = { path: '/etc/hosts' };
    // Mint classified the underlying tool (DeferredTool.toolCallInfo
    // unwraps call_tool), so the token covers the inner input.
    const tokenId = mintToken({ services, tool_name: 'read_file', canonical_params: innerInput });
    const outcome = await dispatchApproved({
      services,
      wireName: 'test_tool',
      wireArgs: { mcp_server: 'fs', tool_name: 'read_file', input: innerInput },
      toolInfo: {
        original_tool_name: 'read_file',
        is_deferred: true,
        approval_token_id: tokenId,
      },
    });
    expect(outcome.disposition).not.toBe('policy_blocked');
    expect(outcome.executed).toBe(true);
  });

  test('wrapper-classified fallback verifies against the wrapper itself', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const wrapperArgs = { mcp_server: 'fs', tool_name: 'read_file', input: { path: '/etc/hosts' } };
    // When the wrapper did not parse at mint, classification covered
    // call_tool itself; the verifier must not unwrap.
    const tokenId = mintToken({ services, tool_name: 'call_tool', canonical_params: wrapperArgs });
    const outcome = await dispatchApproved({
      services,
      wireName: 'test_tool',
      wireArgs: wrapperArgs,
      toolInfo: {
        original_tool_name: 'call_tool',
        is_deferred: true,
        approval_token_id: tokenId,
      },
    });
    expect(outcome.disposition).not.toBe('policy_blocked');
    expect(outcome.executed).toBe(true);
  });

  test('unparseable wrapper args at verify fall back to the wrapper hash', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    // Mint unwrapped to the underlying tool, but the wire args no longer
    // parse as a wrapper: tryUnwrapCallToolInput returns undefined and the
    // verifier hashes the wrapper, which must not match the minted token.
    const tokenId = mintToken({ services, tool_name: 'read_file', canonical_params: { path: '/x' } });
    const outcome = await dispatchApproved({
      services,
      wireName: 'test_tool',
      wireArgs: { not_a_wrapper: true },
      toolInfo: {
        original_tool_name: 'read_file',
        is_deferred: true,
        approval_token_id: tokenId,
      },
    });
    expect(outcome.disposition).toBe('policy_blocked');
    expect(outcome.reasonCode).toBe('sentinel_verification_failed');
    expect(outcome.executed).toBe(false);
  });
});

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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import { actionIdFor, toJsonSafeParams } from '../../../src/core/permissions/approvalTokens';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { TEST_TOKEN_SCOPE, testApprovalOwner } from '../permissions/approvalTokenFixtures';

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
  workspaceCwd?: string | null | undefined;
  /** Defaults to allow; null supplies no decision at all. */
  decision?: ApprovalDecision | null | undefined;
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
    approvalDecisions: new Map<string, ApprovalDecision>(
      input.decision === null ? [] : [['call-1', input.decision ?? { status: 'allow' }]],
    ),
    memoState: createToolCallMemoState(),
    sentinel: {
      services: input.services,
      identity: {
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 'conv-1',
        repository_id: null,
        workspace_cwd: input.workspaceCwd ?? null,
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

describe('executeToolCalls sentinel pre-dispatch: mint identity', () => {
  test('verifies against mint_tool_name when the display name was remapped', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const params = { command: 'ls -la' };
    // The sandbox mints over the invoked name ('exec') while
    // original_tool_name is remapped for display ('sandbox:exec').
    const tokenId = await mintToken({ services, tool_name: 'exec', canonical_params: params });
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
    const tokenId = await mintToken({ services, tool_name: 'exec', canonical_params: params });
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
    const tokenId = await mintToken({ services, tool_name: 'exec', canonical_params: params });
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
    const tokenId = await mintToken({ services, tool_name: 'apply_patch', canonical_params: normalized });
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
    const tokenId = await mintToken({ services, tool_name: 'apply_patch', canonical_params: params });
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

const TIER2_CARD = {
  plain_what: 'Change `notes.md` in your workspace.',
  plain_why: null,
  cannot_be_undone: null,
  why_asked_again: null,
  destination: null,
  recipient: null,
  amount: null,
  parsed_command: null,
};

describe('executeToolCalls sentinel pre-dispatch: Tier 2', () => {
  const params = { path: 'notes.md', content: 'x' };

  test('an approved Tier 2 call redeems its token and runs', async () => {
    const { services, records } = servicesWithAudit();
    const tokenId = await mintToken({ services, tool_name: 'write_file', canonical_params: params });
    const outcome = await dispatchApproved({
      services,
      wireName: 'test_tool',
      wireArgs: params,
      toolInfo: { original_tool_name: 'write_file', tier: 2, tier3_card: TIER2_CARD, approval_token_id: tokenId },
    });
    expect(outcome.executed).toBe(true);
    expect(await services.token_store.redeem({ ...TEST_TOKEN_SCOPE, token_id: tokenId })).toBeUndefined();
    expect(records.map(record => [record.tier, record.outcome])).toEqual([[2, 'approved']]);
  });

  test('a token minted for other params is rejected', async () => {
    const { services } = servicesWithAudit();
    const tokenId = await mintToken({
      services,
      tool_name: 'write_file',
      canonical_params: { ...params, content: 'y' },
    });
    const outcome = await dispatchApproved({
      services,
      wireName: 'test_tool',
      wireArgs: params,
      toolInfo: { original_tool_name: 'write_file', tier: 2, tier3_card: TIER2_CARD, approval_token_id: tokenId },
    });
    expect(outcome.disposition).toBe('policy_blocked');
    expect(outcome.reasonCode).toBe('sentinel_verification_failed');
    expect(outcome.executed).toBe(false);
  });

  test('a reused token is rejected', async () => {
    const { services } = servicesWithAudit();
    const tokenId = await mintToken({ services, tool_name: 'write_file', canonical_params: params });
    const toolInfo = {
      original_tool_name: 'write_file',
      tier: 2 as const,
      tier3_card: TIER2_CARD,
      approval_token_id: tokenId,
    };
    const first = await dispatchApproved({ services, wireName: 'test_tool', wireArgs: params, toolInfo });
    const second = await dispatchApproved({ services, wireName: 'test_tool', wireArgs: params, toolInfo });
    expect(first.executed).toBe(true);
    expect(second.disposition).toBe('policy_blocked');
    expect(second.executed).toBe(false);
  });

  test('a denied Tier 2 call does not run and keeps its token unredeemed', async () => {
    const { services, records } = servicesWithAudit();
    const tokenId = await mintToken({ services, tool_name: 'write_file', canonical_params: params });
    const outcome = await dispatchApproved({
      services,
      decision: { status: 'deny', reason: 'no' },
      wireName: 'test_tool',
      wireArgs: params,
      toolInfo: { original_tool_name: 'write_file', tier: 2, tier3_card: TIER2_CARD, approval_token_id: tokenId },
    });
    expect(outcome.disposition).toBe('denied');
    expect(outcome.executed).toBe(false);
    expect(await services.token_store.peek({ ...TEST_TOKEN_SCOPE, token_id: tokenId })).toBeDefined();
    expect(records.map(record => [record.tier, record.outcome])).toEqual([[2, 'denied']]);
  });

  test('a relaxed Tier 2 call runs without a token and audits ran after dispatch', async () => {
    const { services, records } = servicesWithAudit();
    const outcome = await dispatchApproved({
      services,
      decision: null,
      wireName: 'test_tool',
      wireArgs: params,
      toolInfo: {
        original_tool_name: 'write_file',
        tier: 2,
        tier3_card: TIER2_CARD,
        approval_token_id: null,
        is_approval_required: false,
      },
    });
    expect(outcome.executed).toBe(true);
    expect(records.map(record => [record.tier, record.outcome, record.description])).toEqual([
      [2, 'ran', TIER2_CARD.plain_what],
    ]);
  });
});

describe('executeToolCalls sentinel pre-dispatch: silent shell commands', () => {
  const toolInfo = { original_tool_name: 'exec', tier: 1 as const, is_approval_required: false };

  test('a silent shell command that now reaches outside the workspace is blocked', async () => {
    const { services } = servicesWithAudit();
    const workspace = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const outcome = await dispatchApproved({
        services,
        decision: null,
        workspaceCwd: workspace,
        wireName: 'test_tool',
        wireArgs: { command: 'ls', cwd: '/' },
        toolInfo,
      });
      expect(outcome.disposition).toBe('policy_blocked');
      expect(outcome.reasonCode).toBe('sentinel_verification_failed');
      expect(outcome.executed).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('a silent shell command inside the workspace runs without any token', async () => {
    const { services } = servicesWithAudit();
    const workspace = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const outcome = await dispatchApproved({
        services,
        decision: null,
        workspaceCwd: workspace,
        wireName: 'test_tool',
        wireArgs: { command: 'ls', cwd: workspace },
        toolInfo,
      });
      expect(outcome.executed).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('executeToolCalls sentinel pre-dispatch: deferred call_tool', () => {
  test('unwraps the wrapper and verifies the underlying tool identity', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const innerInput = { path: '/etc/hosts' };
    // Mint classified the underlying tool (DeferredTool.toolCallInfo
    // unwraps call_tool), so the token covers the inner input.
    const tokenId = await mintToken({ services, tool_name: 'read_file', canonical_params: innerInput });
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
    const tokenId = await mintToken({ services, tool_name: 'call_tool', canonical_params: wrapperArgs });
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
    const tokenId = await mintToken({ services, tool_name: 'read_file', canonical_params: { path: '/x' } });
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

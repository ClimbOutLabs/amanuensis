import { actionIdFor } from '../../../src/core/permissions/approvalTokens';
import type { ClassifyContext } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';
import { testApprovalOwner } from './approvalTokenFixtures';

/**
 * Spending an approval token on the wrong call must burn it. A dispatch whose arguments do not
 * match the card the person approved fails, and the token is gone afterwards, so the call that
 * does match cannot slip through on the same approval.
 */

function makeCtx(services: SentinelServices): ClassifyContext & { offline: boolean } {
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
    offline: false,
  };
}

interface SpendableCall {
  tool_name: string;
  tool_type: 'truefoundry-system';
  canonical_params: Record<string, unknown>;
  tier: 3;
  approval_token_id: string;
  approval_binding: null;
  shell_binding: null;
}

function callFor(input: { token_id: string; tool_name?: string; params: Record<string, unknown> }): SpendableCall {
  return {
    tool_name: input.tool_name ?? 'exec',
    tool_type: 'truefoundry-system',
    canonical_params: input.params,
    tier: 3,
    approval_token_id: input.token_id,
    approval_binding: null,
    shell_binding: null,
  };
}

describe('a mismatched dispatch spends the approval token and fails closed', () => {
  test('different arguments burn the token, so the approved call fails afterwards too', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const params = { command: 'curl https://example.com' };
    const token = await services.token_store.mint({
      ...testApprovalOwner(),
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: params }),
      canonical_params: params,
    });
    const ctx = makeCtx(services);

    const mismatched = await verifyPreDispatch({
      call: callFor({ token_id: token.token_id, params: { command: 'curl https://example.com/other' } }),
      ctx,
    });
    expect(mismatched).toMatch(/Approval invalid/i);

    const approved = await verifyPreDispatch({ call: callFor({ token_id: token.token_id, params }), ctx });
    expect(approved).toMatch(/already used|invalid/i);
  });

  test('a different tool name burns the token the same way', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const params = { command: 'curl https://example.com' };
    const token = await services.token_store.mint({
      ...testApprovalOwner(),
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: params }),
      canonical_params: params,
    });
    const ctx = makeCtx(services);

    const mismatched = await verifyPreDispatch({
      call: callFor({ token_id: token.token_id, tool_name: 'run_code', params }),
      ctx,
    });
    expect(mismatched).toMatch(/Approval invalid/i);

    const approved = await verifyPreDispatch({ call: callFor({ token_id: token.token_id, params }), ctx });
    expect(approved).toMatch(/already used|invalid/i);
  });
});

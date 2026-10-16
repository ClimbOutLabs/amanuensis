import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { InMemoryApprovalTokenStore } from '../../../src/core/permissions/approvalTokens';
import {
  checkHeldReplay,
  HELD_ACTION_CAP,
  HELD_CHANGED_MESSAGE,
  HELD_EXPIRED_MESSAGE,
  HELD_NOT_ALLOWED_MESSAGE,
  holdApprovalCalls,
} from '../../../src/core/permissions/heldActions';
import type { Tier3Card } from '../../../src/core/permissions/tier';

const SCOPE = { tenant_id: 't1', created_by: 'u1' };

function info(overrides: Partial<InternalToolCallInfo> = {}): InternalToolCallInfo {
  return {
    type: 'mcp',
    mcp_server_id: 'mail',
    mcp_server_name: 'mail',
    original_tool_name: 'send_note',
    is_approval_required: true,
    tier: 3,
    ...overrides,
  };
}

function message(infos: InternalToolCallInfo[]): InternalEnrichedAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: infos.map((tool_info, index) => ({
      id: `call-${String(index)}`,
      type: 'function' as const,
      function: { name: 'send_note', arguments: '{}' },
      tool_info,
    })),
  };
}

function card(overrides: Partial<Tier3Card> = {}): Tier3Card {
  return {
    plain_what: 'Send a note to Ana.',
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: 'mail',
    recipient: 'ana@example.com',
    amount: null,
    parsed_command: null,
    outbound_text: 'to: ana@example.com',
    destination_host: 'mail.example.com',
    outbound_truncated: false,
    ...overrides,
  };
}

describe('holdApprovalCalls', () => {
  it('holds a call that would ask and stops it asking', () => {
    const held = holdApprovalCalls({ message: message([info()]), alreadyHeld: 0, isSubAgent: false });
    const [call] = held.tool_calls ?? [];
    expect(call?.tool_info.is_approval_required).toBe(false);
    expect(Date.parse(call?.tool_info.held_for_owner?.expires_at ?? '')).toBeGreaterThan(Date.now());
  });

  it('leaves calls that do not ask, are client-side, create threads, or were already refused', () => {
    const original = message([
      info({ is_approval_required: false, tier: 1 }),
      info({ is_client_side: true }),
      info({ is_thread_creation: true }),
      info({ is_approval_required: false, pre_dispatch_failure: { kind: 'policy_blocked', message: 'Auto-denied.' } }),
    ]);
    expect(holdApprovalCalls({ message: original, alreadyHeld: 0, isSubAgent: false })).toBe(original);
  });

  it('refuses what it cannot hold past the cap, counting what the chat already holds', () => {
    const asks = Array.from({ length: 3 }, () => info());
    const result = holdApprovalCalls({ message: message(asks), alreadyHeld: HELD_ACTION_CAP - 1, isSubAgent: false });
    const infos = (result.tool_calls ?? []).map(call => call.tool_info);
    expect(infos.filter(candidate => candidate.held_for_owner !== undefined)).toHaveLength(1);
    expect(infos.filter(candidate => candidate.pre_dispatch_failure?.kind === 'policy_blocked')).toHaveLength(2);
    expect(infos[1]?.pre_dispatch_failure?.message).toContain('Too many actions are already waiting');
  });

  it('refuses a helper agent call because the main chat cannot replay it', () => {
    const result = holdApprovalCalls({ message: message([info()]), alreadyHeld: 0, isSubAgent: true });
    const [call] = result.tool_calls ?? [];
    expect(call?.tool_info.held_for_owner).toBeUndefined();
    expect(call?.tool_info.pre_dispatch_failure?.message).toContain('helper agent');
  });
});

describe('checkHeldReplay', () => {
  async function held(options: { expiresAt?: string } = {}) {
    const tokens = new InMemoryApprovalTokenStore();
    const params = { to: 'ana@example.com' };
    const heldToken = await tokens.mint({
      ...SCOPE,
      action_id: 'action-a',
      canonical_params: params,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const freshToken = await tokens.mint({
      ...SCOPE,
      action_id: 'action-a',
      canonical_params: params,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    return {
      tokens,
      heldToken,
      freshToken,
      heldInfo: info({
        approval_token_id: heldToken.token_id,
        tier3_card: card(),
        held_for_owner: { expires_at: options.expiresAt ?? new Date(Date.now() + 60_000).toISOString() },
      }),
    };
  }

  it('lets the fresh call run on the hold-time token', async () => {
    const { tokens, heldToken, freshToken, heldInfo } = await held();
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card({ plain_why: 'Different reason' }) });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: true,
      approval_token_id: heldToken.token_id,
    });
  });

  it('refuses after the hold ran out', async () => {
    const { tokens, freshToken, heldInfo } = await held({ expiresAt: new Date(Date.now() - 1).toISOString() });
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card() });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      message: HELD_EXPIRED_MESSAGE,
    });
  });

  it('refuses once the hold-time token was used', async () => {
    const { tokens, heldToken, freshToken, heldInfo } = await held();
    await tokens.redeem({ ...SCOPE, token_id: heldToken.token_id });
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card() });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      message: HELD_EXPIRED_MESSAGE,
    });
  });

  it('refuses when a rule now auto-denies the call', async () => {
    const { tokens, heldInfo } = await held();
    const fresh = info({
      is_approval_required: false,
      pre_dispatch_failure: { kind: 'policy_blocked', message: 'Auto-denied: offline mode is on.' },
    });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      message: HELD_NOT_ALLOWED_MESSAGE,
    });
  });

  it('refuses when the action id differs', async () => {
    const { tokens, heldInfo } = await held();
    const other = await tokens.mint({
      ...SCOPE,
      action_id: 'action-b',
      canonical_params: {},
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const fresh = info({ approval_token_id: other.token_id, tier3_card: card() });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      message: HELD_CHANGED_MESSAGE,
    });
  });

  it.each([
    { field: 'recipient', value: 'bob@example.com' },
    { field: 'destination', value: 'other-service' },
    { field: 'outbound_text', value: 'to: bob@example.com' },
    { field: 'parsed_command', value: 'rm -rf /' },
  ] as const)('refuses when the $field differs', async ({ field, value }) => {
    const { tokens, freshToken, heldInfo } = await held();
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card({ [field]: value }) });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      message: HELD_CHANGED_MESSAGE,
    });
  });

  it('runs a call that no longer asks without a token', async () => {
    const { tokens, heldInfo } = await held();
    const fresh = info({ is_approval_required: false, tier: 1, approval_token_id: null, tier3_card: null });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: true,
      approval_token_id: null,
    });
  });
});

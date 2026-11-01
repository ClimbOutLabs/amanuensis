import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { InMemoryApprovalTokenStore } from '../../../src/core/permissions/approvalTokens';
import { checkHeldReplay, HELD_ACTION_CAP, holdApprovalCalls } from '../../../src/core/permissions/heldActions';
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
      function: { name: 'send_note', arguments: JSON.stringify({ tool: tool_info.original_tool_name }) },
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
    const { message: held, refused } = holdApprovalCalls({
      message: message([info()]),
      alreadyHeld: 0,
      isSubAgent: false,
    });
    const [call] = held.tool_calls ?? [];
    expect(call?.tool_info.is_approval_required).toBe(false);
    expect(Date.parse(call?.tool_info.held_for_owner?.expires_at ?? '')).toBeGreaterThan(Date.now());
    expect(refused).toEqual([]);
  });

  it('leaves calls that do not ask, are client-side, create threads, or were already refused', () => {
    const original = message([
      info({ is_approval_required: false, tier: 1 }),
      info({ is_client_side: true }),
      info({ is_thread_creation: true }),
      info({ is_approval_required: false, pre_dispatch_failure: { kind: 'policy_blocked', message: 'Auto-denied.' } }),
    ]);
    expect(holdApprovalCalls({ message: original, alreadyHeld: 0, isSubAgent: false }).message).toBe(original);
  });

  it('refuses what it cannot hold past the cap, counting what the chat already holds, and says so', () => {
    const asks = Array.from({ length: 3 }, (_, index) => info({ original_tool_name: `tool_${String(index)}` }));
    const calls = message(asks);
    const result = holdApprovalCalls({ message: calls, alreadyHeld: HELD_ACTION_CAP - 1, isSubAgent: false });
    const infos = (result.message.tool_calls ?? []).map(call => call.tool_info);
    expect(infos.filter(candidate => candidate.held_for_owner !== undefined)).toHaveLength(1);
    expect(infos.filter(candidate => candidate.pre_dispatch_failure?.kind === 'policy_blocked')).toHaveLength(2);
    expect(infos[1]?.pre_dispatch_failure?.message).toContain('Too many actions are already waiting');
    expect(infos[1]?.pre_dispatch_failure?.owner_message).toBe(infos[1]?.pre_dispatch_failure?.message);
    expect(result.refused.map(entry => entry.reason)).toEqual(['too_many', 'too_many']);
  });

  it('refuses a helper agent call because the main chat cannot replay it', () => {
    const result = holdApprovalCalls({ message: message([info()]), alreadyHeld: 0, isSubAgent: true });
    const [call] = result.message.tool_calls ?? [];
    expect(call?.tool_info.held_for_owner).toBeUndefined();
    expect(call?.tool_info.pre_dispatch_failure?.message).toContain('helper agent');
    expect(result.refused).toEqual([{ id: 'call-0', reason: 'helper_agent' }]);
  });

  it('holds one of two identical calls in a batch and marks the repeat, which uses no room under the cap', () => {
    const result = holdApprovalCalls({
      message: message([info(), info()]),
      alreadyHeld: HELD_ACTION_CAP - 1,
      isSubAgent: false,
    });
    const [first, second] = (result.message.tool_calls ?? []).map(call => call.tool_info);
    expect(first?.held_for_owner?.duplicate).toBeUndefined();
    expect(second?.held_for_owner?.duplicate).toBe(true);
    expect(second?.pre_dispatch_failure).toBeUndefined();
    expect(result.refused).toEqual([]);
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

  describe('git remotes seen when the call was held', () => {
    const remotes = (url: string) => ({
      remotes: [{ name: 'origin', url }],
      summary: `origin is ${url}`,
    });
    const shown = remotes('https://github.com/o/r.git');

    it('lets the replay run when the remotes are unchanged', async () => {
      const { tokens, heldToken, freshToken, heldInfo } = await held();
      const fresh = info({
        approval_token_id: freshToken.token_id,
        tier3_card: card(),
        git_remote_precondition: shown,
      });
      await expect(
        checkHeldReplay({
          held: { ...heldInfo, git_remote_precondition: shown },
          fresh,
          tokens,
          scope: SCOPE,
        }),
      ).resolves.toEqual({ ok: true, approval_token_id: heldToken.token_id });
    });

    it.each([
      ['repointed', remotes('https://github.com/attacker/x.git')],
      ['no longer observed', undefined],
    ])('refuses the replay when the remote is %s', async (_name, now) => {
      const { tokens, freshToken, heldInfo } = await held();
      const fresh = info({
        approval_token_id: freshToken.token_id,
        tier3_card: card(),
        ...(now === undefined ? {} : { git_remote_precondition: now }),
      });
      await expect(
        checkHeldReplay({ held: { ...heldInfo, git_remote_precondition: shown }, fresh, tokens, scope: SCOPE }),
      ).resolves.toEqual({ ok: false, reason: 'changed' });
    });

    it('refuses a replay that now has a remote the owner was never shown', async () => {
      const { tokens, freshToken, heldInfo } = await held();
      const fresh = info({
        approval_token_id: freshToken.token_id,
        tier3_card: card(),
        git_remote_precondition: shown,
      });
      await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
        ok: false,
        reason: 'changed',
      });
    });
  });

  it('refuses after the hold ran out', async () => {
    const { tokens, freshToken, heldInfo } = await held({ expiresAt: new Date(Date.now() - 1).toISOString() });
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card() });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses once the hold-time token was used', async () => {
    const { tokens, heldToken, freshToken, heldInfo } = await held();
    await tokens.redeem({ ...SCOPE, token_id: heldToken.token_id });
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card() });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      reason: 'expired',
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
      reason: 'not_allowed',
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
      reason: 'changed',
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
      reason: 'changed',
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

import type { InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { InMemoryApprovalTokenStore } from '../../../src/core/permissions/approvalTokens';
import { checkHeldReplay } from '../../../src/core/permissions/heldActions';
import { buildSkillNetworkCard, skillNetworkAnswerFor } from '../../../src/core/permissions/skillNetworkCards';
import type { Tier3Card } from '../../../src/core/permissions/tier';

const SCOPE = { tenant_id: 't1', created_by: 'u1' };

describe('buildSkillNetworkCard', () => {
  it('asks for the whole declared list on first use, in plain words', () => {
    const card = buildSkillNetworkCard({
      skill_name: 'ten-x',
      hosts: ['github.com', 'api.github.com'],
      reason: 'first_use',
    });
    expect(card.plain_what).toBe('Let the ten-x skill reach github.com, api.github.com?');
    expect(card.plain_why).toContain('names these sites as the ones it needs');
    expect(card.destination).toBe('github.com, api.github.com');
    expect(card.destination_host).toBeNull();
    expect(card.skill_network).toEqual({
      skill_name: 'ten-x',
      hosts: ['github.com', 'api.github.com'],
      reason: 'first_use',
      code_pin: null,
    });
  });

  it('names the one refused site, says it was refused, and blames no skill for the attempt', () => {
    const card = buildSkillNetworkCard({
      skill_name: 'ten-x',
      hosts: ['uploads.example.com'],
      reason: 'undeclared_host',
    });
    // A refused connection cannot show which skill, if any, reached for the site, so the card
    // asks about the site and says so. The skill stays in the payload, which is where the
    // answer is filed, and nowhere in the words the person reads.
    expect(card.plain_what).toBe('Allow a connection to uploads.example.com in this chat?');
    expect(card.plain_why).toContain('refused');
    expect(card.plain_why).toContain('cannot tell which skill, if any, made the attempt');
    expect(card.plain_why).not.toContain('The skill tried');
    expect(card.destination_host).toBe('uploads.example.com');
    expect(card.skill_network).toEqual({
      skill_name: 'ten-x',
      hosts: ['uploads.example.com'],
      reason: 'undeclared_host',
      code_pin: null,
    });
  });

  it('shows an international name decoded on the card and keeps the coded form in the question', () => {
    const card = buildSkillNetworkCard({
      skill_name: 'ten-x',
      hosts: ['xn--mnchen-3ya.de'],
      reason: 'first_use',
    });
    expect(card.plain_what).toBe('Let the ten-x skill reach münchen.de?');
    expect(card.destination).toBe('münchen.de');
    expect(card.destination_host).toBe('münchen.de');
    expect(card.skill_network).toEqual({
      skill_name: 'ten-x',
      hosts: ['xn--mnchen-3ya.de'],
      reason: 'first_use',
      code_pin: null,
    });
  });
});

describe('skillNetworkAnswerFor', () => {
  it('maps the three card answers from an approval decision', () => {
    expect(skillNetworkAnswerFor({ status: 'deny', scope: undefined })).toBe('deny');
    expect(skillNetworkAnswerFor({ status: 'deny', scope: 'always' })).toBe('deny');
    expect(skillNetworkAnswerFor({ status: 'allow', scope: 'always' })).toBe('always_allow');
    expect(skillNetworkAnswerFor({ status: 'allow', scope: 'once' })).toBe('allow_once');
    expect(skillNetworkAnswerFor({ status: 'allow', scope: 'chat' })).toBe('allow_once');
    expect(skillNetworkAnswerFor({ status: 'allow', scope: undefined })).toBe('allow_once');
  });
});

describe('checkHeldReplay for a skill network card', () => {
  function info(overrides: Partial<InternalToolCallInfo> = {}): InternalToolCallInfo {
    return {
      type: 'mcp',
      mcp_server_id: 'sandbox',
      mcp_server_name: 'sandbox',
      original_tool_name: 'exec',
      is_approval_required: true,
      tier: 3,
      ...overrides,
    };
  }

  function card(overrides: Partial<Tier3Card> = {}): Tier3Card {
    return {
      plain_what: 'Run a command.',
      copy: null,
      plain_why: null,
      cannot_be_undone: null,
      why_asked_again: null,
      destination: 'workspace',
      recipient: null,
      amount: null,
      parsed_command: 'curl https://uploads.example.com',
      outbound_text: null,
      destination_host: null,
      outbound_truncated: false,
      ...overrides,
    };
  }

  async function heldCall(overrides: Partial<InternalToolCallInfo>) {
    const tokens = new InMemoryApprovalTokenStore();
    const params = { command: 'curl https://uploads.example.com' };
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
        held_for_owner: { expires_at: new Date(Date.now() + 60_000).toISOString() },
        ...overrides,
      }),
    };
  }

  it('replays a network card even when the command classifies to a different card', async () => {
    const { tokens, heldToken, freshToken, heldInfo } = await heldCall({
      skill_network: {
        skill_name: 'ten-x',
        hosts: ['uploads.example.com'],
        reason: 'undeclared_host',
        code_pin: null,
      },
      tier3_card: buildSkillNetworkCard({
        skill_name: 'ten-x',
        hosts: ['uploads.example.com'],
        reason: 'undeclared_host',
      }),
    });
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card() });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: true,
      approval_token_id: heldToken.token_id,
    });
  });

  it('still refuses an ordinary held call whose card targets changed', async () => {
    const { tokens, freshToken, heldInfo } = await heldCall({});
    const fresh = info({
      approval_token_id: freshToken.token_id,
      tier3_card: card({ destination: 'somewhere-else' }),
    });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      reason: 'changed',
    });
  });

  /** A network card as production holds it: no approval token of its own, only the question. */
  function networkHeld(): InternalToolCallInfo {
    return info({
      approval_token_id: null,
      is_approval_required: false,
      tier3_card: buildSkillNetworkCard({
        skill_name: 'ten-x',
        hosts: ['uploads.example.com'],
        reason: 'undeclared_host',
      }),
      skill_network: {
        skill_name: 'ten-x',
        hosts: ['uploads.example.com'],
        reason: 'undeclared_host',
        code_pin: null,
      },
      held_for_owner: { expires_at: new Date(Date.now() + 60_000).toISOString() },
    });
  }

  it('refuses the re-run when the command asks for an approval of its own the card never showed', async () => {
    const tokens = new InMemoryApprovalTokenStore();
    const freshToken = await tokens.mint({
      ...SCOPE,
      action_id: 'action-a',
      canonical_params: { command: 'curl https://uploads.example.com' },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card() });
    await expect(checkHeldReplay({ held: networkHeld(), fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      reason: 'changed',
    });
  });

  it('still re-runs the command when it does not ask on its own, as a standing grant leaves it', async () => {
    const tokens = new InMemoryApprovalTokenStore();
    const fresh = info({ is_approval_required: false, tier3_card: undefined });
    await expect(checkHeldReplay({ held: networkHeld(), fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: true,
      approval_token_id: null,
    });
  });
});

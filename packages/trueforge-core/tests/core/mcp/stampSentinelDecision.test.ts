import { stampSentinelDecision } from '../../../src/core/mcp/ToolSet';
import { autoDenyDecision, tier1Decision, tier2Decision, tier3Decision } from '../../../src/core/permissions/tier';

const card = {
  plain_what: 'Change `notes.md` in your workspace.',
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

const tier2Base = {
  kind: 'file_write' as const,
  card,
  reason: 'sandbox_write',
  reason_detail: null,
  sensitive_read: false,
};

describe('stampSentinelDecision approval gate', () => {
  test('a Tier 2 decision with a token requires approval', () => {
    const stamp = stampSentinelDecision({ decision: tier2Decision({ ...tier2Base, approval_token_id: 'tok' }) });
    expect(stamp.is_approval_required).toBe(true);
    expect(stamp.approval_token_id).toBe('tok');
    expect(stamp.tier3_card).toEqual(card);
  });

  test('a relaxed Tier 2 decision runs without approval', () => {
    expect(stampSentinelDecision({ decision: tier2Decision(tier2Base) }).is_approval_required).toBe(false);
  });

  test('Tier 3 requires approval unless auto-denied, and Tier 1 never does', () => {
    const tier3 = tier3Decision({ card, reason: 'r', reason_detail: null, sensitive_read: false });
    expect(stampSentinelDecision({ decision: tier3 }).is_approval_required).toBe(true);
    const denied = autoDenyDecision({ reason: 'offline_mode', reason_detail: null, sensitive_read: false });
    expect(stampSentinelDecision({ decision: denied }).is_approval_required).toBe(false);
    const tier1 = tier1Decision({ reason: 'r', reason_detail: null, sensitive_read: false });
    expect(stampSentinelDecision({ decision: tier1 }).is_approval_required).toBe(false);
  });
});

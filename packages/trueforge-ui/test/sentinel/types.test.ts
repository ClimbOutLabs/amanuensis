// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  extractSentinelFromEvent,
  extractSentinelSessionContext,
  parseAuditEntries,
  parseTier2ActionKind,
  parseToolTier,
  parseUserSettings,
} from '@/sentinel/types.js';

describe('parseToolTier', () => {
  it('accepts the three explicit numeric tiers and nothing else', () => {
    expect(parseToolTier(1)).toBe(1);
    expect(parseToolTier(2)).toBe(2);
    expect(parseToolTier(3)).toBe(3);
    expect(parseToolTier('tier3')).toBeUndefined();
    expect(parseToolTier('3')).toBeUndefined();
    expect(parseToolTier(0)).toBeUndefined();
    expect(parseToolTier(undefined)).toBeUndefined();
  });
});

describe('parseTier2ActionKind', () => {
  it('accepts the four backend kinds and nothing else', () => {
    expect(parseTier2ActionKind('file_write')).toBe('file_write');
    expect(parseTier2ActionKind('shell')).toBe('shell');
    expect(parseTier2ActionKind('runner')).toBe('runner');
    expect(parseTier2ActionKind('branch')).toBe('branch');
    expect(parseTier2ActionKind('file.write')).toBeUndefined();
    expect(parseTier2ActionKind(undefined)).toBeUndefined();
  });
});

describe('extractSentinelFromEvent', () => {
  const approvalEvent = {
    type: 'tool.approval_required',
    tool_calls: [
      {
        tool_call_id: 'call-1',
        tier: 3,
        tier3_card: {
          plain_what: 'Send $250 to Acme Corp',
          plain_why: 'You asked the assistant to pay the invoice.',
          cannot_be_undone: 'The transfer cannot be reversed.',
          destination: 'acme-corp',
          recipient: 'Acme Corp',
          amount: '$250',
        },
      },
      {
        tool_call_id: 'call-2',
        tier: 1,
        tier3_card: { plain_what: 'Read file', plain_why: 'Needed for context.' },
      },
    ],
  };

  it('parses per-tool-call approval cards with the backend field names', () => {
    const { approvals, notices } = extractSentinelFromEvent(approvalEvent);
    expect(notices).toEqual([]);
    expect(approvals).toHaveLength(2);
    const first = approvals[0];
    expect(first?.toolCallId).toBe('call-1');
    expect(first?.tier).toBe(3);
    expect(first?.card.plain_what).toBe('Send $250 to Acme Corp');
    expect(first?.card.plain_why).toBe('You asked the assistant to pay the invoice.');
    expect(first?.card.cannot_be_undone).toBe('The transfer cannot be reversed.');
    expect(first?.card.destination).toBe('acme-corp');
    expect(first?.card.recipient).toBe('Acme Corp');
    expect(first?.card.amount).toBe('$250');
    expect(first?.card.why_asked_again).toBeNull();
    expect(first?.card.parsed_command).toBeNull();
  });

  it('accepts the provisional `card` field name', () => {
    const { approvals } = extractSentinelFromEvent({
      type: 'tool.approval_required',
      tool_calls: [
        {
          tool_call_id: 'call-9',
          tier: 3,
          card: {
            plain_what: 'Delete the draft',
            plain_why: 'You asked the assistant to clean up.',
            why_asked_again: 'the previous approval expired',
          },
        },
      ],
    });
    expect(approvals[0]?.card.why_asked_again).toBe('the previous approval expired');
  });

  it('parses a Tier 2 notice with kind, undo/stop flags, and tier2 files', () => {
    const { approvals, notices } = extractSentinelFromEvent({
      type: 'tool.tier2_notice',
      tool_calls: [
        {
          tool_call_id: 'call-3',
          tier: 2,
          tier2_kind: 'shell',
          message: 'Ran the test suite',
          undoable: true,
          stoppable: false,
          tier2_files: ['src/a.ts', 'src/b.ts'],
          notice_id: 'notice-3',
        },
      ],
    });
    expect(approvals).toEqual([]);
    expect(notices).toHaveLength(1);
    const notice = notices[0];
    expect(notice?.toolCallId).toBe('call-3');
    expect(notice?.kind).toBe('shell');
    expect(notice?.message).toBe('Ran the test suite');
    expect(notice?.undoable).toBe(true);
    expect(notice?.stoppable).toBe(false);
    expect(notice?.tracked_files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(notice?.notice_id).toBe('notice-3');
  });

  it('falls back to the tool call id when the notice has no notice_id', () => {
    const { notices } = extractSentinelFromEvent({
      type: 'tool.tier2_notice',
      tool_call_id: 'call-4',
      tier: 2,
      message: 'Ran the test suite',
      undoable: false,
      stoppable: true,
    });
    expect(notices[0]?.notice_id).toBe('call-4');
    expect(notices[0]?.kind).toBeNull();
  });

  it('parses the SDK-parsed camelCase toolCalls shape from the live tap', () => {
    // The tap in chatServer.ts receives events after the SDK serializer has
    // converted tool_calls to toolCalls; unknown ref fields (tier, tier3_card)
    // pass through untouched.
    const { approvals } = extractSentinelFromEvent({
      type: 'tool.approval_required',
      id: 'evt-1',
      createdAt: '2026-10-08T00:00:00.000Z',
      threadId: 'thread-1',
      toolCalls: [
        {
          id: 'call-10',
          sourceEventId: 'msg-1',
          tier: 3,
          tier3_card: {
            plain_what: 'Run `echo hello-sentinel`.',
            plain_why: null,
            cannot_be_undone: null,
            why_asked_again: null,
            destination: null,
            recipient: null,
            amount: null,
            parsed_command: 'echo hello-sentinel',
          },
        },
      ],
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.toolCallId).toBe('call-10');
    expect(approvals[0]?.tier).toBe(3);
    expect(approvals[0]?.card.parsed_command).toBe('echo hello-sentinel');
  });

  it('reads per-action fields at the event top level for single-action events', () => {
    const { approvals } = extractSentinelFromEvent({
      type: 'tool.approval_required',
      tool_call_id: 'call-5',
      tier: 3,
      tier3_card: { plain_what: 'Publish the release', plain_why: 'You asked for a release.' },
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.toolCallId).toBe('call-5');
  });

  it('ignores events without Sentinel data and drops malformed refs', () => {
    expect(extractSentinelFromEvent({ type: 'model.message' })).toEqual({ approvals: [], notices: [] });
    expect(extractSentinelFromEvent(null)).toEqual({ approvals: [], notices: [] });
    expect(extractSentinelFromEvent('nope')).toEqual({ approvals: [], notices: [] });
    // Tier without a card is not an approval card; a card without plain_what is dropped.
    const { approvals } = extractSentinelFromEvent({
      type: 'tool.approval_required',
      tool_calls: [
        { tool_call_id: 'call-6', tier: 3 },
        { tool_call_id: 'call-7', tier: 3, tier3_card: { plain_why: 'Missing what.' } },
        { tool_call_id: 'call-8', tier3_card: { plain_what: 'x', plain_why: 'y' } },
      ],
    });
    expect(approvals).toEqual([]);
  });
});

describe('extractSentinelSessionContext', () => {
  it('folds events to one record per tool call, later events winning', () => {
    const context = extractSentinelSessionContext([
      {
        type: 'tool.tier2_notice',
        tool_call_id: 'call-1',
        tier: 2,
        message: 'First',
        undoable: false,
        stoppable: false,
      },
      {
        type: 'tool.tier2_notice',
        tool_call_id: 'call-1',
        tier: 2,
        message: 'Second',
        undoable: true,
        stoppable: false,
      },
    ]);
    expect(context.notices).toHaveLength(1);
    expect(context.notices[0]?.message).toBe('Second');
    expect(context.notices[0]?.undoable).toBe(true);
    expect(context.approvals).toEqual([]);
  });
});

describe('parseAuditEntries', () => {
  const entry = {
    id: 'entry-1',
    conversation_id: 'session-1',
    created_at: '2026-09-29T10:00:00.000Z',
    tier: 3,
    tool_name: 'payment_send',
    description: 'Sent $250 to Acme Corp',
    outcome: 'approved',
  };

  it('parses the { entries: [...] } envelope and keeps the auto-deny reason', () => {
    const denied = {
      ...entry,
      id: 'entry-2',
      outcome: 'auto_denied',
      auto_deny_reason: 'destination_unverifiable',
    };
    const parsed = parseAuditEntries({ entries: [entry, denied] });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.session_id).toBe('session-1');
    expect(parsed[0]?.action_type).toBe('payment_send');
    expect(parsed[0]?.description).toBe('Sent $250 to Acme Corp');
    expect(parsed[0]?.reason).toBeUndefined();
    expect(parsed[1]?.outcome).toBe('auto_denied');
    expect(parsed[1]?.reason).toBe('destination_unverifiable');
  });

  it('accepts the provisional field names', () => {
    const parsed = parseAuditEntries([
      {
        id: 'entry-9',
        session_id: 'session-9',
        created_at: '2026-09-29T10:00:00.000Z',
        tier: 2,
        action_type: 'exec',
        description: 'Ran tests',
        outcome: 'ran',
        reason: 'old reason',
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.session_id).toBe('session-9');
    expect(parsed[0]?.action_type).toBe('exec');
    expect(parsed[0]?.reason).toBe('old reason');
  });

  it('also accepts a bare array and drops malformed entries', () => {
    const parsed = parseAuditEntries([entry, { id: 'bad' }, null]);
    expect(parsed).toHaveLength(1);
    expect(parseAuditEntries({ entries: 'nope' })).toEqual([]);
    expect(parseAuditEntries(null)).toEqual([]);
  });

  it('covers every audit outcome', () => {
    const outcomes = ['logged', 'ran', 'stopped_by_user', 'undone', 'approved', 'denied', 'auto_denied'];
    for (const outcome of outcomes) {
      const parsed = parseAuditEntries([{ ...entry, id: outcome, outcome }]);
      expect(parsed[0]?.outcome).toBe(outcome);
    }
    expect(parseAuditEntries([{ ...entry, outcome: 'maybe' }])).toEqual([]);
  });
});

describe('parseUserSettings', () => {
  it('defaults to offline off and no escalated kinds', () => {
    expect(parseUserSettings(null)).toEqual({ offline_mode: false, tier2_always_ask: [] });
    expect(parseUserSettings({})).toEqual({ offline_mode: false, tier2_always_ask: [] });
    expect(parseUserSettings({ offline_mode: 'yes', tier2_always_ask: ['file.write', 42] })).toEqual({
      offline_mode: false,
      tier2_always_ask: [],
    });
  });

  it('keeps explicit values and drops unknown kinds', () => {
    expect(
      parseUserSettings({ offline_mode: true, tier2_always_ask: ['shell', 'file_write', 'nope'] }),
    ).toEqual({ offline_mode: true, tier2_always_ask: ['shell', 'file_write'] });
  });
});

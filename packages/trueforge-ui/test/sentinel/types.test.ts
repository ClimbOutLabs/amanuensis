// @vitest-environment jsdom
import { changeRequestReason } from '@truefoundry/trueforge-core/core/permissions/changeRequest';
import { ToolApprovalRequiredEvent } from '@truefoundry/trueforge-sdk/serialization';
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
  it('accepts the backend kinds and nothing else', () => {
    expect(parseTier2ActionKind('file_write')).toBe('file_write');
    expect(parseTier2ActionKind('shell')).toBeUndefined();
    expect(parseTier2ActionKind('runner')).toBeUndefined();
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
    const approvals = extractSentinelFromEvent(approvalEvent);
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
    expect(first?.card.outbound_text).toBeNull();
    expect(first?.card.destination_host).toBeNull();
  });

  describe('held search cards saved before the hold reason had its own place', () => {
    const legacy = (card: Record<string, unknown>) =>
      extractSentinelFromEvent({
        type: 'tool.approval_required',
        tool_calls: [{ tool_call_id: 'call-7', tier: 3, tier3_card: { plain_what: 'x', ...card } }],
      })[0]?.card;

    it('does not show a saved key, and says what was caught', () => {
      const card = legacy({
        plain_what: 'Search the web through finder for: debug synthetic-key-000111',
        outbound_text: 'query: debug synthetic-key-000111',
        why_asked_again: 'Held for approval: it contains a secret this server holds.',
      });
      expect(card?.plain_what).toBe(
        'Search the web through finder. This search contains something that looks like a password or key.',
      );
      expect(card?.outbound_text).toBeNull();
      expect(card?.why_asked_again).toBeNull();
    });

    it('moves another hold reason out of "seen before" and keeps the query', () => {
      const card = legacy({
        plain_what: 'Search the web through finder for: oslo weather',
        outbound_text: 'query: oslo weather',
        why_asked_again: 'Held for approval: this turn already ran 8 searches without asking.',
      });
      // A card saved before the wording changed gets the plain reason after its sentence.
      expect(card?.plain_what).toBe(
        'Search the web through finder for: oslo weather. Aman is checking with you before searching.',
      );
      expect(card?.outbound_text).toBe('query: oslo weather');
      expect(card?.why_asked_again).toBeNull();
    });

    it('leaves a real "seen before" reason alone', () => {
      expect(legacy({ why_asked_again: 'the earlier approval expired' })?.why_asked_again).toBe(
        'the earlier approval expired',
      );
    });
  });

  it('parses outbound_text and destination_host from the card', () => {
    const event = {
      type: 'tool.approval_required',
      tool_calls: [
        {
          tool_call_id: 'call-9',
          tier: 3,
          tier3_card: {
            plain_what: 'Run web_search',
            outbound_text: 'query: my secret query',
            destination_host: 'mcp.exa.ai',
          },
        },
      ],
    };
    const approvals = extractSentinelFromEvent(event);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.card.outbound_text).toBe('query: my secret query');
    expect(approvals[0]?.card.destination_host).toBe('mcp.exa.ai');
  });

  it('reads outboundText and destinationHost from a camel-cased card', () => {
    const approvals = extractSentinelFromEvent({
      type: 'tool.approval_required',
      toolCalls: [
        {
          id: 'call-11',
          tier: 3,
          tier3Card: {
            plainWhat: 'Search the web',
            outboundText: 'query: tides',
            destinationHost: 'mcp.exa.ai',
            outboundTruncated: true,
          },
        },
      ],
    });
    expect(approvals[0]?.card.outbound_text).toBe('query: tides');
    expect(approvals[0]?.card.destination_host).toBe('mcp.exa.ai');
    expect(approvals[0]?.card.outbound_truncated).toBe(true);
  });

  it('parses an approval event after the SDK deserializes it', () => {
    // Live and reloaded events reach the UI through the SDK, which camel-cases known keys.
    const parsed = ToolApprovalRequiredEvent.parseOrThrow(
      {
        type: 'tool.approval_required',
        id: 'evt-1',
        created_at: '2026-01-01T00:00:00.000Z',
        thread_id: 'main',
        tool_calls: [
          {
            id: 'call-9',
            source_event_id: 'evt-0',
            tier: 3,
            tier3_card: {
              plain_what: 'Run code in the sandbox',
              plain_why: null,
              cannot_be_undone: 'Runs once.',
              destination: null,
              recipient: null,
              amount: null,
              parsed_command: null,
              why_asked_again: null,
              outbound_text: 'query: tides',
              destination_host: 'mcp.exa.ai',
              outbound_truncated: true,
            },
          },
        ],
      },
      { unrecognizedObjectKeys: 'passthrough', allowUnrecognizedUnionMembers: true, allowUnrecognizedEnumValues: true },
    );
    const approvals = extractSentinelFromEvent(parsed);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.toolCallId).toBe('call-9');
    expect(approvals[0]?.tier).toBe(3);
    expect(approvals[0]?.card.plain_what).toBe('Run code in the sandbox');
    expect(approvals[0]?.card.cannot_be_undone).toBe('Runs once.');
    expect(approvals[0]?.card.outbound_text).toBe('query: tides');
    expect(approvals[0]?.card.destination_host).toBe('mcp.exa.ai');
    expect(approvals[0]?.card.outbound_truncated).toBe(true);
  });

  it('reads the whole message of a mail card after the SDK deserializes it', () => {
    const parsed = ToolApprovalRequiredEvent.parseOrThrow(
      {
        type: 'tool.approval_required',
        id: 'evt-2',
        created_at: '2026-01-01T00:00:00.000Z',
        thread_id: 'main',
        tool_calls: [
          {
            id: 'call-12',
            source_event_id: 'evt-0',
            tier: 3,
            tier3_card: {
              plain_what: 'Change a saved draft in your Gmail.',
              plain_why: null,
              cannot_be_undone: null,
              destination: null,
              recipient: null,
              amount: null,
              parsed_command: null,
              why_asked_again: null,
              outbound_text: null,
              destination_host: null,
              outbound_truncated: false,
              email: {
                action: 'change',
                to: [{ name: 'Grace Lee', address: 'grace@example.com' }],
                cc: [],
                bcc: [{ name: '', address: 'audit@example.com' }],
                subject: 'Lease',
                body: 'Thursday works.\n\nAda',
                replaces: { subject: 'Old lease', to: [{ name: 'Sam Lee', address: 'sam@example.com' }] },
                reply_in_thread: { subject: 'Lease renewal', from: 'Grace <grace@example.com>' },
              },
            },
          },
        ],
      },
      { unrecognizedObjectKeys: 'passthrough', allowUnrecognizedUnionMembers: true, allowUnrecognizedEnumValues: true },
    );
    expect(extractSentinelFromEvent(parsed)[0]?.card.email).toEqual({
      action: 'change',
      to: [{ name: 'Grace Lee', address: 'grace@example.com' }],
      cc: [],
      bcc: [{ name: '', address: 'audit@example.com' }],
      subject: 'Lease',
      body: 'Thursday works.\n\nAda',
      replaces: { subject: 'Old lease', to: [{ name: 'Sam Lee', address: 'sam@example.com' }] },
      reply_in_thread: { subject: 'Lease renewal', from: 'Grace <grace@example.com>' },
    });
  });

  it('has no email on a card that carries none, or one it cannot read', () => {
    const card = (email: unknown) =>
      extractSentinelFromEvent({
        type: 'tool.approval_required',
        tool_calls: [{ id: 'call-13', tier: 3, tier3_card: { plain_what: 'Do it', email } }],
      })[0]?.card.email;
    expect(card(undefined)).toBeNull();
    expect(card(null)).toBeNull();
    expect(card({ action: 'forward', to: [], cc: [], bcc: [], subject: 's', body: 'b', replaces: null })).toBeNull();
    expect(card({ action: 'send', to: 'grace@example.com', cc: [], bcc: [], subject: 's', body: 'b' })).toBeNull();
    // A card stored before names were kept holds bare address strings; each is read as a recipient with no name.
    expect(card({ action: 'send', to: ['grace@example.com'], cc: [], bcc: [], subject: 's', body: 'b' })).toEqual({
      action: 'send',
      to: [{ name: '', address: 'grace@example.com' }],
      cc: [],
      bcc: [],
      subject: 's',
      body: 'b',
      replaces: null,
      reply_in_thread: null,
    });
  });

  const CALENDAR_EVENT = {
    action: 'change',
    calendar: 'ada@example.com',
    title: 'Team sync',
    when: 'Tuesday, October 20, 2026, 2:00 pm to 2:30 pm',
    time_zone: 'America/New_York',
    duration: '30 minutes',
    location: 'Room 4',
    description: '',
    attendees: ['lin@example.com'],
    guests_emailed: true,
    one_of_repeating: false,
    before: {
      title: 'Team sync',
      when: 'Monday, October 19, 2026, 8:00 am to 8:30 am',
      duration: '30 minutes',
      location: 'Room 4',
    },
  };

  it('reads the whole event of a calendar card after the SDK deserializes it', () => {
    const parsed = ToolApprovalRequiredEvent.parseOrThrow(
      {
        type: 'tool.approval_required',
        id: 'evt-3',
        created_at: '2026-01-01T00:00:00.000Z',
        thread_id: 'main',
        tool_calls: [
          {
            id: 'call-14',
            source_event_id: 'evt-0',
            tier: 3,
            tier3_card: {
              plain_what: 'Change "Team sync" in your Google Calendar.',
              plain_why: null,
              cannot_be_undone: null,
              destination: null,
              recipient: null,
              amount: null,
              parsed_command: null,
              why_asked_again: null,
              outbound_text: null,
              destination_host: null,
              outbound_truncated: false,
              calendar_event: CALENDAR_EVENT,
            },
          },
        ],
      },
      { unrecognizedObjectKeys: 'passthrough', allowUnrecognizedUnionMembers: true, allowUnrecognizedEnumValues: true },
    );
    expect(extractSentinelFromEvent(parsed)[0]?.card.calendar_event).toEqual(CALENDAR_EVENT);
  });

  it('shows no event for a calendar card missing a field, so a partial event is never approved', () => {
    const event = (calendar_event: unknown) =>
      extractSentinelFromEvent({
        type: 'tool.approval_required',
        tool_calls: [{ id: 'call-15', tier: 3, tier3_card: { plain_what: 'Do it', calendar_event } }],
      })[0]?.card.calendar_event;
    expect(event(undefined)).toBeNull();
    expect(event({ ...CALENDAR_EVENT, attendees: undefined })).toBeNull();
    expect(event({ ...CALENDAR_EVENT, guests_emailed: 'yes' })).toBeNull();
    expect(event({ ...CALENDAR_EVENT, action: 'delete' })).toBeNull();
  });

  it('reads a camel-cased card from a regenerated SDK shape', () => {
    const approvals = extractSentinelFromEvent({
      type: 'tool.approval_required',
      toolCalls: [
        {
          id: 'call-10',
          tier: 3,
          tier3Card: {
            plainWhat: 'Run code in the sandbox',
            plainWhy: 'Asked to compute a total.',
            parsedCommand: null,
          },
        },
      ],
    });
    expect(approvals[0]?.card.plain_what).toBe('Run code in the sandbox');
    expect(approvals[0]?.card.plain_why).toBe('Asked to compute a total.');
    expect(approvals[0]?.card.parsed_command).toBeNull();
  });

  it('accepts the provisional `card` field name', () => {
    const approvals = extractSentinelFromEvent({
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

  it('parses a Tier 2 approval card next to a Tier 3 one', () => {
    const approvals = extractSentinelFromEvent({
      type: 'tool.approval_required',
      tool_calls: [
        { id: 'call-3', tier: 2, tier3_card: { plain_what: 'Change `notes.md` in your workspace.' } },
        { id: 'call-4', tier: 3, tier3_card: { plain_what: 'Send $250 to Acme Corp' } },
      ],
    });
    expect(approvals.map(approval => [approval.toolCallId, approval.tier])).toEqual([
      ['call-3', 2],
      ['call-4', 3],
    ]);
  });

  it('records the asking event and thread on each approval', () => {
    const approvals = extractSentinelFromEvent({
      type: 'tool.approval_required',
      id: 'evt-7',
      thread_id: 'sub-agent',
      tool_calls: [{ id: 'call-1', tier: 2, tier3_card: { plain_what: 'Edit notes.md' } }],
    });
    expect(approvals[0]?.eventId).toBe('evt-7');
    expect(approvals[0]?.threadId).toBe('sub-agent');
    const camel = extractSentinelFromEvent({
      type: 'tool.approval_required',
      id: 'evt-8',
      threadId: 'main',
      toolCalls: [{ id: 'call-2', tier: 2, tier3Card: { plainWhat: 'Edit notes.md' } }],
    });
    expect(camel[0]?.eventId).toBe('evt-8');
    expect(camel[0]?.threadId).toBe('main');
  });

  it('no longer reads Tier 2 notice events', () => {
    expect(
      extractSentinelFromEvent({
        type: 'tool.tier2_notice',
        tool_call_id: 'call-3',
        tier: 2,
        message: 'Ran the test suite',
      }),
    ).toEqual([]);
  });

  it('reads per-action fields at the event top level for single-action events', () => {
    const approvals = extractSentinelFromEvent({
      type: 'tool.approval_required',
      tool_call_id: 'call-5',
      tier: 3,
      tier3_card: { plain_what: 'Publish the release', plain_why: 'You asked for a release.' },
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.toolCallId).toBe('call-5');
  });

  it('ignores events without Sentinel data and drops malformed refs', () => {
    expect(extractSentinelFromEvent({ type: 'model.message' })).toEqual([]);
    expect(extractSentinelFromEvent(null)).toEqual([]);
    expect(extractSentinelFromEvent('nope')).toEqual([]);
    // Tier without a card is not an approval card; a card without plain_what is dropped.
    const approvals = extractSentinelFromEvent({
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
      { type: 'tool.approval_required', tool_call_id: 'call-1', tier: 2, tier3_card: { plain_what: 'First' } },
      { type: 'tool.approval_required', tool_call_id: 'call-1', tier: 3, tier3_card: { plain_what: 'Second' } },
    ]);
    expect(context.approvals).toHaveLength(1);
    expect(context.approvals[0]?.card.plain_what).toBe('Second');
    expect(context.approvals[0]?.tier).toBe(3);
  });
});

describe('held actions', () => {
  const heldRef = {
    id: 'call-held',
    source_event_id: 'evt-0',
    tier: 3,
    held: true,
    can_always_allow: true,
    expires_at: '2026-10-17T07:00:00.000Z',
    tier3_card: { plain_what: 'Send a note to Ana.', plain_why: 'It was on the list.' },
  };

  it('reads the held flag, the always-allow offer and the expiry', () => {
    const [info] = extractSentinelFromEvent({ type: 'tool.approval_required', tool_calls: [heldRef] });
    expect(info?.held).toEqual({ expiresAt: '2026-10-17T07:00:00.000Z' });
    expect(info?.alwaysAllowOffered).toBe(true);
  });

  it('offers always allow for a held mail read the owner may grant, and never for a held send', () => {
    const mailRead = {
      ...heldRef,
      tool_call_id: 'call-read',
      tool_name: 'list-messages',
      tier3_card: { plain_what: 'Run list-messages on Apple Mail.' },
    };
    const send = { ...heldRef, tool_call_id: 'call-send', tool_name: 'send-email', can_always_allow: false };
    const parsed = extractSentinelFromEvent({ type: 'tool.approval_required', tool_calls: [mailRead, send] });
    expect(parsed.map(info => info.alwaysAllowOffered)).toEqual([true, false]);
  });

  it('reads the same fields after the SDK camel-cases them', () => {
    const parsed = ToolApprovalRequiredEvent.parseOrThrow(
      {
        type: 'tool.approval_required',
        id: 'evt-1',
        created_at: '2026-10-16T07:00:00.000Z',
        thread_id: 'main',
        tool_calls: [
          {
            ...heldRef,
            tier3_card: {
              plain_what: 'Send a note to Ana.',
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
            },
          },
        ],
      },
      { unrecognizedObjectKeys: 'passthrough', allowUnrecognizedUnionMembers: true, allowUnrecognizedEnumValues: true },
    );
    const [info] = extractSentinelFromEvent(parsed);
    expect(info?.held).toEqual({ expiresAt: '2026-10-17T07:00:00.000Z' });
    expect(info?.alwaysAllowOffered).toBe(true);
  });

  it('leaves an ordinary approval without a held marker, and never offers always-allow it did not get', () => {
    const [ordinary] = extractSentinelFromEvent({
      type: 'tool.approval_required',
      tool_calls: [{ id: 'call-1', tier: 3, tier3_card: { plain_what: 'Do it' } }],
    });
    expect(ordinary?.held).toBeUndefined();
    const [held] = extractSentinelFromEvent({
      type: 'tool.approval_required',
      tool_calls: [{ ...heldRef, can_always_allow: undefined, expires_at: undefined }],
    });
    expect(held?.held).toEqual({ expiresAt: null });
    expect(held?.alwaysAllowOffered).not.toBe(true);
  });

  it('reads the answers a session already recorded from the inputs of its turns', () => {
    const context = extractSentinelSessionContext([
      {
        type: 'turn.created',
        input: [
          { type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call-a', approval: { status: 'allow' } },
          { type: 'user.tool_approval', threadId: 'main', toolCallId: 'call-b', approval: { status: 'deny' } },
          { type: 'user.message', content: 'hello' },
        ],
      },
    ]);
    expect(context.answers).toEqual({ 'call-a': 'approved', 'call-b': 'denied' });
  });

  it('reads the words of a Change it answer back from the turn, and no words from an ordinary denial', () => {
    const context = extractSentinelSessionContext([
      {
        type: 'turn.created',
        input: [
          {
            type: 'user.tool_approval',
            thread_id: 'main',
            tool_call_id: 'call-a',
            approval: { status: 'deny', reason: changeRequestReason('make it shorter') },
          },
          {
            type: 'user.tool_approval',
            thread_id: 'main',
            tool_call_id: 'call-b',
            approval: { status: 'deny', reason: 'not now' },
          },
        ],
      },
    ]);
    expect(context.answers).toEqual({ 'call-a': 'denied', 'call-b': 'denied' });
    expect(context.changeRequests).toEqual({ 'call-a': 'make it shorter' });
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
    const outcomes = ['logged', 'ran', 'approved', 'denied', 'auto_denied'];
    for (const outcome of outcomes) {
      const parsed = parseAuditEntries([{ ...entry, id: outcome, outcome }]);
      expect(parsed[0]?.outcome).toBe(outcome);
    }
    expect(parseAuditEntries([{ ...entry, outcome: 'maybe' }])).toEqual([]);
    expect(parseAuditEntries([{ ...entry, outcome: 'undone' }])).toEqual([]);
  });
});

describe('parseUserSettings', () => {
  it('defaults to offline off, nothing relaxed and searches running without asking', () => {
    const defaults = {
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
    };
    expect(parseUserSettings(null)).toEqual(defaults);
    expect(parseUserSettings({})).toEqual(defaults);
    expect(parseUserSettings({ data: null })).toEqual(defaults);
    expect(parseUserSettings({ data: { offline_mode: 'yes', tier2_auto_allow: ['file.write', 42] } })).toEqual(
      defaults,
    );
  });

  it('reads the server envelope, keeping known kinds once', () => {
    expect(
      parseUserSettings({
        data: { offline_mode: true, tier2_auto_allow: ['shell', 'file_write', 'nope', 'file_write'] },
      }),
    ).toEqual({
      offline_mode: true,
      tier2_auto_allow: ['file_write'],
      search_without_asking: true,
      maps_without_asking: false,
    });
  });

  it('reads the search setting, and falls back to running without asking when it is not a boolean', () => {
    expect(parseUserSettings({ data: { search_without_asking: false } }).search_without_asking).toBe(false);
    expect(parseUserSettings({ data: { search_without_asking: 'no' } }).search_without_asking).toBe(true);
  });

  it('reads the maps setting, and falls back to asking when it is not a boolean', () => {
    expect(parseUserSettings({ data: { maps_without_asking: true } }).maps_without_asking).toBe(true);
    expect(parseUserSettings({ data: { maps_without_asking: 'yes' } }).maps_without_asking).toBe(false);
  });

  it('does not read a bare settings object', () => {
    expect(parseUserSettings({ offline_mode: true, tier2_auto_allow: ['file_write'] })).toEqual({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
    });
  });
});

describe('chat scope offer', () => {
  const ref = { id: 'call-1', tier: 3, tier3_card: { plain_what: 'Read a note.' } };

  it('reads the server flag in either spelling and leaves it absent when not sent', () => {
    const read = (extra: Record<string, unknown>) =>
      extractSentinelFromEvent({ type: 'tool.approval_required', tool_calls: [{ ...ref, ...extra }] })[0];
    expect(read({ can_chat_allow: false })?.chatAllowOffered).toBe(false);
    expect(read({ canChatAllow: true })?.chatAllowOffered).toBe(true);
    expect(read({})).not.toHaveProperty('chatAllowOffered');
  });
});

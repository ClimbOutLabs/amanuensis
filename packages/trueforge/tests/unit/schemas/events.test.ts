import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { MemoryRecallPersistedEventSchema } from '../../../src/schemas/memoryEvents';
import { ProfileLearnedPersistedEventSchema } from '../../../src/schemas/profileLearningEvents';
import { SendReceiptPersistedEventSchema } from '../../../src/schemas/sendReceiptEvents';
import { ListTurnEventsResponseSchema } from '../../../src/schemas/turn';

describe('wire event schemas', () => {
  const memoryEvent = {
    type: 'aman.memory.recall',
    id: 'evt_0000000000000000000000001',
    created_at: '2026-09-01T10:00:00.000Z',
    injected_block:
      '<aman-memory>\n[world, 2026-08-14] Example.\n(memory: 1 items, 0 entities; 9 tokens of 2048 budget)\n</aman-memory>',
    stats: {
      items: 1,
      entities: 0,
      dropped_over_budget: 0,
      dropped_below_threshold: 0,
      estimated_tokens: 9,
      recall_ms: 42,
      outcome: 'ok',
      budget_reason: 'normal',
    },
    sweep: { verified: 0, retried: 0, abandoned: 0, pending: 0 },
  };

  it('accepts the persisted memory recall event standalone', () => {
    const parsed = MemoryRecallPersistedEventSchema.safeParse(memoryEvent);
    expect(parsed.success).toBe(true);
  });

  it('accepts the memory recall event in the live streaming union', () => {
    // Passthrough events dual-write to the live SSE stream; a streaming union
    // that rejects them makes SDK clients fail the whole stream the moment one
    // arrives, which broke real chats once. This pins the contract.
    const parsed = TurnStreamingEventSchema.safeParse(memoryEvent);
    expect(parsed.success).toBe(true);
  });

  // The recall screen adds an optional `screen` field carrying the per-turn withhold audit; it
  // must ride the same list and streaming unions the base event does.
  const screenedMemoryEvent = {
    ...memoryEvent,
    id: 'evt_0000000000000000000000003',
    injected_block:
      '<aman-memory>\n[world, 2026-08-14] Example.\n(memory: 1 items, 0 entities; 12 tokens of 2048 budget; 1 withheld by screen)\n</aman-memory>',
    screen: {
      withheld: 1,
      records: [
        { id: 'item:#0', score: 0.91, reason: 'flagged_malicious', origin: 'tool_ingested', withheld: true },
        { id: 'entity:#0', score: 0.72, reason: 'flagged_but_user_origin', origin: 'user_stated', withheld: false },
      ],
    },
  };

  it('accepts the screened memory recall event standalone', () => {
    const parsed = MemoryRecallPersistedEventSchema.safeParse(screenedMemoryEvent);
    expect(parsed.success).toBe(true);
  });

  it('accepts the screened memory recall event in the live streaming union', () => {
    const parsed = TurnStreamingEventSchema.safeParse(screenedMemoryEvent);
    expect(parsed.success).toBe(true);
  });

  it('accepts the screened memory recall event in the turn events list response', () => {
    const parsed = ListTurnEventsResponseSchema.safeParse({
      data: [screenedMemoryEvent],
      pagination: { limit: 50 },
    });
    expect(parsed.success).toBe(true);
  });

  const profileLearnedEvent = {
    type: 'aman.profile.learned',
    id: 'evt_0000000000000000000000002',
    created_at: '2026-09-01T10:00:00.000Z',
    previous: null,
    current: '# Learned\n\n- Prefers plain English.',
    revision: 3,
  };

  it('accepts the persisted profile learned event standalone', () => {
    const parsed = ProfileLearnedPersistedEventSchema.safeParse(profileLearnedEvent);
    expect(parsed.success).toBe(true);
  });

  it('accepts the profile learned event in the live streaming union', () => {
    const parsed = TurnStreamingEventSchema.safeParse(profileLearnedEvent);
    expect(parsed.success).toBe(true);
  });

  it('accepts the profile learned event in the turn events list response', () => {
    const parsed = ListTurnEventsResponseSchema.safeParse({
      data: [profileLearnedEvent],
      pagination: { limit: 50 },
    });
    expect(parsed.success).toBe(true);
  });

  // Context compaction can run mid-turn and dual-writes to the live SSE stream just like the
  // persisted log; a streaming union missing it fails SDK deserialization the moment compaction
  // fires. This pins the contract the same way the memory/profile passthrough events above do.
  const compactionEvent = {
    type: 'agent.context.compaction',
    id: 'evt_0000000000000000000000004',
    created_at: '2026-09-01T10:00:00.000Z',
    thread_id: 'thread_0000000000000000000000001',
    mode: 'conversation',
    tokens_before: 12000,
    tokens_after: 3000,
    summary_chars: 900,
    outcome: 'applied',
  };

  it('accepts the context compaction event in the live streaming union', () => {
    const parsed = TurnStreamingEventSchema.safeParse(compactionEvent);
    expect(parsed.success).toBe(true);
  });

  const sentReceipt = {
    type: 'aman.email.send_receipt',
    id: 'evt_0000000000000000000000005',
    created_at: '2026-09-01T10:00:00.000Z',
    tool_call_id: 'call_1',
    result: {
      outcome: 'sent',
      sent_at: '2026-09-01T09:12:00.000Z',
      sent_message_id: 'm-sent-1',
      check_code: 'A7F39C',
      message: { to: ['grace@example.com'], cc: [], bcc: [], subject: 'Lease', body: 'Thursday works.' },
    },
  };
  const notSentReceipt = {
    ...sentReceipt,
    id: 'evt_0000000000000000000000006',
    result: { outcome: 'not_sent', reason: 'draft_changed' },
  };

  it.each([sentReceipt, notSentReceipt])('accepts the send receipt event everywhere it travels', event => {
    expect(SendReceiptPersistedEventSchema.safeParse(event).success).toBe(true);
    expect(TurnStreamingEventSchema.safeParse(event).success).toBe(true);
    expect(ListTurnEventsResponseSchema.safeParse({ data: [event], pagination: { limit: 50 } }).success).toBe(true);
  });

  it('refuses a send receipt that claims a send without its message id', () => {
    const withoutId = { ...sentReceipt.result, sent_message_id: undefined };
    expect(SendReceiptPersistedEventSchema.safeParse({ ...sentReceipt, result: withoutId }).success).toBe(false);
  });
});

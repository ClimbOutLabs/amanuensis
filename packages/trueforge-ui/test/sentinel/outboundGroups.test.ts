import { describe, expect, it } from 'vitest';

import { groupOutboundEvents, OUTBOUND_GROUPING_THRESHOLD } from '@/sentinel/outboundGroups.js';
import type { OutboundEvent } from '@/sentinel/types.js';

function event(overrides: Partial<OutboundEvent> & Pick<OutboundEvent, 'id'>): OutboundEvent {
  return {
    kind: 'model_request',
    host: 'models.example.test',
    model: 'm',
    tool_name: null,
    request_bytes: 100,
    recipient_count: null,
    subject: null,
    conversation_id: 'c1',
    created_at: '2026-10-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('groupOutboundEvents', () => {
  it('keeps every request as its own row while the list is short', () => {
    const events = Array.from({ length: OUTBOUND_GROUPING_THRESHOLD }, (_unused, index) =>
      event({ id: String(index) }),
    );

    const rows = groupOutboundEvents(events);

    expect(rows).toHaveLength(OUTBOUND_GROUPING_THRESHOLD);
    expect(rows.every(row => row.type === 'event')).toBe(true);
  });

  it('folds model requests of one chat, host and model, keeping count, total size and the time span', () => {
    const events = [
      ...Array.from({ length: OUTBOUND_GROUPING_THRESHOLD }, (_unused, index) =>
        event({ id: `m${String(index)}`, created_at: `2026-10-17T11:${String(59 - index).padStart(2, '0')}:00.000Z` }),
      ),
      event({ id: 'other-chat', conversation_id: 'c2' }),
    ];

    const rows = groupOutboundEvents(events);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      type: 'model_requests',
      conversation_id: 'c1',
      count: OUTBOUND_GROUPING_THRESHOLD,
      total_bytes: 100 * OUTBOUND_GROUPING_THRESHOLD,
      latest_at: '2026-10-17T11:59:00.000Z',
      earliest_at: `2026-10-17T11:${String(59 - (OUTBOUND_GROUPING_THRESHOLD - 1))}:00.000Z`,
    });
    expect(rows[1]).toMatchObject({ type: 'model_requests', conversation_id: 'c2', count: 1 });
  });

  it('never folds other kinds and leaves an unmeasured size unmeasured', () => {
    const events = [
      ...Array.from({ length: OUTBOUND_GROUPING_THRESHOLD }, (_unused, index) =>
        event({ id: `s${String(index)}`, kind: 'web_search', model: null, host: 'search.example.test' }),
      ),
      event({ id: 'u1', request_bytes: null }),
      event({ id: 'u2', request_bytes: null }),
    ];

    const rows = groupOutboundEvents(events);

    expect(rows.filter(row => row.type === 'event')).toHaveLength(OUTBOUND_GROUPING_THRESHOLD);
    const group = rows.find(row => row.type === 'model_requests');
    expect(group).toMatchObject({ count: 2, total_bytes: null });
  });
});

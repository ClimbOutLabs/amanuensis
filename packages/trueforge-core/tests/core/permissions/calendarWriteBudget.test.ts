import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedToolCall, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import {
  calendarWriteBudgetBlocks,
  isCalendarWriteCall,
  MAX_CALENDAR_WRITES_PER_TURN,
} from '../../../src/core/permissions/calendarWriteBudget';

function write(
  id: string,
  args: Record<string, unknown>,
  info: Partial<InternalToolCallInfo> = {},
): InternalEnrichedToolCall {
  return {
    id,
    type: 'function',
    function: { name: 'create_event', arguments: JSON.stringify(args) },
    tool_info: {
      type: 'truefoundry-system',
      mcp_server_id: 'google_calendar',
      mcp_server_name: 'google_calendar',
      original_tool_name: 'create_event',
      is_approval_required: true,
      tier: 3,
      tier_reason: 'calendar_write',
      ...info,
    },
  };
}

const allowed = (ids: string[]): Map<string, ApprovalDecision> =>
  new Map(ids.map(id => [id, { status: 'allow' as const }]));

describe('isCalendarWriteCall', () => {
  it('covers every calendar change, whichever connector carries it', () => {
    for (const tier_reason of ['calendar_write', 'caldav_calendar_change', 'caldav_invitation_reply']) {
      expect(isCalendarWriteCall(write('a', {}, { tier_reason }).tool_info)).toBe(true);
    }
    // A connector write a hint escalated still counts, by its name.
    expect(
      isCalendarWriteCall(
        write('a', {}, { type: 'mcp', tier_reason: 'mcp_destructive_hint', original_tool_name: 'delete_event' })
          .tool_info,
      ),
    ).toBe(true);
  });

  it('leaves out reads and calls refused before they ran', () => {
    expect(
      isCalendarWriteCall(
        write('a', {}, { type: 'mcp', tier_reason: 'caldav_private_read', original_tool_name: 'list_events' })
          .tool_info,
      ),
    ).toBe(false);
    expect(
      isCalendarWriteCall(
        write('a', {}, { pre_dispatch_failure: { kind: 'policy_blocked', message: 'no' } }).tool_info,
      ),
    ).toBe(false);
  });
});

describe('calendarWriteBudgetBlocks', () => {
  it('refuses an exact repeat of a change this turn already let through', () => {
    const blocks = calendarWriteBudgetBlocks({
      earlier: [write('w1', { title: 'Lunch' })],
      decisions: allowed(['w1']),
      calls: [write('w2', { title: 'Lunch' }), write('w3', { title: 'Dinner' })],
    });
    expect([...blocks.keys()]).toEqual(['w2']);
    expect(blocks.get('w2')?.message).toContain('already made');
  });

  it('does not count a change the person declined or has not answered', () => {
    const blocks = calendarWriteBudgetBlocks({
      earlier: [write('w1', { title: 'Lunch' }), write('w2', { title: 'Tea' })],
      decisions: new Map([['w1', { status: 'deny' as const }]]),
      calls: [write('w3', { title: 'Lunch' }), write('w4', { title: 'Tea' })],
    });
    expect(blocks.size).toBe(0);
  });

  it('counts a change that ran without asking', () => {
    const blocks = calendarWriteBudgetBlocks({
      earlier: [
        write(
          'w1',
          { title: 'Lunch' },
          { type: 'mcp', tier: 1, tier_reason: 'mcp_tool_grant', is_approval_required: false },
        ),
      ],
      decisions: new Map(),
      calls: [
        write(
          'w2',
          { title: 'Lunch' },
          { type: 'mcp', tier: 1, tier_reason: 'mcp_tool_grant', is_approval_required: false },
        ),
      ],
    });
    expect([...blocks.keys()]).toEqual(['w2']);
  });

  it(`lets ${String(MAX_CALENDAR_WRITES_PER_TURN)} changes through in one turn and refuses the rest`, () => {
    const earlier = [write('w1', { n: 1 }), write('w2', { n: 2 })];
    const calls = Array.from({ length: 6 }, (_, index) => write(`n${String(index)}`, { n: index + 10 }));
    const blocks = calendarWriteBudgetBlocks({ earlier, decisions: allowed(['w1', 'w2']), calls });
    expect([...blocks.keys()]).toEqual(['n3', 'n4', 'n5']);
    expect(blocks.get('n3')?.owner_message).toBe(
      'Aman stopped after 5 calendar changes in one turn. Ask again to make more.',
    );
  });

  it('leaves calls that are not calendar changes alone', () => {
    const calls = Array.from({ length: 8 }, (_, index) =>
      write(`r${String(index)}`, { n: index }, { tier: 1, tier_reason: 'calendar_read', is_approval_required: false }),
    );
    expect(calendarWriteBudgetBlocks({ earlier: [], decisions: new Map(), calls }).size).toBe(0);
  });
});

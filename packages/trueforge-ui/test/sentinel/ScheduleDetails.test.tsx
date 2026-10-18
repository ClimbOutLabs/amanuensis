// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import { extractSentinelFromEvent, type SentinelApprovalCard } from '@/sentinel/types.js';

/** The card the server sends for "every weekday at 8am, give me a morning brief". */
const MORNING_BRIEF_CARD = {
  plain_what:
    'Create the schedule "morning-brief". It runs every weekday at 8:00 AM (America/New_York) and starts as soon as you approve.',
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
  email: null,
  calendar_event: null,
  schedule: {
    action: 'create',
    name: 'morning-brief',
    when: 'Every weekday at 8:00 AM',
    time_zone: 'America/New_York',
    task: 'Give me a morning brief: my calendar for today, important unread mail, and the weather.',
    runs_as: 'assistant',
    first_run: 'Monday, October 19 at 8:00 AM',
  },
} satisfies SentinelApprovalCard;

function renderCard(card: SentinelApprovalCard) {
  render(
    <PermissionApprovalCard toolName="create_schedule" card={card} tier={3} onApprove={vi.fn()} onDeny={vi.fn()} />,
  );
}

describe('schedule approval card', () => {
  it('says when it runs, exactly what it does, who runs it, and that it starts on approval', () => {
    renderCard(MORNING_BRIEF_CARD);
    expect(screen.getByText('New schedule')).toBeInTheDocument();
    expect(screen.getByText(MORNING_BRIEF_CARD.plain_what)).toBeInTheDocument();
    const lines = Array.from(document.querySelectorAll('[data-role="schedule"] p')).map(p => p.textContent);
    expect(lines).toEqual([
      'Name: morning-brief',
      'When it runs: Every weekday at 8:00 AM (America/New_York)',
      'Runs as: assistant',
      'Starts: As soon as you approve. First run: Monday, October 19 at 8:00 AM.',
      'What it will do each time',
      'Give me a morning brief: my calendar for today, important unread mail, and the weather.',
    ]);
  });

  it('shows a delete with what is removed and no start line', () => {
    renderCard({
      ...MORNING_BRIEF_CARD,
      plain_what: 'Delete the schedule "morning-brief", which runs every weekday at 8:00 AM (America/New_York).',
      cannot_be_undone: 'Once deleted, the schedule is gone for good.',
      schedule: { ...MORNING_BRIEF_CARD.schedule, action: 'delete', first_run: null },
    });
    expect(screen.getByText('Delete schedule')).toBeInTheDocument();
    expect(screen.getByText('Once deleted, the schedule is gone for good.')).toBeInTheDocument();
    expect(screen.queryByText(/^Starts:/)).toBeNull();
  });

  it('reads the schedule from a streamed approval request and drops a partial one', () => {
    const event = (schedule: unknown) => ({
      type: 'tool.approval_required',
      tool_calls: [{ id: 'call-1', tier: 3, tier3_card: { plain_what: 'Create it', schedule } }],
    });
    expect(extractSentinelFromEvent(event(MORNING_BRIEF_CARD.schedule))[0]?.card.schedule).toEqual(
      MORNING_BRIEF_CARD.schedule,
    );
    expect(extractSentinelFromEvent(event({ action: 'create', name: 'x' }))[0]?.card.schedule).toBeNull();
  });
});

// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import { extractSentinelFromEvent, type SentinelApprovalCard } from '@/sentinel/types.js';

/** The card the server sends for "every weekday at 8am, give me a morning brief". */
const MORNING_BRIEF_CARD = {
  plain_what:
    'Create the schedule "Morning brief". It runs every weekday at 8:00 AM (America/New_York) and starts as soon as you approve.',
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
  persona: null,
  schedule: {
    action: 'create',
    name: 'Morning brief',
    when: 'Every weekday at 8:00 AM',
    time_zone: 'America/New_York',
    task: 'Give me a morning brief: my calendar for today, important unread mail, and the weather.',
    runs_as: 'Aman',
    next_runs: ['Monday, October 19 at 8:00 AM', 'Tuesday, October 20 at 8:00 AM', 'Wednesday, October 21 at 8:00 AM'],
  },
} satisfies SentinelApprovalCard;

/** The same card for a plain chat: the schedule gets its own agent, and the person may pick its tools. */
const PICKABLE_CARD = {
  ...MORNING_BRIEF_CARD,
  schedule: {
    ...MORNING_BRIEF_CARD.schedule,
    runs_as: 'morning-brief',
    tools: {
      editable: true,
      agent_name: 'morning-brief',
      connectors: [
        { name: 'gmail', on: true },
        { name: 'calendar', on: false },
      ],
      skills: [{ name: 'pdf', on: false }],
      run_code: false,
      memory: true,
    },
  },
} satisfies SentinelApprovalCard;

function renderCard(card: SentinelApprovalCard) {
  render(
    <PermissionApprovalCard
      approvalId="approval-1"
      othersWaiting={0}
      card={card}
      onApprove={vi.fn()}
      onDeny={vi.fn()}
    />,
  );
}

describe('schedule approval card', () => {
  it('says when it runs, exactly what it does, who runs it, and that it starts on approval', () => {
    renderCard(MORNING_BRIEF_CARD);
    expect(screen.getByText('New schedule')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create the schedule "Morning brief"?' })).toBeInTheDocument();
    const lines = Array.from(document.querySelectorAll('[data-role="schedule"] p, [data-role="schedule"] li')).map(
      node => node.textContent,
    );
    expect(lines).toEqual([
      'Name: Morning brief',
      'When it runs: Every weekday at 8:00 AM (America/New_York)',
      'Runs as: Aman',
      'Starts: As soon as you approve.',
      'Next runs',
      'Monday, October 19 at 8:00 AM',
      'Tuesday, October 20 at 8:00 AM',
      'Wednesday, October 21 at 8:00 AM',
      'What it will do each time',
      'Give me a morning brief: my calendar for today, important unread mail, and the weather.',
      "While you're away it can only read and write to chat; anything risky is skipped and waits for your OK.",
    ]);
  });

  it('shows a delete with what is removed and no start line', () => {
    renderCard({
      ...MORNING_BRIEF_CARD,
      plain_what: 'Delete the schedule "Morning brief", which runs every weekday at 8:00 AM (America/New_York).',
      cannot_be_undone: 'Once deleted, the schedule is gone for good.',
      schedule: { ...MORNING_BRIEF_CARD.schedule, action: 'delete', next_runs: [] },
    });
    expect(screen.getByText('Delete schedule')).toBeInTheDocument();
    expect(screen.getByText('Once deleted, the schedule is gone for good.')).toBeInTheDocument();
    expect(screen.queryByText(/^Starts:/)).toBeNull();
    expect(screen.queryByText('Next runs')).toBeNull();
    expect(document.querySelector('[data-role="schedule-away"]')).toBeNull();
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

  it('shows tick boxes for a new schedule with its own agent, ticked as the server sent them', () => {
    render(
      <PermissionApprovalCard
        approvalId="approval-1"
        othersWaiting={0}
        card={PICKABLE_CARD}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onChangeRequest={vi.fn()}
      />,
    );
    const ticked = (name: string | RegExp) => screen.getByRole<HTMLInputElement>('checkbox', { name }).checked;
    expect(document.querySelector('[data-role="schedule-tools-note"]')?.textContent).toBe(
      'Pick what this schedule may use. Your choices are saved as morning-brief, and you can change them later.',
    );
    expect([ticked('gmail'), ticked('calendar'), ticked('pdf'), ticked('Run code'), ticked(/^Memory/)]).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(screen.queryByRole('button', { name: 'Update the card' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-approval-primary]')).toBeEnabled();
  });

  it('will not approve changed ticks: it asks for the card again with exactly what is ticked', () => {
    const onApprove = vi.fn();
    const onChangeRequest = vi.fn();
    render(
      <PermissionApprovalCard
        approvalId="approval-1"
        othersWaiting={0}
        card={PICKABLE_CARD}
        onApprove={onApprove}
        onDeny={vi.fn()}
        onChangeRequest={onChangeRequest}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'calendar' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'pdf' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Memory/ }));
    // A skill needs run code, so it is turned on and held on.
    expect(screen.getByRole('checkbox', { name: /^Run code/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Run code/ })).toBeDisabled();
    expect(document.querySelector('[data-approval-primary]')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Update the card' }));
    expect(onChangeRequest).toHaveBeenCalledWith(
      'Use exactly these for the schedule. Connectors: gmail, calendar. Skills: pdf. Run code: On. Memory: Off',
    );
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('lets the person approve again once the ticks are back as the card sent them', () => {
    render(
      <PermissionApprovalCard
        approvalId="approval-1"
        othersWaiting={0}
        card={PICKABLE_CARD}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onChangeRequest={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'calendar' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'calendar' }));
    expect(screen.queryByRole('button', { name: 'Update the card' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-approval-primary]')).toBeEnabled();
  });

  it("shows a saved agent's tools as plain rows, with nothing to tick", () => {
    renderCard({
      ...PICKABLE_CARD,
      schedule: { ...PICKABLE_CARD.schedule, tools: { ...PICKABLE_CARD.schedule.tools, editable: false } },
    });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const rows = Array.from(document.querySelectorAll('[data-role="schedule-tools"] p')).map(node => node.textContent);
    expect(rows).toEqual(['Connectors: gmail', 'Skills: None', 'Run code: Off', 'Memory: On']);
  });

  it('does not show a card whose tools cannot be read in full', () => {
    const event = (schedule: unknown) => ({
      type: 'tool.approval_required',
      tool_calls: [{ id: 'call-1', tier: 3, tier3_card: { plain_what: 'Create it', schedule } }],
    });
    expect(extractSentinelFromEvent(event(PICKABLE_CARD.schedule))[0]?.card.schedule).toEqual(PICKABLE_CARD.schedule);
    expect(
      extractSentinelFromEvent(event({ ...PICKABLE_CARD.schedule, tools: { editable: true } }))[0]?.card.schedule,
    ).toBeNull();
    // The generated client hands the same card over with camelCase keys.
    const { agent_name: agentName, run_code: runCode, ...rest } = PICKABLE_CARD.schedule.tools;
    expect(
      extractSentinelFromEvent(event({ ...PICKABLE_CARD.schedule, tools: { ...rest, agentName, runCode } }))[0]?.card
        .schedule,
    ).toEqual(PICKABLE_CARD.schedule);
  });
});

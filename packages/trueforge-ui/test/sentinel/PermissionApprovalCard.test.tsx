// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionApprovalCard, type PermissionApprovalCardProps } from '@/sentinel/PermissionApprovalCard.js';
import type { SentinelApprovalCalendarEvent, SentinelApprovalCard } from '@/sentinel/types.js';

function baseCard(): SentinelApprovalCard {
  return {
    plain_what: 'Send $250 to Acme Corp',
    plain_why: 'You asked the assistant to pay the invoice.',
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
    schedule: null,
    persona: null,
    agent: null,
  };
}

function renderCard(overrides: Partial<SentinelApprovalCard> = {}, props: Partial<PermissionApprovalCardProps> = {}) {
  const card: SentinelApprovalCard = { ...baseCard(), ...overrides };
  const onApprove = vi.fn();
  const onDeny = vi.fn();
  render(
    <PermissionApprovalCard
      approvalId="approval-1"
      card={card}
      othersWaiting={0}
      onApprove={onApprove}
      onDeny={onDeny}
      {...props}
    />,
  );
  return { onApprove, onDeny };
}

describe('PermissionApprovalCard', () => {
  it('renders the server-supplied what, why, and details', () => {
    renderCard({
      destination: 'acme-corp',
      recipient: 'Acme Corp',
      amount: '$250',
      cannot_be_undone: "Once this is sent, it can't be unsent.",
      why_asked_again: 'the earlier approval expired',
    });
    expect(screen.getByText('Send $250 to Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Why: You asked the assistant to pay the invoice.')).toBeInTheDocument();
    expect(screen.getByText('Destination')).toBeInTheDocument();
    expect(screen.getAllByText('acme-corp')[0]).toBeInTheDocument();
    expect(screen.getByText('Recipient')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('$250')).toBeInTheDocument();
    expect(screen.getByText("Once this is sent, it can't be unsent.")).toBeInTheDocument();
    expect(screen.getByText('You have seen this before: the earlier approval expired')).toBeInTheDocument();
  });

  it('shows the exact parsed command whenever the card carries one', () => {
    renderCard({ parsed_command: 'rm -rf /tmp/work' });
    expect(screen.getByText('Command')).toBeInTheDocument();
    expect(screen.getByText('rm -rf /tmp/work')).toBeInTheDocument();
  });

  it('omits null rows', () => {
    renderCard();
    expect(screen.queryByText('Destination')).not.toBeInTheDocument();
    expect(screen.queryByText('Command')).not.toBeInTheDocument();
    expect(screen.queryByText(/Cannot be undone/)).not.toBeInTheDocument();
    expect(screen.queryByText('Sends to')).not.toBeInTheDocument();
    expect(screen.queryByText('Exactly what will be sent')).not.toBeInTheDocument();
  });

  it('renders the outbound arguments and connector host for connector tools', () => {
    renderCard({
      outbound_text: 'query: sensitive internal project name',
      destination_host: 'mcp.exa.ai',
    });
    expect(screen.getByText('Sends to')).toBeInTheDocument();
    expect(screen.getByText('mcp.exa.ai')).toBeInTheDocument();
    expect(screen.getByText('Full request')).toBeInTheDocument();
    expect(screen.getByText('query: sensitive internal project name')).toBeInTheDocument();
  });

  it('renders outbound text in a monospace block', () => {
    renderCard({ outbound_text: 'url: https://example.com/fetch?x=1' });
    const block = screen.getByText('url: https://example.com/fetch?x=1');
    expect(block.tagName.toLowerCase()).toBe('pre');
    expect(block.className).toContain('font-mono');
  });

  it('shows short outbound text whole with no show-all control', () => {
    renderCard({ outbound_text: 'query: short' });
    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
  });

  it('folds long outbound text and reveals all of it on Show all', () => {
    const text = `body: ${'a'.repeat(600)}END`;
    renderCard({ outbound_text: text });
    const folded = screen.getByText(/^body: a+\.\.\.$/);
    expect(folded.textContent).not.toContain('END');
    fireEvent.click(screen.getByRole('button', { name: /show all \(\d+ more characters\)/i }));
    expect(screen.getByText(text)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show less/i }));
    expect(screen.queryByText(text)).not.toBeInTheDocument();
  });

  it('shows no reason line when the server sent none', () => {
    renderCard({ plain_why: null });
    expect(screen.queryByText(/did not state a reason/i)).not.toBeInTheDocument();
    expect(screen.getByText('Send $250 to Acme Corp')).toBeInTheDocument();
  });

  it('shows the cannot-be-undone note as a calm line with no warning box or prefix', () => {
    renderCard({ cannot_be_undone: "Once this is sent, it can't be unsent." });
    const note = screen.getByText("Once this is sent, it can't be unsent.");
    expect(screen.queryByText(/Cannot be undone/)).not.toBeInTheDocument();
    expect(note.closest('[role="note"]')).toBeNull();
    expect(note.closest('p')?.className).not.toMatch(/warning/);
  });

  it('renders a card with a null cannot-be-undone note without an empty row or the word null', () => {
    renderCard({ cannot_be_undone: null });
    expect(screen.getByText('Send $250 to Acme Corp')).toBeInTheDocument();
    expect(screen.queryByText(/null/i)).not.toBeInTheDocument();
    expect(document.querySelector('p:empty')).toBeNull();
    expect(document.querySelectorAll('p > svg')).toHaveLength(0);
  });

  it("labels the reason as the agent's own words", () => {
    renderCard({ plain_why: 'Looking up a listing.' });
    expect(screen.getByText('Why: Looking up a listing.')).toBeInTheDocument();
  });

  it('shows one plain line above the payload when part of it is cut', () => {
    renderCard({ outbound_text: 'body: x ... (5 more characters not shown)', outbound_truncated: true });
    expect(screen.getByText('Part of what will be sent is not shown in full.')).toBeInTheDocument();
  });

  it('shows no cut line when nothing was cut', () => {
    renderCard({ outbound_text: 'body: x', outbound_truncated: false });
    expect(screen.queryByText(/not shown in full/)).not.toBeInTheDocument();
  });

  it('breaks long recipient values and folds them behind Show all', () => {
    const recipients = Array.from({ length: 60 }, (_, index) => `person${String(index)}@example.com`).join(', ');
    renderCard({ recipient: recipients });
    const folded = screen.getAllByText(/^person0@example\.com.*\.\.\.$/).at(0);
    if (folded === undefined) throw new Error('recipients were not folded');
    expect(folded.className).toContain('break-words');
    expect(folded.parentElement?.className).toContain('min-w-0');
    expect(folded.textContent).not.toContain('person59@example.com');
    fireEvent.click(screen.getByRole('button', { name: /show all/i }));
    expect(screen.getAllByText(recipients)[0]).toBeInTheDocument();
  });

  it('folds a long destination too', () => {
    renderCard({ destination: `https://example.com/${'a'.repeat(700)}` });
    expect(screen.getByRole('button', { name: /show all \(\d+ more characters\)/i })).toBeInTheDocument();
  });

  it('never splits a surrogate pair when it folds', () => {
    renderCard({ outbound_text: '\u{1F600}'.repeat(501) });
    const folded = screen.getByText(/^(\u{1F600})+\.\.\.$/u);
    expect(Array.from(folded.textContent ?? '')).toHaveLength(500 + 3);
    expect(folded.textContent).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('asks its question as the heading, with no approval label, lock or tier word', () => {
    renderCard();
    expect(screen.getByRole('heading', { name: 'Send $250 to Acme Corp' })).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
    expect(screen.queryByText('Approval needed')).not.toBeInTheDocument();
    expect(screen.queryByText(/Needs your OK|Review carefully|Tier \d/)).not.toBeInTheDocument();
  });

  it('calls the safe verb', () => {
    const { onApprove, onDeny } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).not.toHaveBeenCalled();
  });

  it('calls the quiet no', () => {
    const { onApprove, onDeny } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('offers Approve all only when the container passes a batch handler', () => {
    renderCard();
    expect(screen.queryByRole('button', { name: /Approve all/ })).not.toBeInTheDocument();
  });

  it('calls the batch handler from Approve all and shows how many calls it covers', () => {
    const onApproveAll = vi.fn();
    const { onApprove } = renderCard({}, { onApproveAll, batchSize: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Approve all (3)' }));
    expect(onApproveAll).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });
});

describe('PermissionApprovalCard for a calendar event', () => {
  const event: SentinelApprovalCalendarEvent = {
    action: 'change',
    calendar: 'ada@example.com',
    title: 'Team sync (online)',
    when: 'Tuesday, October 20, 2026, 2:00 pm to 2:30 pm',
    time_zone: 'America/New_York',
    duration: '30 minutes',
    location: 'Room 4',
    description: 'Bring the plan.',
    attendees: ['lin@example.com', 'sam@example.com'],
    guests_emailed: true,
    one_of_repeating: true,
    before: {
      title: 'Team sync',
      when: 'Monday, October 19, 2026, 8:00 am to 8:30 am',
      duration: '30 minutes',
      location: '',
    },
  };

  it('shows before and after, the calendar, local time with its zone, length, place and every guest', () => {
    renderCard({ plain_what: 'Change "Team sync" in your Google Calendar.', calendar_event: event });
    expect(screen.getByRole('heading', { name: 'Change "Team sync (online)" in your calendar?' })).toBeInTheDocument();
    expect(screen.queryByText('payment')).not.toBeInTheDocument();
    const shown = screen.getByText('Now').parentElement?.parentElement;
    expect(shown).toHaveTextContent('Title: Team sync');
    expect(shown).toHaveTextContent('When: Monday, October 19, 2026, 8:00 am to 8:30 am');
    expect(shown).toHaveTextContent('After the change');
    expect(shown).toHaveTextContent('Calendar: Main calendar of ada@example.com');
    expect(shown).toHaveTextContent('Title: Team sync (online)');
    expect(shown).toHaveTextContent('When: Tuesday, October 20, 2026, 2:00 pm to 2:30 pm');
    expect(shown).toHaveTextContent('Time zone: America/New_York');
    expect(shown).toHaveTextContent('Length: 30 minutes');
    expect(shown).toHaveTextContent('Where: Room 4');
    expect(shown).toHaveTextContent('Repeats: Only this one event of the series changes');
    expect(shown).toHaveTextContent('Guests: lin@example.com, sam@example.com');
    expect(screen.getByText('Google will email every guest about this.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Event description' })).toHaveTextContent('Bring the plan.');
  });

  it('says plainly when there are no guests, and for a new event shows what will be saved', () => {
    renderCard({
      calendar_event: { ...event, action: 'create', attendees: [], guests_emailed: false, before: null },
    });
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByText('Exactly what will be saved')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.queryByText(/Google will/)).not.toBeInTheDocument();
  });
});

describe('PermissionApprovalCard always allow this tool', () => {
  const ALWAYS_ALLOW_TOOL = 'Always allow this tool';

  it('offers the option only when an always-allow handler is passed', () => {
    renderCard({}, { onApproveAlways: vi.fn() });
    expect(screen.getByRole('button', { name: ALWAYS_ALLOW_TOOL })).toBeInTheDocument();
  });

  it('does not offer the option without a handler', () => {
    renderCard();
    expect(screen.queryByRole('button', { name: ALWAYS_ALLOW_TOOL })).not.toBeInTheDocument();
  });

  it('asks the owner to confirm before it records anything', () => {
    const onApproveAlways = vi.fn();
    renderCard({}, { onApproveAlways });
    fireEvent.click(screen.getByRole('button', { name: ALWAYS_ALLOW_TOOL }));

    expect(screen.getByRole('heading', { name: 'Always allow this tool?' })).toBeInTheDocument();
    expect(screen.getByText(/You can remove this later in connector settings/)).toBeInTheDocument();
    expect(onApproveAlways).not.toHaveBeenCalled();
  });

  it('says who will run this kind of action in the confirm step, in the assistant name and never as an agent', () => {
    renderCard({}, { onApproveAlways: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: ALWAYS_ALLOW_TOOL }));

    expect(
      screen.getByText('Aman will run this kind of action on this connector without asking, in every chat.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/The agent will run/)).not.toBeInTheDocument();
  });

  it('calls nothing when the owner cancels the confirm step', () => {
    const onApproveAlways = vi.fn();
    const { onApprove } = renderCard({}, { onApproveAlways });
    fireEvent.click(screen.getByRole('button', { name: ALWAYS_ALLOW_TOOL }));
    fireEvent.click(screen.getByTestId('always-allow-cancel'));

    expect(onApproveAlways).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('calls the handler once when the owner confirms', () => {
    const onApproveAlways = vi.fn();
    renderCard({}, { onApproveAlways });
    fireEvent.click(screen.getByRole('button', { name: ALWAYS_ALLOW_TOOL }));
    fireEvent.click(screen.getByTestId('always-allow-confirm'));

    expect(onApproveAlways).toHaveBeenCalledTimes(1);
  });
});

describe('PermissionApprovalCard "Change it"', () => {
  // A new persona is a card the person may change; a mail card has its own Edit button.
  const changeableCard: SentinelApprovalCard = {
    ...baseCard(),
    persona: { name: 'Tax helper', description: 'Files receipts', instructions: 'Keep receipts.', model_name: 'm' },
  };

  function renderChangeable(props: Partial<PermissionApprovalCardProps> = {}) {
    const handlers = { onApprove: vi.fn(), onDeny: vi.fn(), onChangeRequest: vi.fn() };
    render(
      <PermissionApprovalCard
        approvalId="approval-1"
        card={changeableCard}
        othersWaiting={0}
        onApprove={handlers.onApprove}
        onDeny={handlers.onDeny}
        onChangeRequest={handlers.onChangeRequest}
        {...props}
      />,
    );
    return handlers;
  }

  it('shows Change it between Approve and Deny when the container passes a handler', () => {
    renderChangeable();
    const labels = screen.getAllByRole('button').map(button => button.textContent);
    expect(labels).toEqual(['Allow', 'Change it', 'Not now']);
  });

  it('shows no Change it when the container passes no handler', () => {
    render(
      <PermissionApprovalCard
        approvalId="approval-1"
        card={baseCard()}
        othersWaiting={0}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Change it' })).not.toBeInTheDocument();
  });

  it('opens a labelled text box with focus in it, and Send waits for some text', () => {
    renderChangeable();
    fireEvent.click(screen.getByRole('button', { name: 'Change it' }));
    const input = screen.getByLabelText('What should change?');
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends the trimmed text once, and never approves or denies the call', () => {
    const { onApprove, onDeny, onChangeRequest } = renderChangeable();
    fireEvent.click(screen.getByRole('button', { name: 'Change it' }));
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: '  make it shorter ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onChangeRequest).toHaveBeenCalledTimes(1);
    expect(onChangeRequest).toHaveBeenCalledWith('make it shorter');
    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('What should change?')).not.toBeInTheDocument();
  });

  it('sends the text when Enter is pressed in the box', () => {
    const { onChangeRequest } = renderChangeable();
    fireEvent.click(screen.getByRole('button', { name: 'Change it' }));
    const input = screen.getByLabelText('What should change?');
    fireEvent.change(input, { target: { value: 'add a greeting' } });
    const form = input.closest('form');
    if (form === null) throw new Error('the change box is not inside a form');
    fireEvent.submit(form);
    expect(onChangeRequest).toHaveBeenCalledWith('add a greeting');
  });

  it('closes on Cancel without sending, and gives focus back to Change it', () => {
    const { onChangeRequest } = renderChangeable();
    const changeButton = screen.getByRole('button', { name: 'Change it' });
    fireEvent.click(changeButton);
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onChangeRequest).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('What should change?')).not.toBeInTheDocument();
    expect(changeButton).toHaveFocus();
  });

  it('closes on Escape like Cancel', () => {
    const { onChangeRequest } = renderChangeable();
    fireEvent.click(screen.getByRole('button', { name: 'Change it' }));
    fireEvent.keyDown(screen.getByLabelText('What should change?'), { key: 'Escape' });
    expect(onChangeRequest).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('What should change?')).not.toBeInTheDocument();
  });

  it('disables Change it while the card cannot be answered', () => {
    renderChangeable({ disabled: true });
    expect(screen.getByRole('button', { name: 'Change it' })).toBeDisabled();
  });
});

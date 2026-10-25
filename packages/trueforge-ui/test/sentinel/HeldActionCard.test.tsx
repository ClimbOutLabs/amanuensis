// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HeldActionCard, type HeldActionCardProps } from '@/sentinel/HeldActionCard.js';
import { HELD_EXPIRED_TEXT } from '@/sentinel/heldActionErrors.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';

function card(overrides: Partial<SentinelApprovalCard> = {}): SentinelApprovalCard {
  return {
    plain_what: 'Send a note to Ana?',
    plain_why: 'It was on the Monday list.',
    cannot_be_undone: "Once this is sent, it can't be unsent.",
    why_asked_again: null,
    destination: 'mail',
    recipient: 'ana@example.com',
    amount: null,
    parsed_command: null,
    outbound_text: 'to: ana@example.com\nbody: Lunch at noon?',
    destination_host: 'mail.example.com',
    outbound_truncated: false,
    email: null,
    calendar_event: null,
    schedule: null,
    persona: null,
    ...overrides,
  };
}

function renderCard(props: Partial<HeldActionCardProps> = {}, cardOverrides: Partial<SentinelApprovalCard> = {}) {
  const handlers = { onApprove: vi.fn(), onAlwaysAllow: vi.fn(), onDeny: vi.fn() };
  render(
    <ul>
      <HeldActionCard
        card={card(cardOverrides)}
        status={{ kind: 'waiting' }}
        alwaysAllowOffered={false}
        {...handlers}
        {...props}
      />
    </ul>,
  );
  return handlers;
}

describe('HeldActionCard', () => {
  it('leads with who and where and the full text, and ends with the model reason under its own label', () => {
    renderCard();
    const text = screen.getByRole('listitem').textContent ?? '';
    expect(text.indexOf('ana@example.com')).toBeGreaterThan(-1);
    expect(text.indexOf('Full request')).toBeGreaterThan(text.indexOf('ana@example.com'));
    expect(screen.getByText(/Lunch at noon\?/)).toBeInTheDocument();
    const reason = screen.getByText('Agent says: It was on the Monday list.');
    expect(text.indexOf('Agent says')).toBeGreaterThan(text.indexOf('Full request'));
    expect(text.indexOf('Agent says')).toBeGreaterThan(text.indexOf("can't be unsent"));
    expect(reason).toBeInTheDocument();
  });

  it('shows plainly when part of the text is cut off', () => {
    renderCard({}, { outbound_truncated: true });
    expect(screen.getByText('Part of this is not shown in full. Check it before you approve.')).toBeInTheDocument();
  });

  it('says why the action was held when the server gave a reason', () => {
    renderCard({}, { why_asked_again: 'You have not allowed email to this address before.' });
    expect(screen.getByText('You have not allowed email to this address before.')).toBeInTheDocument();
  });

  it('offers Approve and Deny, and never a chat-wide or permanent refusal', () => {
    const { onApprove, onDeny } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /this chat/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Always deny/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always allow this tool' })).not.toBeInTheDocument();
  });

  it('offers Always allow this tool only when the server said it may', () => {
    renderCard({ alwaysAllowOffered: false });
    expect(screen.queryByRole('button', { name: 'Always allow this tool' })).not.toBeInTheDocument();
  });

  it('asks the owner to confirm Always allow this tool before it records anything', () => {
    const { onAlwaysAllow } = renderCard({ alwaysAllowOffered: true });
    fireEvent.click(screen.getByRole('button', { name: 'Always allow this tool' }));

    expect(screen.getByRole('heading', { name: 'Always allow this tool?' })).toBeInTheDocument();
    expect(screen.getByText(/You can remove this later in connector settings/)).toBeInTheDocument();
    expect(onAlwaysAllow).not.toHaveBeenCalled();
  });

  it('calls nothing when the owner cancels the Always allow confirm step', () => {
    const { onAlwaysAllow, onApprove } = renderCard({ alwaysAllowOffered: true });
    fireEvent.click(screen.getByRole('button', { name: 'Always allow this tool' }));
    fireEvent.click(screen.getByTestId('always-allow-cancel'));

    expect(onAlwaysAllow).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('calls the Always allow handler once when the owner confirms', () => {
    const { onAlwaysAllow } = renderCard({ alwaysAllowOffered: true });
    fireEvent.click(screen.getByRole('button', { name: 'Always allow this tool' }));
    fireEvent.click(screen.getByTestId('always-allow-confirm'));

    expect(onAlwaysAllow).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: 'approved' as const, outcome: 'done' as const }, 'Approved and done.'],
    [
      { kind: 'approved' as const, outcome: 'failed' as const },
      'Approved, but it failed. The details are in the chat.',
    ],
    [
      { kind: 'approved' as const, outcome: 'unclear' as const },
      'Approved, but it is not clear whether it finished. Check the chat.',
    ],
    [
      { kind: 'approved' as const, outcome: 'not_run' as const },
      'Approved, but it did not run, so nothing was done. Ask again in chat.',
    ],
    [{ kind: 'approved_earlier' as const }, 'Approved. See the result in the chat.'],
    [
      { kind: 'refused' as const, message: 'This is not allowed any more, so nothing was done. Ask again in chat.' },
      /not allowed any more/,
    ],
    [{ kind: 'denied' as const }, 'Denied. Nothing was done.'],
    [{ kind: 'expired' as const }, HELD_EXPIRED_TEXT],
    [{ kind: 'working' as const }, 'Working on it...'],
    [{ kind: 'failed' as const, message: 'That did not go through. Try again in a moment.' }, /did not go through/],
  ])('shows %j without hiding what was asked', (status, text) => {
    renderCard({ status });
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText('Send a note to Ana?')).toBeInTheDocument();
  });

  it('takes the buttons away once the action is answered or has expired', () => {
    renderCard({ status: { kind: 'expired' } });
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(HELD_EXPIRED_TEXT).toBe('Expired, nothing was done. Ask again in chat.');
  });

  it('lets someone who cannot manage the chat read the card without answering it', () => {
    renderCard({ disabled: true });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  });

  it('shows a proposed calendar event in full, with whether guests are emailed', () => {
    renderCard(
      {},
      {
        plain_what: 'Add "Dentist" to your Google Calendar.',
        recipient: null,
        destination: null,
        destination_host: null,
        outbound_text: null,
        cannot_be_undone: null,
        calendar_event: {
          action: 'create',
          calendar: 'ada@example.com',
          title: 'Dentist',
          when: 'Monday, October 19, 2026, 9:00 am to 10:00 am',
          time_zone: 'America/New_York',
          duration: '1 hour',
          location: '',
          description: '',
          attendees: ['lin@example.com'],
          guests_emailed: false,
          one_of_repeating: false,
          before: null,
        },
      },
    );
    expect(screen.getByText('Exactly what will be saved')).toBeInTheDocument();
    expect(screen.getByText('Monday, October 19, 2026, 9:00 am to 10:00 am')).toBeInTheDocument();
    expect(screen.getByText('America/New_York')).toBeInTheDocument();
    expect(screen.getByText('Google will not email the guests about this.')).toBeInTheDocument();
  });
});

describe('HeldActionCard "Change it"', () => {
  it('shows Change it only with a handler, and sends the text as the change request', () => {
    const onChangeRequest = vi.fn();
    renderCard({ onChangeRequest });
    fireEvent.click(screen.getByRole('button', { name: 'Change it' }));
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'shorter please' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onChangeRequest).toHaveBeenCalledWith('shorter please');
  });

  it('shows no Change it without a handler', () => {
    renderCard();
    expect(screen.queryByRole('button', { name: 'Change it' })).not.toBeInTheDocument();
  });
});

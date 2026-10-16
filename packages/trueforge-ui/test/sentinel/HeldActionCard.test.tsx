// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HELD_EXPIRED_TEXT, HeldActionCard, type HeldActionCardProps } from '@/sentinel/HeldActionCard.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';

function card(overrides: Partial<SentinelApprovalCard> = {}): SentinelApprovalCard {
  return {
    plain_what: 'Send a note to Ana.',
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
    expect(text.indexOf('Exactly what will be sent')).toBeGreaterThan(text.indexOf('ana@example.com'));
    expect(screen.getByText(/Lunch at noon\?/)).toBeInTheDocument();
    const reason = screen.getByText("Aman's reason: It was on the Monday list.");
    expect(text.indexOf("Aman's reason")).toBeGreaterThan(text.indexOf('Exactly what will be sent'));
    expect(text.indexOf("Aman's reason")).toBeGreaterThan(text.indexOf("can't be unsent"));
    expect(reason).toBeInTheDocument();
  });

  it('shows plainly when part of the text is cut off', () => {
    renderCard({}, { outbound_truncated: true });
    expect(screen.getByText('Part of this is not shown in full. Check it before you approve.')).toBeInTheDocument();
  });

  it('shows the host line first when there is one, and nothing when there is not', () => {
    const first = render(
      <ul>
        <HeldActionCard
          card={card()}
          status={{ kind: 'waiting' }}
          alwaysAllowOffered={false}
          provenance="From the 7am brief, which read your email"
          onApprove={vi.fn()}
          onAlwaysAllow={vi.fn()}
          onDeny={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByText('From the 7am brief, which read your email')).toBeInTheDocument();
    first.unmount();
    renderCard();
    expect(document.querySelector('[data-role="held-action-provenance"]')).toBeNull();
  });

  it('offers Approve and Deny, and never a chat-wide or permanent refusal', () => {
    const { onApprove, onDeny } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /this chat/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Always deny/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();
  });

  it('offers Always allow only when the server said it may', () => {
    const { onAlwaysAllow } = renderCard({ alwaysAllowOffered: true });
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    expect(onAlwaysAllow).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: 'approved' as const }, 'Approved.'],
    [{ kind: 'denied' as const }, 'Denied. Nothing was done.'],
    [{ kind: 'expired' as const }, HELD_EXPIRED_TEXT],
    [{ kind: 'working' as const }, 'Working on it...'],
    [{ kind: 'failed' as const, message: 'That did not go through. Try again in a moment.' }, /did not go through/],
  ])('shows %j without hiding what was asked', (status, text) => {
    renderCard({ status });
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText('Send a note to Ana.')).toBeInTheDocument();
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
});

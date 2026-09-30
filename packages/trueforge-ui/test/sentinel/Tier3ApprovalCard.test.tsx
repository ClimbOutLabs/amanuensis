// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Tier3ApprovalCard } from '@/sentinel/Tier3ApprovalCard.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';

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
  };
}

function renderCard(overrides: Partial<SentinelApprovalCard> = {}) {
  const card: SentinelApprovalCard = { ...baseCard(), ...overrides };
  const onApprove = vi.fn();
  const onDeny = vi.fn();
  render(<Tier3ApprovalCard toolName="payment" card={card} onApprove={onApprove} onDeny={onDeny} />);
  return { onApprove, onDeny };
}

describe('Tier3ApprovalCard', () => {
  it('renders the server-supplied what, why, and details', () => {
    renderCard({
      destination: 'acme-corp',
      recipient: 'Acme Corp',
      amount: '$250',
      cannot_be_undone: 'The transfer cannot be reversed.',
      why_asked_again: 'the earlier approval expired',
    });
    expect(screen.getByText('Send $250 to Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('You asked the assistant to pay the invoice.')).toBeInTheDocument();
    expect(screen.getByText('Destination')).toBeInTheDocument();
    expect(screen.getByText('acme-corp')).toBeInTheDocument();
    expect(screen.getByText('Recipient')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('$250')).toBeInTheDocument();
    expect(screen.getByText('Cannot be undone: The transfer cannot be reversed.')).toBeInTheDocument();
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
  });

  it('calls Approve and Deny', () => {
    const { onApprove, onDeny } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});

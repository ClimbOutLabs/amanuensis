// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionApprovalCard, type PermissionApprovalCardProps } from '@/sentinel/PermissionApprovalCard.js';
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
    outbound_text: null,
    destination_host: null,
  };
}

function renderCard(overrides: Partial<SentinelApprovalCard> = {}, props: Partial<PermissionApprovalCardProps> = {}) {
  const card: SentinelApprovalCard = { ...baseCard(), ...overrides };
  const onApprove = vi.fn();
  const onDeny = vi.fn();
  render(
    <PermissionApprovalCard toolName="payment" card={card} tier={3} onApprove={onApprove} onDeny={onDeny} {...props} />,
  );
  return { onApprove, onDeny };
}

describe('PermissionApprovalCard', () => {
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
    expect(screen.getByText('Exactly what will be sent')).toBeInTheDocument();
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

  it('calls Approve and Deny', () => {
    const { onApprove, onDeny } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('labels the tier the server sent', () => {
    renderCard({}, { tier: 2 });
    expect(screen.getByText('Needs your OK')).toBeInTheDocument();
    expect(screen.queryByText('Review carefully')).not.toBeInTheDocument();
  });

  it('labels a Tier 3 card for careful review without tier jargon', () => {
    renderCard({}, { tier: 3 });
    expect(screen.getByText('Review carefully')).toBeInTheDocument();
    expect(screen.queryByText(/Tier \d/)).not.toBeInTheDocument();
  });

  it('offers Approve all only when the container passes a batch handler', () => {
    renderCard();
    expect(screen.queryByRole('button', { name: /Approve all/ })).not.toBeInTheDocument();
  });

  it('calls the batch handler from Approve all and shows how many calls it covers', () => {
    const onApproveAll = vi.fn();
    const { onApprove } = renderCard({}, { tier: 2, onApproveAll, batchSize: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Approve all (3)' }));
    expect(onApproveAll).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HeldActionCard } from '@/sentinel/HeldActionCard.js';
import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';

function baseCard(overrides: Partial<SentinelApprovalCard> = {}): SentinelApprovalCard {
  return {
    plain_what: 'Send the lunch note.',
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
    schedule: null,
    persona: null,
    ...overrides,
  };
}

const newRecipientCard = (): SentinelApprovalCard => baseCard({ mail_new_recipients: ['stranger@example.net'] });

describe('PermissionApprovalCard without a new recipient', () => {
  it('keeps the ordinary labels and the chat button on a card with no new recipient', () => {
    render(
      <PermissionApprovalCard
        approvalId="approval-1"
        othersWaiting={0}
        card={baseCard({ mail_new_recipients: null })}
        onApprove={vi.fn()}
        onApproveForChat={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Allow it' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Always allow this here' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add and send' })).not.toBeInTheDocument();
  });
});

describe('HeldActionCard for a new recipient', () => {
  it("labels the held card Add and send and Don't send, and offers no Always allow", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      <HeldActionCard
        card={newRecipientCard()}
        status={{ kind: 'waiting' }}
        alwaysAllowOffered
        onApprove={onApprove}
        onAlwaysAllow={vi.fn()}
        onDeny={onDeny}
        onChangeRequest={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Always allow this tool' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change it' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add and send' }));
    fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('keeps Always allow on a held card that has no new recipient', () => {
    render(
      <HeldActionCard
        card={baseCard({ mail_new_recipients: null })}
        status={{ kind: 'waiting' }}
        alwaysAllowOffered
        onApprove={vi.fn()}
        onAlwaysAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Always allow this tool' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
  });
});

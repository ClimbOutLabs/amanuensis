// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HeldActionCard } from '@/sentinel/HeldActionCard.js';
import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';

const NEW_RECIPIENT_TEXT =
  'New recipient. You have never emailed stranger@example.net. Approving adds them to your send list and sends. Send the lunch note.';

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

const newRecipientCard = (): SentinelApprovalCard =>
  baseCard({ plain_what: NEW_RECIPIENT_TEXT, mail_new_recipients: ['stranger@example.net'] });

describe('PermissionApprovalCard for a new recipient', () => {
  it('labels the three choices Add and send, Change it, and Cancel', () => {
    render(
      <PermissionApprovalCard
        toolName="send_email"
        card={newRecipientCard()}
        tier={3}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onChangeRequest={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Add and send' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change it' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
  });

  it('never offers Approve for this chat, even when the container passes a chat handler', () => {
    render(
      <PermissionApprovalCard
        toolName="send_email"
        card={newRecipientCard()}
        tier={3}
        onApprove={vi.fn()}
        onApproveForChat={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Approve for this chat' })).not.toBeInTheDocument();
  });

  it('calls onApprove from Add and send, and onDeny from Cancel', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      <PermissionApprovalCard
        toolName="send_email"
        card={newRecipientCard()}
        tier={3}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add and send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('shows the plain sentence that says approving adds the address and sends', () => {
    render(
      <PermissionApprovalCard
        toolName="send_email"
        card={newRecipientCard()}
        tier={3}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText(NEW_RECIPIENT_TEXT)).toBeInTheDocument();
  });

  it('keeps the ordinary labels and the chat button on a card with no new recipient', () => {
    render(
      <PermissionApprovalCard
        toolName="read_note"
        card={baseCard({ mail_new_recipients: null })}
        tier={2}
        onApprove={vi.fn()}
        onApproveForChat={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add and send' })).not.toBeInTheDocument();
  });
});

describe('HeldActionCard for a new recipient', () => {
  it('labels the held card Add and send and Cancel, and offers no Always allow', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
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

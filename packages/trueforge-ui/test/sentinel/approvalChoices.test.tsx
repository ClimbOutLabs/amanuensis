// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HeldActionCard } from '@/sentinel/HeldActionCard.js';
import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import { SentinelSettings } from '@/sentinel/SentinelSettings.js';
import type { SentinelApi, SentinelApprovalCard } from '@/sentinel/types.js';

const card: SentinelApprovalCard = {
  plain_what: 'Send a short note to the Example team',
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
};

const buttonNames = () => screen.getAllByRole('button').map(button => button.textContent);

describe('approval choices', () => {
  it('shows Approve, Approve for this chat, Deny in that order, and never Always deny', () => {
    render(
      <PermissionApprovalCard
        toolName="send_note"
        card={card}
        tier={2}
        onApprove={vi.fn()}
        onApproveForChat={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(buttonNames()).toEqual(['Approve', 'Approve for this chat', 'Deny']);
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveAttribute('title', 'Allow this one call only.');
    expect(screen.getByRole('button', { name: 'Approve for this chat' })).toHaveAttribute(
      'title',
      'Allow this kind of call for the rest of this chat.',
    );
    expect(screen.queryByText(/Always deny/i)).not.toBeInTheDocument();
  });

  it('shows Approve, Always allow, Deny in that order on a held action, and never Always deny', () => {
    render(
      <HeldActionCard
        card={card}
        status={{ kind: 'waiting' }}
        alwaysAllowOffered
        onApprove={vi.fn()}
        onAlwaysAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(buttonNames()).toEqual(['Approve', 'Always allow', 'Deny']);
    expect(screen.getByRole('button', { name: 'Always allow' })).toHaveAttribute(
      'title',
      'Remember this for every chat.',
    );
    expect(screen.queryByText(/Always deny/i)).not.toBeInTheDocument();
  });

  it('lists all four choices in order on the Settings permissions page, with no Always deny', async () => {
    const settings = {
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    };
    const api: SentinelApi = {
      listAuditEntries: vi.fn(async () => []),
      listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
      getUserSettings: vi.fn(async () => settings),
      updateUserSettings: vi.fn(async patch => ({ ...settings, ...patch })),
      listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
    };
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    const terms = (await screen.findAllByRole('term')).map(term => term.textContent);
    expect(terms).toEqual(['Approve', 'Approve for this chat', 'Always allow', 'Deny']);
    expect(screen.queryByText(/Always deny/i)).not.toBeInTheDocument();
  });
});

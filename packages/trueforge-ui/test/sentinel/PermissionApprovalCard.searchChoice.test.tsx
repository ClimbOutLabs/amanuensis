// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { holdSay, searchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';
import { describe, expect, it, vi } from 'vitest';

import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';

const SEARCH_CARD: SentinelApprovalCard = {
  plain_what: searchHoldCardText({
    summary: 'Find quiet coffee shops in San Francisco',
    say: holdSay('Aman').search_setting,
    page: false,
  }),
  plain_why: null,
  cannot_be_undone: null,
  why_asked_again: null,
  destination: 'search',
  recipient: null,
  amount: null,
  parsed_command: null,
  outbound_text:
    'query: "Find quiet coffee shops in San Francisco"\nsession_id: "sess-123"\nmodel_name: "search-model-1"',
  destination_host: null,
  outbound_truncated: false,
  outbound_plumbing_text: 'session_id: "sess-123"\nmodel_name: "search-model-1"',
  email: null,
  calendar_event: null,
  schedule: null,
  persona: null,
};

function renderSearch(onApproveForChat = vi.fn()) {
  render(
    <PermissionApprovalCard
      approvalId="approval-search"
      card={SEARCH_CARD}
      othersWaiting={0}
      onApprove={vi.fn()}
      onApproveForChat={onApproveForChat}
      onDeny={vi.fn()}
    />,
  );
  return { onApproveForChat };
}

describe('PermissionApprovalCard for a held search', () => {
  it('offers the one chat-wide choice, "Always allow this here", when the server allows it', () => {
    const { onApproveForChat } = renderSearch();
    fireEvent.click(screen.getByRole('button', { name: 'Always allow this here' }));
    expect(onApproveForChat).toHaveBeenCalledTimes(1);
  });

  it('shows the query in the Details block, with the service fields folded below it', () => {
    renderSearch();
    const details = screen.getByText('Details').closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Details'));
    const visible = screen.getByText('query: "Find quiet coffee shops in San Francisco"');
    expect(visible).toBeVisible();
    expect(visible.textContent).not.toContain('session_id');
    expect(screen.getByText('Search service details').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Also sent by the search service')).toBeInTheDocument();
    expect(screen.getByText(/session_id: "sess-123"/)).toBeInTheDocument();
  });
});

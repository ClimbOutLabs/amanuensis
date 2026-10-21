// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { HOLD_SAY, searchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';
import { describe, expect, it, vi } from 'vitest';

import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';

const SEARCH_CARD: SentinelApprovalCard = {
  plain_what: searchHoldCardText({ summary: 'Find quiet coffee shops in San Francisco', say: HOLD_SAY.private_read }),
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
      toolName="web_search"
      card={SEARCH_CARD}
      tier={3}
      onApprove={vi.fn()}
      onApproveForChat={onApproveForChat}
      onDeny={vi.fn()}
    />,
  );
  return { onApproveForChat };
}

describe('PermissionApprovalCard for a held search', () => {
  it('offers "Allow searches in this chat" in place of the generic chat choice', () => {
    const { onApproveForChat } = renderSearch();
    expect(screen.queryByRole('button', { name: 'Approve for this chat' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow searches in this chat' }));
    expect(onApproveForChat).toHaveBeenCalledTimes(1);
  });

  it('keeps the generic chat choice for a card that is not a search', () => {
    render(
      <PermissionApprovalCard
        toolName="payment"
        card={{ ...SEARCH_CARD, plain_what: 'Send $250 to Acme Corp' }}
        tier={3}
        onApprove={vi.fn()}
        onApproveForChat={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeInTheDocument();
  });

  it('shows the query in the visible block and folds the service fields behind Details', () => {
    renderSearch();
    const visible = screen.getByText('query: "Find quiet coffee shops in San Francisco"');
    expect(visible).toBeVisible();
    expect(visible.textContent).not.toContain('session_id');
    const details = screen.getByText('Details').closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('Also sent by the search service')).toBeInTheDocument();
    expect(screen.getByText(/session_id: "sess-123"/)).toBeInTheDocument();
  });
});

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
  skill: null,
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
  it('offers the one chat-wide choice, "Always allow in this chat", when the server allows it', () => {
    const { onApproveForChat } = renderSearch();
    fireEvent.click(screen.getByRole('button', { name: 'Always allow in this chat' }));
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

describe('PermissionApprovalCard for a held search with a long query', () => {
  const longQuery = Array.from({ length: 30 }, (_, index) => `word${String(index)}`)
    .join(' ')
    .repeat(2);
  // The server leads a search card with its whole question, query included, as the headline.
  const longWhat = searchHoldCardText({ summary: longQuery, say: holdSay('Aman').search_setting, page: false });
  const longCard: SentinelApprovalCard = {
    ...SEARCH_CARD,
    plain_what: longWhat,
    copy: { headline: longWhat, consequence: null, reason: null },
    outbound_text: `query: "${longQuery}"`,
    outbound_plumbing_text: null,
  };

  function renderLong() {
    render(
      <PermissionApprovalCard
        approvalId="approval-long-search"
        card={longCard}
        othersWaiting={0}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
  }

  it('folds the question so the buttons stay close, and shows all of it on request', () => {
    renderLong();
    const title = screen.getByRole('heading', { level: 3 });
    expect(Array.from(title.textContent ?? '')).toHaveLength(163);
    expect(title.textContent?.endsWith('...')).toBe(true);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Show all \(\d+ more characters\)$/ }));
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(longCard.plain_what);
  });

  it('keeps a short question whole, with nothing to unfold', () => {
    render(
      <PermissionApprovalCard
        approvalId="approval-short-search"
        card={{ ...SEARCH_CARD, copy: { headline: SEARCH_CARD.plain_what, consequence: null, reason: null } }}
        othersWaiting={0}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(SEARCH_CARD.plain_what);
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
  });
});

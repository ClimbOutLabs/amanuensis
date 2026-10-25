// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalNavContainer } from '@/containers/ApprovalNavContainer.js';
import { DEFAULT_ASSISTANT_NAME } from '@truefoundry/trueforge-core/core/personas/assistantName';

let pending: Array<{ approvalId: string }> = [];
let placement: 'checking' | 'on-screen' | 'off-screen' | 'missing' = 'off-screen';
const focus = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAnswerableApprovals.js', () => ({
  useAnswerableApprovals: () => ({ pending }),
}));

vi.mock('@/hooks/useApprovalCardPlacement.js', () => ({
  useApprovalCardPlacement: () => placement,
}));

vi.mock('@/containers/approvalFocus.js', () => ({
  useOptionalApprovalFocus: () => ({ focus }),
}));

vi.mock('@/sentinel/SentinelStateProvider.js', () => ({
  useOptionalSentinelState: () => ({
    approvalFor: () => ({
      card: {
        email: null,
        calendar_event: null,
        schedule: null,
        persona: null,
        plain_what: 'Send this reply?',
      },
    }),
  }),
}));

function renderStrip() {
  return render(
    <ApprovalNavContainer>
      {docked => <div data-testid="composer" data-docked={String(docked)} />}
    </ApprovalNavContainer>,
  );
}

describe('ApprovalNavContainer', () => {
  beforeEach(() => {
    focus.mockClear();
    pending = [{ approvalId: 'appr-1' }];
    placement = 'off-screen';
  });

  it('docks the strip above the composer only while the card is off screen', () => {
    const { rerender } = renderStrip();

    expect(screen.getByRole('status')).toHaveTextContent(
      `${DEFAULT_ASSISTANT_NAME} is waiting for your OK: Send this reply?`,
    );
    expect(screen.getByTestId('composer')).toHaveAttribute('data-docked', 'true');

    placement = 'on-screen';
    rerender(
      <ApprovalNavContainer>
        {docked => <div data-testid="composer" data-docked={String(docked)} />}
      </ApprovalNavContainer>,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer')).toHaveAttribute('data-docked', 'false');
  });

  it('shows the count instead of one card title when several approvals wait', () => {
    pending = [{ approvalId: 'appr-1' }, { approvalId: 'appr-2' }];
    renderStrip();

    expect(screen.getByRole('status')).toHaveTextContent('2 things are waiting for your OK');
    expect(screen.getByRole('status')).not.toHaveTextContent('Send this reply?');
  });

  it('scrolls to the first card and focuses it when Review is pressed', () => {
    renderStrip();

    fireEvent.click(screen.getByRole('button', { name: 'Review ↑' }));

    expect(focus).toHaveBeenCalledWith('appr-1', { focusPrimary: true });
  });

  it('shows nothing when no approval waits', () => {
    pending = [];
    renderStrip();

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer')).toHaveAttribute('data-docked', 'false');
  });
});

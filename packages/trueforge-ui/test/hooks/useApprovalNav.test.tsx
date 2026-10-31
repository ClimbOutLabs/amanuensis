// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useApprovals = vi.hoisted(() => vi.fn());
const focus = vi.hoisted(() => vi.fn());

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryApprovals: useApprovals,
}));

// Every pending approval sits on the newest message, which is the answerable one.
vi.mock('@assistant-ui/react', () => ({
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({
      thread: {
        messages: [
          {
            role: 'assistant',
            content: pending.map(item => ({
              type: 'tool-call',
              approval: { id: item.approvalId, approved: undefined },
            })),
          },
        ],
      },
    }),
}));

vi.mock('@/containers/approvalFocus.js', () => ({
  useOptionalApprovalFocus: () => ({ focus }),
}));

import { useApprovalNav } from '@/hooks/useApprovalNav.js';

type PendingApproval = {
  approvalId: string;
};

let pending: PendingApproval[];

describe('useApprovalNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending = [];
    useApprovals.mockImplementation(() => ({ pending }));
  });

  it('tracks the first pending approval and focuses it when it appears', () => {
    pending = [{ approvalId: 'A' }, { approvalId: 'B' }];
    const { result } = renderHook(() => useApprovalNav());

    expect(result.current.count).toBe(2);
    expect(result.current.currentId).toBe('A');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenLastCalledWith('A');
  });

  it('moves to the next approval when the first one resolves', () => {
    pending = [{ approvalId: 'A' }, { approvalId: 'B' }];
    const { result, rerender } = renderHook(() => useApprovalNav());

    pending = [{ approvalId: 'B' }];
    rerender();

    expect(result.current.currentId).toBe('B');
    expect(focus).toHaveBeenLastCalledWith('B');
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it('focuses the first approval again when asked', () => {
    pending = [{ approvalId: 'A' }];
    const { result } = renderHook(() => useApprovalNav());

    act(() => result.current.focusCurrent());

    expect(focus).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenLastCalledWith('A', { focusPrimary: true });
  });

  it('reports no approval when none waits', () => {
    const { result } = renderHook(() => useApprovalNav());

    expect(result.current.count).toBe(0);
    expect(result.current.currentId).toBeNull();
    expect(focus).not.toHaveBeenCalled();
  });
});

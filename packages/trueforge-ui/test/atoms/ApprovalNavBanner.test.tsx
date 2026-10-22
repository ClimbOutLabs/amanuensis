// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalNavBanner, approvalBannerLabel } from '@/atoms/ApprovalNavBanner.js';

describe('ApprovalNavBanner', () => {
  it('renders the count label and disables chevrons at the ends', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const onFocusCurrent = vi.fn();

    const { rerender } = render(
      <ApprovalNavBanner
        total={4}
        current={1}
        canPrev={false}
        canNext
        onPrev={onPrev}
        onNext={onNext}
        onFocusCurrent={onFocusCurrent}
      />,
    );

    expect(screen.getByText('4 items need your approval')).toBeTruthy();
    expect(screen.getByText('(1/4)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous approval' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next approval' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next approval' }));
    expect(onNext).toHaveBeenCalledOnce();

    rerender(
      <ApprovalNavBanner
        total={4}
        current={4}
        canPrev
        canNext={false}
        onPrev={onPrev}
        onNext={onNext}
        onFocusCurrent={onFocusCurrent}
      />,
    );
    expect(screen.getByRole('button', { name: 'Next approval' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous approval' })).not.toBeDisabled();
  });

  it('uses singular copy for one pending approval', () => {
    render(
      <ApprovalNavBanner
        total={1}
        current={1}
        canPrev={false}
        canNext={false}
        onPrev={() => {}}
        onNext={() => {}}
        onFocusCurrent={() => {}}
      />,
    );
    expect(screen.getByText('1 item needs your approval')).toBeTruthy();
  });

  it('focuses the current approval when the banner is clicked', () => {
    const onFocusCurrent = vi.fn();
    render(
      <ApprovalNavBanner
        total={3}
        current={2}
        canPrev
        canNext
        onPrev={() => {}}
        onNext={() => {}}
        onFocusCurrent={onFocusCurrent}
      />,
    );

    fireEvent.click(screen.getByRole('status'));
    expect(onFocusCurrent).toHaveBeenCalledOnce();
  });

  it('does not focus when chevrons are clicked', () => {
    const onFocusCurrent = vi.fn();
    const onNext = vi.fn();
    render(
      <ApprovalNavBanner
        total={3}
        current={1}
        canPrev={false}
        canNext
        onPrev={() => {}}
        onNext={onNext}
        onFocusCurrent={onFocusCurrent}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next approval' }));
    expect(onNext).toHaveBeenCalledOnce();
    expect(onFocusCurrent).not.toHaveBeenCalled();
  });
});

describe('approvalBannerLabel', () => {
  it('names the kind when exactly one item waits', () => {
    expect(approvalBannerLabel(1, 'email')).toBe('1 email waiting for your approval');
  });

  it('falls back to the plain count when the kind is not known', () => {
    expect(approvalBannerLabel(1, undefined)).toBe('1 item needs your approval');
  });

  it('counts the items when more than one waits, whatever the kind', () => {
    expect(approvalBannerLabel(2, 'email')).toBe('2 items need your approval');
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalNavBanner, approvalBannerLabel } from '@/atoms/ApprovalNavBanner.js';

describe('ApprovalNavBanner', () => {
  it('names the assistant and the card title for one waiting approval', () => {
    render(<ApprovalNavBanner total={1} assistantName="Mannie" title="Send this reply?" onFocusCurrent={() => {}} />);

    const strip = screen.getByRole('status');
    expect(strip).toHaveTextContent('Mannie is waiting for your OK: Send this reply?');
    expect(strip).toHaveTextContent('Review ↑');
  });

  it('counts the items when more than one waits, with no counter or arrows', () => {
    render(<ApprovalNavBanner total={3} assistantName="Mannie" title="Send this reply?" onFocusCurrent={() => {}} />);

    expect(screen.getByRole('status')).toHaveTextContent('3 things are waiting for your OK');
    expect(screen.queryByText(/\(\d+\/\d+\)/)).toBeNull();
    expect(screen.queryByRole('button', { name: /approval/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send this reply?' })).toBeNull();
  });

  it('scrolls to the first card when Review is pressed', () => {
    const onFocusCurrent = vi.fn();
    render(
      <ApprovalNavBanner total={1} assistantName="Mannie" title="Send this reply?" onFocusCurrent={onFocusCurrent} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review ↑' }));

    expect(onFocusCurrent).toHaveBeenCalledOnce();
  });

  it('sets the card title apart by weight, at the banner size, with no serif and no size jump', () => {
    render(<ApprovalNavBanner total={1} assistantName="Mannie" title="Send this reply?" onFocusCurrent={() => {}} />);

    const title = screen.getByText('Send this reply?');
    expect(title).toHaveClass('font-semibold');
    expect(title).not.toHaveClass('font-serif');
    expect(title.className).not.toMatch(/text-\[|font-serif/);
  });
});

describe('approvalBannerLabel', () => {
  it('uses the assistant name for one item', () => {
    expect(approvalBannerLabel({ total: 1, assistantName: 'Mannie' })).toBe('Mannie is waiting for your OK:');
  });

  it('counts the items when there are several', () => {
    expect(approvalBannerLabel({ total: 2, assistantName: 'Mannie' })).toBe('2 things are waiting for your OK');
  });
});

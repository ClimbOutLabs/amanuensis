import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ScrollToBottomButton } from '@/atoms/ScrollToBottomButton.js';

describe('ScrollToBottomButton', () => {
  it('forwards button props, invokes clicks, and exposes its positioning wrapper ref', () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLSpanElement>();
    render(<ScrollToBottomButton ref={ref} onClick={onClick} className="host-scroll-button" data-track="scroll" />);

    const button = screen.getByRole('button', { name: 'Scroll to bottom' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('title', 'Scroll to bottom');
    expect(button).toHaveAttribute('data-track', 'scroll');
    expect(button).toHaveClass('aui-thread-scroll-to-bottom', 'host-scroll-button');
    expect(button.querySelector('svg')).toHaveClass('lucide-arrow-down');
    expect(ref.current).toBe(button.parentElement);

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('sits in the composer flow, not floating over the message list', () => {
    render(<ScrollToBottomButton onClick={vi.fn()} />);

    const button = screen.getByRole('button', { name: 'Scroll to bottom' });
    const wrapper = button.parentElement;
    // A floating wrapper (absolute, raised above the composer) lands on the bottom of the
    // message list, over a waiting approval card's buttons. In flow it can cover nothing.
    expect(wrapper).not.toHaveClass('absolute', '-top-14', 'z-10');
    expect(wrapper).toHaveClass('flex', 'justify-center');
  });

  it('does not render while disabled', () => {
    const onClick = vi.fn();
    const { container } = render(<ScrollToBottomButton disabled onClick={onClick} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).not.toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();
  });
});

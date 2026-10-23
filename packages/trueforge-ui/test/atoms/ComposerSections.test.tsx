import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ComposerLeftSection, ComposerRightSection, ComposerSendButton } from '@/atoms/ComposerSections.js';

describe('ComposerLeftSection', () => {
  it('opens a round plus menu that holds attach and work on a repo', () => {
    const onAttach = vi.fn();
    const onWorkOnRepo = vi.fn();
    render(
      <ComposerLeftSection
        disabled={false}
        isRunning={false}
        onAttach={onAttach}
        workOnRepo={{ id: 'work-on-repo', label: 'Work on a repo', icon: 'folder', onSelect: onWorkOnRepo }}
      />,
    );

    const plus = screen.getByRole('button', { name: 'Add' });
    expect(plus).toHaveAttribute('type', 'button');
    expect(plus).toHaveAttribute('title', 'Add');
    fireEvent.click(plus);

    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map(item => item.textContent)).toEqual(['Attach a file', 'Work on a repo']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Attach a file' }));
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it('renders nothing when there is no attach handler and no repo entry', () => {
    const { container } = render(<ComposerLeftSection disabled isRunning />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ComposerRightSection', () => {
  it('reserves no default UI in either idle or running state', () => {
    const { container, rerender } = render(<ComposerRightSection disabled={false} isRunning={false} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<ComposerRightSection disabled isRunning />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ComposerSendButton', () => {
  it('is muted and does not submit while the composer is empty', () => {
    const onSubmit = vi.fn();
    render(<ComposerSendButton disabled={false} canSubmit={false} isRunning={false} onSubmit={onSubmit} />);

    const button = screen.getByRole('button', { name: 'Send message' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('data-state', 'muted');
    expect(button).toHaveClass('bg-secondary-bg');
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is filled with the accent and submits once there is text', () => {
    const onSubmit = vi.fn();
    render(<ComposerSendButton disabled={false} canSubmit isRunning={false} onSubmit={onSubmit} />);

    const button = screen.getByRole('button', { name: 'Send message' });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('data-state', 'ready');
    expect(button).toHaveAttribute('title', 'Send message');
    expect(button).toHaveClass('bg-primary-button-bg');
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('becomes a round Stop button while a reply runs and delegates to cancel', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<ComposerSendButton disabled={false} canSubmit isRunning onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toHaveAttribute('title', 'Stop');
    expect(stop).toHaveAttribute('data-state', 'stop');
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows Stopping and stays disabled after Stop was pressed', () => {
    const onCancel = vi.fn();
    render(
      <ComposerSendButton disabled={false} canSubmit isRunning isStopping onSubmit={vi.fn()} onCancel={onCancel} />,
    );

    const stopping = screen.getByRole('button', { name: 'Stopping' });
    expect(stopping).toBeDisabled();
    fireEvent.click(stopping);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('disables Stop when no cancel handler is supplied', () => {
    render(<ComposerSendButton disabled={false} canSubmit isRunning onSubmit={() => {}} />);

    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });
});

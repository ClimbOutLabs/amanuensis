import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ComposerLeftSection, ComposerRightSection, ComposerSendButton } from '@/atoms/ComposerSections.js';

describe('ComposerLeftSection', () => {
  it('offers attaching files from the one plus menu', async () => {
    const onAttach = vi.fn();
    render(<ComposerLeftSection disabled={false} isRunning={false} onAttach={onAttach} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Attach files' }));

    expect(onAttach).toHaveBeenCalledOnce();
  });

  it('renders nothing when attachment handling is unavailable', () => {
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
  it('disables submission until the composer can submit', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <ComposerSendButton disabled={false} canSubmit={false} isRunning={false} onSubmit={onSubmit} />,
    );

    const unavailableButton = screen.getByRole('button', { name: 'Send message' });
    expect(unavailableButton).toBeDisabled();
    fireEvent.click(unavailableButton);
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(<ComposerSendButton disabled={false} canSubmit isRunning={false} onSubmit={onSubmit} />);
    const availableButton = screen.getByRole('button', { name: 'Send message' });
    expect(availableButton).toBeEnabled();
    expect(availableButton).toHaveAttribute('title', 'Send message');
    fireEvent.click(availableButton);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('shows a disabled Stopping action after Stop was pressed', () => {
    const onCancel = vi.fn();
    render(
      <ComposerSendButton disabled={false} canSubmit isRunning isStopping onSubmit={vi.fn()} onCancel={onCancel} />,
    );

    const stopping = screen.getByRole('button', { name: 'Stopping' });
    expect(stopping).toBeDisabled();
    fireEvent.click(stopping);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('becomes Stop while running and leaves Send out of the bar', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<ComposerSendButton disabled={false} canSubmit isRunning onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toHaveAttribute('title', 'Stop (Esc)');
    fireEvent.click(stop);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables Stop when no cancel handler is supplied', () => {
    render(<ComposerSendButton disabled={false} canSubmit isRunning onSubmit={() => {}} />);

    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });
});

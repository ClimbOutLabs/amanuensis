import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ComposerShell } from '@/atoms/ComposerShell.js';

describe('ComposerShell', () => {
  it('composes input, attachments, and idle actions in one box', () => {
    const onAttach = vi.fn();
    const onSubmit = vi.fn();
    const { container } = render(
      <ComposerShell
        input={<textarea aria-label="Message" defaultValue="Hello" />}
        attachments={<div>design.png</div>}
        disabled={false}
        canSubmit
        onAttach={onAttach}
        onSubmit={onSubmit}
        className="consumer-class"
      />,
    );

    const shell = container.querySelector('[data-slot="aui_composer-shell"]');
    expect(shell).toHaveClass('consumer-class');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Hello');
    expect(screen.getByText('design.png')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach a file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onAttach).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('shows the running stop action and delegates cancellation', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ComposerShell
        input={<textarea aria-label="Message" />}
        disabled
        canSubmit={false}
        isRunning
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
    const stopButton = screen.getByRole('button', { name: 'Stop' });
    expect(stopButton).toBeEnabled();
    fireEvent.click(stopButton);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('omits the plus menu when attachment handling and repo work are absent', () => {
    render(
      <ComposerShell input={<input aria-label="Message" />} disabled={false} canSubmit={false} onSubmit={() => {}} />,
    );

    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
});

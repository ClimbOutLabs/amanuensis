import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ComposerShell } from '@/atoms/ComposerShell.js';

describe('ComposerShell', () => {
  it('says Working on it while a reply runs, and adds whole minutes once it passes one', () => {
    vi.useFakeTimers();
    try {
      render(
        <ComposerShell
          input={<textarea aria-label="Message" />}
          disabled={false}
          canSubmit={false}
          isRunning
          onSubmit={() => undefined}
        />,
      );
      expect(screen.getByRole('status')).toHaveTextContent(/^Working on it$/);

      act(() => {
        vi.advanceTimersByTime(125_000);
      });
      expect(screen.getByRole('status')).toHaveTextContent('Working on it, 2 min');
    } finally {
      vi.useRealTimers();
    }
  });

  it('composes input, attachments, the status, and Send', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <ComposerShell
        input={<textarea aria-label="Message" defaultValue="Hello" />}
        attachments={<div>design.png</div>}
        disabled={false}
        canSubmit
        connectorStatusLabel="Connected"
        onSubmit={onSubmit}
        className="consumer-class"
      />,
    );

    const shell = container.querySelector('[data-slot="aui_composer-shell"]');
    expect(shell).toHaveClass('consumer-class');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Hello');
    expect(screen.getByText('design.png')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('shows the gold status next to the plus while a turn runs, and hides the model text', () => {
    const onCancel = vi.fn();
    render(
      <ComposerShell
        input={<textarea aria-label="Message" />}
        disabled
        canSubmit={false}
        isRunning
        modelLabel="GPT 5"
        onSubmit={() => {}}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Working on it');
    expect(screen.queryByText('GPT 5')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('omits optional composer chrome when labels and attachment handling are absent', () => {
    render(
      <ComposerShell input={<input aria-label="Message" />} disabled={false} canSubmit={false} onSubmit={() => {}} />,
    );

    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
});

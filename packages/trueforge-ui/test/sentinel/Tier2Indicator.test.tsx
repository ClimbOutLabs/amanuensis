// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Tier2Indicator } from '@/sentinel/Tier2Indicator.js';
import type { Tier2Notice } from '@/sentinel/types.js';

function renderNotice(notice: Partial<Tier2Notice> = {}) {
  const onUndo = vi.fn(async () => {});
  const onStop = vi.fn(async () => {});
  render(
    <Tier2Indicator
      notice={{
        toolCallId: 'call-1',
        message: 'Wrote 3 files in src/',
        kind: 'file_write',
        undoable: false,
        stoppable: false,
        tracked_files: [],
        notice_id: 'call-1',
        ...notice,
      }}
      onUndo={onUndo}
      onStop={onStop}
    />,
  );
  return { onUndo, onStop };
}

describe('Tier2Indicator', () => {
  it('names what ran and lists tracked files', () => {
    renderNotice({ tracked_files: ['src/a.ts', 'src/b.ts'] });
    expect(screen.getByText('Wrote 3 files in src/')).toBeInTheDocument();
    expect(screen.getByText('Tracked files: src/a.ts, src/b.ts')).toBeInTheDocument();
  });

  it('omits the tracked-files line when the server named none', () => {
    renderNotice();
    expect(screen.queryByText(/Tracked files:/)).not.toBeInTheDocument();
  });

  it('offers Undo only when the action is undoable', () => {
    renderNotice({ undoable: true, stoppable: false });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('offers Stop only when the action is stoppable', () => {
    renderNotice({ undoable: false, stoppable: true });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('offers both when the server marked both', () => {
    renderNotice({ undoable: true, stoppable: true });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('calls onUndo and onStop', async () => {
    const { onUndo, onStop } = renderNotice({ undoable: true, stoppable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    // The second click must wait for the undo promise to settle and clear the busy state.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('shows the failure message when undo rejects', async () => {
    const onUndo = vi.fn(async () => {
      throw new Error('Undo window expired.');
    });
    const onStop = vi.fn(async () => {});
    render(
      <Tier2Indicator
        notice={{
          toolCallId: 'call-2',
          message: 'Wrote a file',
          kind: 'file_write',
          undoable: true,
          stoppable: false,
          tracked_files: [],
          notice_id: 'call-2',
        }}
        onUndo={onUndo}
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Undo window expired.');
  });
});

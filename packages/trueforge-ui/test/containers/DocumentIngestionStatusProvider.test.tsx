// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const useAuiState = vi.fn();

vi.mock('@assistant-ui/core/react', () => ({
  useThreadIsRunning: () => false,
}));

vi.mock('@/assistant-ui.js', () => ({
  useAuiState: (selector: (state: unknown) => unknown) => useAuiState(selector),
}));

import type { DocumentIngestionApi, DocumentIngestionLiveEvent } from '@/components/DocumentIngestionContext.js';
import { DocumentIngestionProvider } from '@/components/DocumentIngestionContext.js';
import {
  DocumentIngestionStatusProvider,
  useDocumentIngestionStatusLine,
} from '@/containers/DocumentIngestionStatusProvider.js';

useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
  selector({ threadListItem: { remoteId: 'sess-1' } }),
);

function Probe({ turnId }: { turnId: string }) {
  const statusLine = useDocumentIngestionStatusLine(turnId);
  return <span data-testid="status-line">{statusLine ?? 'none'}</span>;
}

function renderProvider(api: DocumentIngestionApi) {
  return render(
    <DocumentIngestionProvider api={api}>
      <DocumentIngestionStatusProvider>
        <Probe turnId="trn_1" />
      </DocumentIngestionStatusProvider>
    </DocumentIngestionProvider>,
  );
}

describe('DocumentIngestionStatusProvider', () => {
  it('shows the status line on a started event and clears it on the terminal event, with no timers', async () => {
    let listener: ((event: DocumentIngestionLiveEvent) => void) | undefined;
    const listDocumentIngestionTurnContext = vi.fn().mockResolvedValue([]);
    const subscribeToDocumentIngestion = vi.fn((l: (event: DocumentIngestionLiveEvent) => void) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    });

    renderProvider({ listDocumentIngestionTurnContext, subscribeToDocumentIngestion });

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('status-line')).toHaveTextContent('none');
    expect(listener).toBeDefined();

    act(() => {
      listener?.({ turnId: 'trn_1', fileName: 'report.pdf', phase: 'started' });
    });
    expect(screen.getByTestId('status-line')).toHaveTextContent('Reading report.pdf ...');

    act(() => {
      listener?.({ turnId: 'trn_1', fileName: 'report.pdf', phase: 'finished' });
    });
    expect(screen.getByTestId('status-line')).toHaveTextContent('none');

    // No REST refresh beyond the initial history load — this is push-only, not a poll.
    expect(listDocumentIngestionTurnContext).toHaveBeenCalledTimes(1);
  });

  it('never renders a status line for a different turn', async () => {
    let listener: ((event: DocumentIngestionLiveEvent) => void) | undefined;
    const listDocumentIngestionTurnContext = vi.fn().mockResolvedValue([]);
    const subscribeToDocumentIngestion = vi.fn((l: (event: DocumentIngestionLiveEvent) => void) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    });

    renderProvider({ listDocumentIngestionTurnContext, subscribeToDocumentIngestion });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      listener?.({ turnId: 'trn_other', fileName: 'other.pdf', phase: 'started' });
    });
    expect(screen.getByTestId('status-line')).toHaveTextContent('none');
  });
});

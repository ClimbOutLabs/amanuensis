// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MemoryVaultFactsPanel } from '@/atoms/memory/MemoryVaultPanels.js';
import { useMemoryVaultState } from '@/atoms/memory/useMemoryVaultState.js';
import type {
  MemoryVaultCatalog,
  MemoryVaultReviewNote,
  MemoryVaultReviewResult,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

const NOTE_A: MemoryVaultReviewNote = {
  entryId: 'md:default:2026-10-02.md#0',
  day: '2026-10-02',
  text: 'Likes tea.',
  chatTitle: 'Tea chat',
};
const NOTE_B: MemoryVaultReviewNote = {
  entryId: 'md:default:2026-10-02.md#1',
  day: '2026-10-02',
  text: 'Lives in Lisbon.',
  chatTitle: null,
};

function createCatalog({ notes, result }: { notes: MemoryVaultReviewNote[]; result: MemoryVaultReviewResult }) {
  const markReviewNotes = vi.fn(async () => result);
  const catalog: MemoryVaultCatalog = {
    listEntries: async namespace =>
      namespace === undefined
        ? [{ id: 'x', text: 'Drinks tea.', timestamp: new Date().toISOString(), persona: null }]
        : [],
    getSummaryStatus: async () => ({ summaryPending: false }),
    updateEntry: async () => {
      throw new Error('not used in these tests');
    },
    deleteEntry: async () => undefined,
    exportEntries: async () => ({ namespace: '', exportedAt: '', entries: [] }),
    importEntries: async () => ({ namespace: '', imported: 0 }),
    getSharing: async () => ({ shares: {} }),
    updateSharing: async sharing => sharing,
    listReviewNotes: async ({ namespace }) => ({ notes: namespace === undefined ? notes : [], nextCursor: null }),
    markReviewNotes,
  };
  return { catalog, markReviewNotes };
}

function Shell({ catalog, children }: { catalog: MemoryVaultCatalog; children: ReactNode }) {
  const server = { ...createMockAgentUIServer({ catalog: createMockCatalog() }), memoryVault: catalog };
  return <ServerProvider server={server}>{children}</ServerProvider>;
}

function Harness() {
  const state = useMemoryVaultState();
  return <MemoryVaultFactsPanel state={state} />;
}

function renderPanel(options: Parameters<typeof createCatalog>[0]) {
  const fake = createCatalog(options);
  render(
    <Shell catalog={fake.catalog}>
      <Harness />
    </Shell>,
  );
  return fake;
}

const NOTICE =
  'Some older notes have no record of where they came from. Aman treats them as external until you say they are yours.';

describe('review of older notes', () => {
  it('shows the notice only when there are notes to review', async () => {
    renderPanel({ notes: [], result: { markedIds: [], refused: [] } });
    await screen.findByText('Drinks tea.');
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review older notes' })).toBeNull();
  });

  it('offers the review, with nothing ticked at the start', async () => {
    renderPanel({ notes: [NOTE_A, NOTE_B], result: { markedIds: [], refused: [] } });
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review older notes' }));

    expect(await screen.findByRole('heading', { name: 'Review older notes' })).toBeInTheDocument();
    expect(screen.getByText(/2026-10-02 · Tea chat/)).toBeInTheDocument();
    expect(screen.getByText('Likes tea.')).toBeInTheDocument();
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box).not.toBeChecked();
    }
    expect(screen.getByRole('button', { name: 'Mark the ticked notes as from me' })).toBeDisabled();
    expect(
      screen.getByText(
        'Aman will treat these notes as your own words. It will act on them without asking as it does for things it read.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Some older notes are not listed here/)).toBeInTheDocument();
  });

  it('sends only the ticked ids, then says how many were marked and shows each refusal', async () => {
    const { markReviewNotes } = renderPanel({
      notes: [NOTE_A, NOTE_B],
      result: {
        markedIds: [NOTE_A.entryId],
        refused: [{ entryId: NOTE_B.entryId, reason: 'Its chat is gone or cannot be read, so it stays external.' }],
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review older notes' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Tea chat/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Mark the ticked notes as from me' }));

    await waitFor(() => expect(markReviewNotes).toHaveBeenCalledTimes(1));
    expect(markReviewNotes).toHaveBeenCalledWith({ entryIds: [NOTE_A.entryId] });
    expect(await screen.findByText('1 note marked as from you.')).toBeInTheDocument();
    expect(screen.getByText('Its chat is gone or cannot be read, so it stays external.')).toBeInTheDocument();
    // The marked note leaves the list; the refused one stays.
    expect(screen.queryByText('Likes tea.')).toBeNull();
    expect(screen.getByText('Lives in Lisbon.')).toBeInTheDocument();
  });

  it('ticks every note on the page on request, and sends them all', async () => {
    const { markReviewNotes } = renderPanel({
      notes: [NOTE_A, NOTE_B],
      result: { markedIds: [NOTE_A.entryId, NOTE_B.entryId], refused: [] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review older notes' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Tick all on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark the ticked notes as from me' }));

    await waitFor(() => expect(markReviewNotes).toHaveBeenCalledWith({ entryIds: [NOTE_A.entryId, NOTE_B.entryId] }));
    expect(await screen.findByText('2 notes marked as from you.')).toBeInTheDocument();
    expect(screen.getByText('No older notes are waiting for review.')).toBeInTheDocument();
  });

  it('goes back to the memories', async () => {
    renderPanel({ notes: [NOTE_A], result: { markedIds: [], refused: [] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Review older notes' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Back to memories' }));

    expect(await screen.findByText('Drinks tea.')).toBeInTheDocument();
  });
});

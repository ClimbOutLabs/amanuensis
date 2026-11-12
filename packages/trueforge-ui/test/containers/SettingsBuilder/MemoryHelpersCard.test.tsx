// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MemoryHelpersCard } from '@/containers/SettingsBuilder/MemoryHelpersCard.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

type Mode = 'off' | 'report' | 'on';

/** The trueforge adapter's two ports, backed by memory so a save reads back as the server would answer. */
function renderCard({
  mode = 'off',
  enabled = false,
  withPorts = true,
  failSave = false,
}: {
  mode?: Mode;
  enabled?: boolean;
  withPorts?: boolean;
  failSave?: boolean;
} = {}) {
  const modeWrites: Mode[] = [];
  const enabledWrites: boolean[] = [];
  const sorting = (next: Mode) => ({
    mode: next,
    overridden: true,
    defaultMode: 'off' as const,
    effectiveMode: next,
  });
  const nightly = (next: boolean) => ({
    enabled: next,
    overridden: true,
    defaultEnabled: false,
    effectiveEnabled: next,
  });
  const ports = withPorts
    ? {
        memoryPageSorting: {
          getMemoryPageSorting: async () => sorting(mode),
          setMemoryPageSortingMode: async (next: Mode) => {
            if (failSave) throw new Error('The server is busy. Try again in a moment.');
            modeWrites.push(next);
            return sorting(next);
          },
        },
        memoryNightly: {
          getMemoryNightly: async () => nightly(enabled),
          setMemoryNightlyEnabled: async (next: boolean) => {
            enabledWrites.push(next);
            return nightly(next);
          },
        },
      }
    : {};
  const server = { ...createMockAgentUIServer({ catalog: createMockCatalog() }), ...ports };
  render(
    <ServerProvider server={server}>
      <MemoryHelpersCard />
    </ServerProvider>,
  );
  return { modeWrites, enabledWrites };
}

describe('MemoryHelpersCard', () => {
  it('shows both controls off, with a sentence for each sorting choice and for the tidy-up', async () => {
    renderCard();

    expect(await screen.findByText('Sort what Aman saves onto pages')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Off/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Only note what it would do/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /^On(?!ly)/ })).not.toBeChecked();
    expect(screen.getByText(/does not sort anything onto pages/)).toBeInTheDocument();
    expect(screen.getByText(/writes that down\. It changes no pages/)).toBeInTheDocument();
    expect(screen.getByText(/can only ever be added as not confirmed/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Tidy pages once a day' })).not.toBeChecked();
    expect(
      screen.getByText(/moves lines that have ended to Earlier, sorts notes that were missed/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/uses the model while you are not chatting/)).toHaveLength(2);
  });

  it('saves the chosen sorting mode', async () => {
    const { modeWrites } = renderCard();
    const report = await screen.findByRole('radio', { name: /^Only note what it would do/ });
    await waitFor(() => {
      expect(report).toBeEnabled();
    });

    fireEvent.click(report);

    await waitFor(() => {
      expect(modeWrites).toEqual(['report']);
    });
    await waitFor(() => {
      expect(report).toBeChecked();
    });
  });

  it('shows the stored sorting mode and saves the switch', async () => {
    const { enabledWrites } = renderCard({ mode: 'on', enabled: false });
    expect(await screen.findByRole('radio', { name: /^On(?!ly)/ })).toBeChecked();
    const toggle = screen.getByRole('switch', { name: 'Tidy pages once a day' });
    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(enabledWrites).toEqual([true]);
    });
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
  });

  it('says what to do when a save fails, and keeps the old choice', async () => {
    renderCard({ failSave: true });
    const report = await screen.findByRole('radio', { name: /^Only note what it would do/ });
    await waitFor(() => {
      expect(report).toBeEnabled();
    });

    fireEvent.click(report);

    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in a moment.');
    expect(screen.getByRole('radio', { name: /^Off/ })).toBeChecked();
  });

  it('hides the card when the server has no such ports', () => {
    renderCard({ withPorts: false });
    expect(screen.queryByText('Sort what Aman saves onto pages')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Tidy pages once a day' })).not.toBeInTheDocument();
  });
});

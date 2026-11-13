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
  tidy = { status: 'ran' as const, movedToEarlier: 2, notesSorted: 1, pairsListed: 0 },
}: {
  tidy?: { status: 'ran' | 'busy'; movedToEarlier: number; notesSorted: number; pairsListed: number };
  mode?: Mode;
  enabled?: boolean;
  withPorts?: boolean;
  failSave?: boolean;
} = {}) {
  const modeWrites: Mode[] = [];
  const enabledWrites: boolean[] = [];
  const hourWrites: number[] = [];
  let hour = 0;
  const sorting = (next: Mode) => ({
    mode: next,
    overridden: true,
    defaultMode: 'off' as const,
  });
  let nightlyEnabled = enabled;
  const nightly = () => ({
    enabled: nightlyEnabled,
    overridden: true,
    defaultEnabled: false,
    hour,
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
          getMemoryNightly: async () => nightly(),
          setMemoryNightly: async (change: { enabled?: boolean; hour?: number }) => {
            if (change.enabled !== undefined) {
              enabledWrites.push(change.enabled);
              nightlyEnabled = change.enabled;
            }
            if (change.hour !== undefined) {
              hourWrites.push(change.hour);
              hour = change.hour;
            }
            return nightly();
          },
          tidyMemoryNow: async () => tidy,
        },
      }
    : {};
  const server = { ...createMockAgentUIServer({ catalog: createMockCatalog() }), ...ports };
  render(
    <ServerProvider server={server}>
      <MemoryHelpersCard />
    </ServerProvider>,
  );
  return { modeWrites, enabledWrites, hourWrites };
}

async function renderCardAndTidy(tidy: NonNullable<Parameters<typeof renderCard>[0]>['tidy']) {
  renderCard({ tidy });
  fireEvent.click(await screen.findByRole('button', { name: 'Tidy now' }));
  return screen.findByRole('status');
}

describe('MemoryHelpersCard', () => {
  it('shows both controls off, with a sentence for each sorting choice and for the tidy-up', async () => {
    renderCard();

    expect(await screen.findByText('Sort what Aman saves onto pages')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Off/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Only note what it would do/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /^On(?!ly)/ })).not.toBeChecked();
    expect(screen.getByText(/Nothing is filed for you/)).toBeInTheDocument();
    expect(screen.getByText(/A trial run\..*changes no pages/)).toBeInTheDocument();
    expect(screen.getByText(/added as not confirmed until you confirm it/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Tidy pages once a day' })).not.toBeChecked();
    expect(screen.getByText(/moves facts that are over, such as a trip that has ended/)).toBeInTheDocument();
    expect(
      screen.getByText(/files any saved notes that were not filed yet, if sorting above is on/),
    ).toBeInTheDocument();
    expect(screen.getByText(/points out two facts that cannot both be true/)).toBeInTheDocument();
    expect(screen.getByText('It never deletes anything.')).toBeInTheDocument();
    expect(screen.getByText(/Both are off until you turn them on/)).toBeInTheDocument();
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

  it('starts at midnight and saves another hour', async () => {
    const { hourWrites, enabledWrites } = renderCard();
    const picker = await screen.findByLabelText('Start the daily tidy-up at');
    await waitFor(() => {
      expect(picker).toBeEnabled();
    });
    expect(picker).toHaveValue('0');
    expect(screen.getByRole('option', { name: '12:00 AM (midnight)' })).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: '21' } });

    await waitFor(() => {
      expect(hourWrites).toEqual([21]);
    });
    await waitFor(() => {
      expect(picker).toHaveValue('21');
    });
    expect(enabledWrites).toEqual([]);
  });

  it('tidies now and says what was done', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Tidy now' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Done. Aman moved 2 ended lines to Earlier and sorted 1 note onto pages.',
    );
  });

  it('says so when nothing needed tidying', async () => {
    const first = renderCardAndTidy({ status: 'ran', movedToEarlier: 0, notesSorted: 0, pairsListed: 0 });
    expect(await first).toHaveTextContent('Done. Nothing needed tidying.');
  });

  it('says to try again when a tidy-up is already running', async () => {
    const status = renderCardAndTidy({ status: 'busy', movedToEarlier: 0, notesSorted: 0, pairsListed: 0 });
    expect(await status).toHaveTextContent('A tidy-up is already running. Try again in a few minutes.');
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

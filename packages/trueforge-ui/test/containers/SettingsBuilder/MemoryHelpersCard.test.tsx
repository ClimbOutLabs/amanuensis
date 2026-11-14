// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MemoryHelpersCard } from '@/containers/SettingsBuilder/MemoryHelpersCard.js';
import type { MemoryTidyRun } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryHelpersCatalog.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

type Mode = 'off' | 'report' | 'on';

const QUIET_RUN: MemoryTidyRun = {
  status: 'ran',
  movedToEarlier: 0,
  notesAsked: 0,
  notesSorted: 0,
  pairsListed: 0,
  sorting: 'on',
  modelMissing: false,
  unsortedReasons: [],
};

/** The trueforge adapter's two ports, backed by memory so a save reads back as the server would answer. */
function renderCard({
  mode = 'off',
  enabled = false,
  withPorts = true,
  failSave = false,
  tidy = { ...QUIET_RUN, movedToEarlier: 2, notesAsked: 1, notesSorted: 1 },
  tidyState = () => ({ ...QUIET_RUN, status: 'idle' }),
}: {
  /** What the server says about a tidy-up when the page asks, until one is started here. */
  tidyState?: () => MemoryTidyRun;
  /** How a tidy-up started here ends; `null` to keep following `tidyState`. */
  tidy?: MemoryTidyRun | null;
  mode?: Mode;
  enabled?: boolean;
  withPorts?: boolean;
  failSave?: boolean;
} = {}) {
  const modeWrites: Mode[] = [];
  const enabledWrites: boolean[] = [];
  const hourWrites: number[] = [];
  let hour = 0;
  const waitWrites: number[] = [];
  let modelWaitMinutes = 10;
  let tidyStarts = 0;
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
    modelWaitMinutes,
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
          setMemoryNightly: async (change: { enabled?: boolean; hour?: number; modelWaitMinutes?: number }) => {
            if (change.modelWaitMinutes !== undefined) {
              waitWrites.push(change.modelWaitMinutes);
              modelWaitMinutes = change.modelWaitMinutes;
            }
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
          tidyMemoryNow: async () => {
            tidyStarts += 1;
            return { ...QUIET_RUN, status: 'busy' as const };
          },
          getMemoryTidyState: async () => (tidyStarts > 0 && tidy !== null ? tidy : tidyState()),
        },
      }
    : {};
  const server = { ...createMockAgentUIServer({ catalog: createMockCatalog() }), ...ports };
  render(
    <ServerProvider server={server}>
      <MemoryHelpersCard />
    </ServerProvider>,
  );
  return { modeWrites, enabledWrites, hourWrites, waitWrites };
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
    expect(screen.getByText('When sorting above is not off, it also:')).toBeInTheDocument();
    expect(screen.getByText(/files any saved notes that were not filed yet/)).toBeInTheDocument();
    expect(screen.getByText(/points out two facts that cannot both be true/)).toBeInTheDocument();
    expect(screen.getByText('It never deletes anything.')).toBeInTheDocument();
    expect(screen.getByText(/Both are on unless you turn them off/)).toBeInTheDocument();
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

  it('waits ten minutes for the model until another wait is chosen', async () => {
    const { waitWrites, hourWrites } = renderCard();
    const picker = await screen.findByLabelText('Wait for the model up to');
    await waitFor(() => {
      expect(picker).toBeEnabled();
    });
    expect(picker).toHaveValue('10');

    fireEvent.change(picker, { target: { value: '20' } });

    await waitFor(() => {
      expect(waitWrites).toEqual([20]);
    });
    await waitFor(() => {
      expect(picker).toHaveValue('20');
    });
    expect(hourWrites).toEqual([]);
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
      'Done. Aman moved 2 ended lines to Earlier and went through 1 saved note and filed what belongs on a page.',
    );
  });

  it('says a trial run changed no page', async () => {
    const status = renderCardAndTidy({ ...QUIET_RUN, sorting: 'report', notesAsked: 2, notesSorted: 2 });
    expect(await status).toHaveTextContent('Done. Aman wrote down where 2 notes would go, without changing a page.');
  });

  it('says which notes it could not file beside what it did', async () => {
    const status = renderCardAndTidy({ ...QUIET_RUN, notesAsked: 3, notesSorted: 1 });
    expect(await status).toHaveTextContent('It could not file 2 other notes. Those stay on the Memories tab.');
  });

  it('says why when notes could not be filed and nothing changed', async () => {
    const status = renderCardAndTidy({
      ...QUIET_RUN,
      notesAsked: 4,
      unsortedReasons: ['model_slow', 'reply_wrong_form', 'a cause from a newer server'],
    });
    expect(await status).toHaveTextContent(
      "Nothing changed. Aman looked at 4 saved notes but could not file any. Your notes stay on the Memories tab. The reason: the model took too long to answer, the model's answer was not in the form Aman asked for, and something went wrong. Try again, or choose another model in Settings.",
    );
  });

  it('says when no model was found', async () => {
    const status = renderCardAndTidy({ ...QUIET_RUN, modelMissing: true });
    expect(await status).toHaveTextContent(
      'Nothing changed. Aman found no model to work with, so it only looked for facts that are over, and found none. Choose a model in Settings, then try again.',
    );
  });

  it('says sorting is off when a run with sorting off changed nothing', async () => {
    const status = renderCardAndTidy({ ...QUIET_RUN, sorting: 'off' });
    expect(await status).toHaveTextContent(
      'Done. Nothing changed. Sorting is off, so Aman only looked for facts that are over, and found none.',
    );
  });

  it('says so when nothing needed tidying', async () => {
    expect(await renderCardAndTidy(QUIET_RUN)).toHaveTextContent(
      'Done. Nothing needed tidying. Every saved note was already looked at.',
    );
  });

  it('picks a running tidy-up back up when the page is opened again, and shows what it did', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let state: MemoryTidyRun = { ...QUIET_RUN, status: 'busy' };
      renderCard({ tidyState: () => state });

      expect(await screen.findByRole('button', { name: 'Tidying…' })).toBeDisabled();
      state = { ...QUIET_RUN, movedToEarlier: 1 };
      await vi.advanceTimersByTimeAsync(5000);

      expect(await screen.findByRole('status')).toHaveTextContent('Done. Aman moved 1 ended line to Earlier.');
      expect(screen.getByRole('button', { name: 'Tidy now' })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows what a tidy-up that finished while the page was closed did', async () => {
    renderCard({ tidyState: () => ({ ...QUIET_RUN, movedToEarlier: 3 }) });
    expect(await screen.findByRole('status')).toHaveTextContent('Done. Aman moved 3 ended lines to Earlier.');
  });

  it('waits for a tidy-up it started, however long it takes, and then shows what it did', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let state: MemoryTidyRun = { ...QUIET_RUN, status: 'idle' };
      renderCard({ tidy: null, tidyState: () => state });
      const button = await screen.findByRole('button', { name: 'Tidy now' });
      state = { ...QUIET_RUN, status: 'busy' };
      fireEvent.click(button);

      expect(await screen.findByRole('button', { name: 'Tidying…' })).toBeDisabled();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(screen.getByRole('button', { name: 'Tidying…' })).toBeDisabled();
      state = { ...QUIET_RUN, movedToEarlier: 1 };
      await vi.advanceTimersByTimeAsync(5000);

      expect(await screen.findByRole('status')).toHaveTextContent('Done. Aman moved 1 ended line to Earlier.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says what to do when a tidy-up stopped on an error', async () => {
    renderCard({ tidy: { ...QUIET_RUN, status: 'failed' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Tidy now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The tidy-up stopped because something went wrong. Your pages are as they were. Choose Tidy now to try again.',
    );
    expect(screen.getByRole('button', { name: 'Tidy now' })).toBeEnabled();
  });

  it('says what to do when the app restarted in the middle of a tidy-up', async () => {
    renderCard({ tidy: { ...QUIET_RUN, status: 'idle' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Tidy now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The tidy-up stopped before it finished, because the app restarted. Choose Tidy now to start it again.',
    );
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

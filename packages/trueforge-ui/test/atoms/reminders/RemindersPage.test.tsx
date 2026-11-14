// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemindersPage } from '@/atoms/reminders/RemindersPage.js';
import { RemindersButton } from '@/atoms/RemindersButton.js';
import { ReminderListProvider } from '@/reminders/ReminderListContext.js';
import type { ReminderItem, RemindersApi } from '@/reminders/types.js';

function stubShell() {
  return {
    remindersOpen: false,
    setRemindersOpen: vi.fn(),
    setSettingsOpen: vi.fn(),
    setLibraryOpen: vi.fn(),
    setSessionsOpen: vi.fn(),
    setSchedulesOpen: vi.fn(),
    openSpaces: vi.fn(),
    closeSpaces: vi.fn(),
    openHistorySession: vi.fn(),
  };
}

// The shell the page and the button steer; null stands for a screen with no shell.
let shell: ReturnType<typeof stubShell> | null = null;

vi.mock('@/server/ShellModeContext.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@/server/ShellModeContext.js')>()),
  useOptionalShellMode: () => shell,
}));

function item(overrides: Partial<ReminderItem>): ReminderItem {
  return {
    id: 'reminder-1',
    what: 'Take the bins out',
    timezone: 'America/Los_Angeles',
    repeats: false,
    timing: 'Once, on Wednesday, November 4 at 9:00 AM',
    state: 'upcoming',
    nextDueAt: '2026-11-04T17:00:00.000Z',
    lastRemindedAt: null,
    lastDueAt: null,
    setAt: '2026-11-01T09:00:00.000Z',
    personaName: 'Mannie',
    sessionId: null,
    ...overrides,
  };
}

function renderPage(api: Pick<RemindersApi, 'listReminders'> & Partial<RemindersApi>) {
  return render(
    <ReminderListProvider api={{ deleteReminder: () => Promise.resolve(), ...api }}>
      <RemindersPage />
    </ReminderListProvider>,
  );
}

beforeEach(() => {
  shell = stubShell();
});

afterEach(() => {
  cleanup();
});

describe('the Reminders page', () => {
  it('lists what is still to come and what has already gone out, each under its own heading', async () => {
    renderPage({
      listReminders: () =>
        Promise.resolve([
          item({ id: 'a', what: 'Take the bins out' }),
          item({
            id: 'b',
            what: 'Call the dentist',
            state: 'reminded',
            nextDueAt: null,
            lastRemindedAt: '2026-11-02T17:00:00.000Z',
          }),
        ]),
    });

    const comingUp = await screen.findByRole('region', { name: 'Coming up' });
    expect(within(comingUp).getByText('Take the bins out')).toBeTruthy();
    expect(within(comingUp).queryByText('Call the dentist')).toBeNull();
    const reminded = screen.getByRole('region', { name: 'Already reminded' });
    expect(within(reminded).getByText('Call the dentist')).toBeTruthy();
  });

  it('opens the chat a reminder was set in, and offers no button for one set elsewhere', async () => {
    renderPage({
      listReminders: () =>
        Promise.resolve([
          item({ id: 'a', what: 'Take the bins out', sessionId: 'chat-7' }),
          item({ id: 'b', what: 'Water the plants' }),
        ]),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Take the bins out. Opens the chat it was set in.' }));
    expect(shell?.setRemindersOpen).toHaveBeenCalledWith(false);
    expect(shell?.openHistorySession).toHaveBeenCalledWith({ sessionId: 'chat-7', isMutable: false });
    expect(screen.queryByRole('button', { name: /Water the plants\. Opens the chat/ })).toBeNull();
    expect(screen.getAllByText('Open chat')).toHaveLength(1);
    expect(screen.getByText('No chat to open')).toBeTruthy();
  });

  it('deletes a reminder only after the person confirms, and takes it off the list', async () => {
    const deleteReminder = vi.fn<RemindersApi['deleteReminder']>().mockResolvedValue(undefined);
    renderPage({
      listReminders: () =>
        Promise.resolve([item({ id: 'a', what: 'Take the bins out' }), item({ id: 'b', what: 'Water the plants' })]),
      deleteReminder,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete the reminder: Take the bins out' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete reminder', hidden: true });
    expect(dialog.textContent).toContain('“Take the bins out” will be deleted. This cannot be undone.');
    expect(deleteReminder).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete', hidden: true }));
    await waitFor(() => expect(screen.queryByText('Take the bins out')).toBeNull());
    expect(deleteReminder).toHaveBeenCalledWith('a');
    expect(screen.getByText('Water the plants')).toBeTruthy();
  });

  it('keeps the reminder when the person cancels', async () => {
    const deleteReminder = vi.fn<RemindersApi['deleteReminder']>().mockResolvedValue(undefined);
    renderPage({ listReminders: () => Promise.resolve([item({ id: 'a' })]), deleteReminder });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete the reminder: Take the bins out' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete reminder', hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel', hidden: true }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete reminder', hidden: true })).toBeNull());
    expect(deleteReminder).not.toHaveBeenCalled();
    expect(screen.getByText('Take the bins out')).toBeTruthy();
  });

  it('says a repeating reminder will not remind again', async () => {
    renderPage({
      listReminders: () => Promise.resolve([item({ id: 'a', repeats: true, timing: 'Every Friday at 8:00 AM' })]),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete the reminder: Take the bins out' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete reminder', hidden: true });
    expect(dialog.textContent).toContain('will be deleted and will not remind you again. This cannot be undone.');
  });

  it('keeps the reminder and says what to do when the delete fails', async () => {
    const deleteReminder = vi.fn<RemindersApi['deleteReminder']>().mockRejectedValue(new Error('offline'));
    renderPage({ listReminders: () => Promise.resolve([item({ id: 'a' })]), deleteReminder });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete the reminder: Take the bins out' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete reminder', hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete', hidden: true }));

    expect((await within(dialog).findByRole('alert', { hidden: true })).textContent).toBe(
      'That reminder could not be deleted. Check your connection, then try again.',
    );
    expect(screen.getAllByText('Take the bins out').length).toBeGreaterThan(0);
  });

  it('says there are no reminders yet when none were set', async () => {
    renderPage({ listReminders: () => Promise.resolve([]) });

    expect(await screen.findByText('No reminders yet')).toBeTruthy();
    expect(screen.getByText('When you ask a persona to remind you, it will show up here.')).toBeTruthy();
  });

  it('says what to do when the list cannot be loaded, and loads it on "Try again"', async () => {
    const listReminders = vi
      .fn<RemindersApi['listReminders']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([item({ what: 'Take the bins out' })]);
    renderPage({ listReminders });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Your reminders could not be loaded. Check your connection, then try again.');

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Take the bins out')).toBeTruthy();
    expect(listReminders).toHaveBeenCalledTimes(2);
  });
});

describe('the Reminders button in the left panel', () => {
  const api: RemindersApi = { listReminders: () => Promise.resolve([]), deleteReminder: () => Promise.resolve() };

  it('opens the Reminders page', () => {
    render(
      <ReminderListProvider api={api}>
        <RemindersButton />
      </ReminderListProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reminders' }));
    expect(shell?.setRemindersOpen).toHaveBeenCalledWith(true);
  });

  it('shows an alarm clock, so the bell in the left panel means notifications only', () => {
    render(
      <ReminderListProvider api={api}>
        <RemindersButton />
      </ReminderListProvider>,
    );

    const icon = screen.getByRole('button', { name: 'Reminders' }).querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('alarm-clock');
    expect(icon?.getAttribute('class')).not.toContain('bell');
  });

  it('is not shown where there is no reminders list to open', () => {
    render(<RemindersButton />);

    expect(screen.queryByRole('button', { name: 'Reminders' })).toBeNull();
  });
});

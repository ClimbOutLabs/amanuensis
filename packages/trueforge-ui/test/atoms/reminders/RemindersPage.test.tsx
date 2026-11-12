// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RemindersPage } from '@/atoms/reminders/RemindersPage.js';
import { ReminderListProvider } from '@/reminders/ReminderListContext.js';
import type { ReminderItem } from '@/reminders/types.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider } from '@/server/ShellModeContext.js';
import type { AgentUIServer } from '@/server/types.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { createMockAgentUIServer } from '../../server/mockServer.js';

const REMINDER: ReminderItem = {
  id: 'r1',
  what: 'Call the dentist',
  timezone: 'UTC',
  repeats: false,
  timing: 'Once',
  state: 'reminded',
  nextDueAt: null,
  lastRemindedAt: '2026-01-02T09:00:00Z',
  lastDueAt: '2026-01-02T09:00:00Z',
  setAt: '2026-01-01T09:00:00Z',
  personaName: 'Aman',
  sessionId: 'chat-1',
};

function renderPage(getSession: AgentUIServer['getSession']) {
  render(
    <SlotsProvider>
      <ServerProvider server={createMockAgentUIServer({ getSession })}>
        <ShellModeProvider>
          <ReminderListProvider api={{ listReminders: async () => [REMINDER] }}>
            <RemindersPage />
          </ReminderListProvider>
        </ShellModeProvider>
      </ServerProvider>
    </SlotsProvider>,
  );
}

describe('RemindersPage', () => {
  it('says the chat was deleted when a reminder leads to a chat that is gone', async () => {
    const gone = new Error('Session not found');
    gone.name = 'NotFoundError';
    const getSession = vi.fn(async () => {
      throw gone;
    });
    renderPage(getSession);

    fireEvent.click(await screen.findByRole('button', { name: /Call the dentist/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This chat was deleted');
    expect(getSession).toHaveBeenCalledWith({ sessionId: 'chat-1' });
  });

  it('looks the chat up and shows no message when it opens', async () => {
    const getSession = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      id: sessionId,
      title: 'Dentist',
      isMutable: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    renderPage(getSession);

    fireEvent.click(await screen.findByRole('button', { name: /Call the dentist/ }));

    await waitFor(() => expect(getSession).toHaveBeenCalledWith({ sessionId: 'chat-1' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

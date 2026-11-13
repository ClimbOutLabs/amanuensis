// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeliveriesProvider } from '@/deliveries/DeliveriesContext.js';
import { ReminderNotificationPrompt } from '@/reminders/ReminderNotificationPrompt.js';

import { fakeServer, SERVER_KEY } from '../deliveries/fakeDeliveriesApi.js';
import { removePushBrowser, stubPushBrowser } from '../deliveries/fakePushBrowser.js';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  removePushBrowser();
});

/** Lets the status check finish and its state land, so a missing prompt means it decided not to show. */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

function renderPrompt({ savedEndpoints }: { savedEndpoints: string[] }) {
  const server = fakeServer([]);
  for (const endpoint of savedEndpoints) server.state.pushEndpoints.add(endpoint);
  const { unmount } = render(
    <DeliveriesProvider api={server.api}>
      <ReminderNotificationPrompt />
    </DeliveriesProvider>,
  );
  return { ...server, unmount };
}

describe('ReminderNotificationPrompt', () => {
  it('offers notices again on a device the server dropped', async () => {
    stubPushBrowser({ existingKey: SERVER_KEY });
    renderPrompt({ savedEndpoints: [] });
    expect(await screen.findByRole('button', { name: 'Turn on notices' })).toBeTruthy();
  });

  it('stays quiet on a device that already gets notices', async () => {
    stubPushBrowser({ existingKey: SERVER_KEY });
    const { api } = renderPrompt({ savedEndpoints: ['https://push.example.test/device-1'] });
    await waitFor(() => expect(api.pushDeviceSaved).toHaveBeenCalled());
    await settle();
    expect(screen.queryByRole('button', { name: 'Turn on notices' })).toBeNull();
  });

  it('keeps the offer away after Not now, on a reload too', async () => {
    stubPushBrowser({ existingKey: SERVER_KEY });
    const first = renderPrompt({ savedEndpoints: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('button', { name: 'Turn on notices' })).toBeNull();
    first.unmount();

    const second = renderPrompt({ savedEndpoints: [] });
    await waitFor(() => expect(second.api.pushDeviceSaved).toHaveBeenCalled());
    await settle();
    expect(screen.queryByRole('button', { name: 'Turn on notices' })).toBeNull();
  });
});

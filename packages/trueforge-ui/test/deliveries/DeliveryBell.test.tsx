// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeliveriesProvider, useOptionalDeliveries } from '@/deliveries/DeliveriesContext.js';
import { DeliveryBell } from '@/deliveries/DeliveryBell.js';

import { fakeServer, item } from './fakeDeliveriesApi.js';

const POLL_MS = 1_000;

function Chats() {
  const deliveries = useOptionalDeliveries();
  return <p data-testid="unread-chats">{[...(deliveries?.unreadChatIds ?? [])].join(',')}</p>;
}

function renderDevice(api: ReturnType<typeof fakeServer>['api']) {
  return render(
    <DeliveriesProvider api={api} pollMs={POLL_MS}>
      <DeliveryBell />
      <Chats />
    </DeliveriesProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the bell', () => {
  it('shows the unread count to a tab that never set a reminder and knows nothing in the browser', async () => {
    const { api } = fakeServer([
      item({ id: 'a' }),
      item({ id: 'b' }),
      item({ id: 'c', seenAt: '2026-10-30T00:00:00.000Z' }),
    ]);
    renderDevice(api);

    expect(await screen.findByRole('button', { name: 'Notifications, 2 unread' })).toBeTruthy();
    expect(screen.getByTestId('unread-chats').textContent).toBe('reminders-chat');
    expect(window.localStorage.length).toBe(0);
  });

  it('draws nothing without a feed', () => {
    const { container } = render(<DeliveryBell />);
    expect(container.firstChild).toBeNull();
  });

  it('asks again every 30 seconds while the page is open, and refreshes the list when the count changes', async () => {
    vi.useFakeTimers();
    const { api, state } = fakeServer([]);
    renderDevice(api);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.unreadCount).toHaveBeenCalledTimes(1);

    state.items = [item({ id: 'new', text: 'Water the plants' })];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(api.unreadCount).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    // Nothing changed, so the list is not fetched again.
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('lists time, text, reason and a link, and marks an item seen on the server when it is opened', async () => {
    const { api, state } = fakeServer([item({ id: 'a', text: 'Call the dentist' })]);
    renderDevice(api);
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));

    const row = await screen.findByRole('button', { name: /Call the dentist/ });
    expect(row.textContent).toContain('Why you got this: You asked to be reminded on Monday.');
    expect(row.textContent).toContain('Open');

    fireEvent.click(row);
    await waitFor(() => expect(api.markSeen).toHaveBeenCalledWith(['a']));
    expect(state.items[0]?.seenAt).not.toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy());
    expect(screen.getByTestId('unread-chats').textContent).toBe('');
  });

  it('shows seen on one device as seen on the other', async () => {
    const { api } = fakeServer([item({ id: 'a' })]);
    const phone = renderDevice(api);
    const laptop = render(
      <DeliveriesProvider api={api} pollMs={POLL_MS}>
        <DeliveryBell />
      </DeliveriesProvider>,
    );
    await within(laptop.container).findByRole('button', { name: 'Notifications, 1 unread' });

    fireEvent.click(await within(phone.container).findByRole('button', { name: /Notifications/ }));
    fireEvent.click(await within(phone.container).findByRole('button', { name: /Mark all seen/ }));
    await waitFor(() => expect(api.markSeen).toHaveBeenCalled());

    // The laptop's next check reads the shared server state.
    await waitFor(() => expect(within(laptop.container).getByRole('button', { name: 'Notifications' })).toBeTruthy(), {
      timeout: 3_000,
    });
  });

  it('says what an empty feed means', async () => {
    const { api } = fakeServer([]);
    renderDevice(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('Nothing yet. Reminders and notes show up here.')).toBeTruthy();
  });
});

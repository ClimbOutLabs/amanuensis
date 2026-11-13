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

    expect(await screen.findByRole('button', { name: 'For you, 2 unread' })).toBeTruthy();
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
    expect(screen.getByRole('button', { name: 'For you, 1 unread' })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    // Nothing changed, so the list is not fetched again.
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('lists time, text, reason and a link, and marks an item seen on the server when it is opened', async () => {
    const { api, state } = fakeServer([item({ id: 'a', text: 'Call the dentist' })]);
    renderDevice(api);
    fireEvent.click(await screen.findByRole('button', { name: /For you/ }));

    const row = await screen.findByRole('button', { name: /Call the dentist/ });
    expect(row.textContent).toContain('You asked to be reminded on Monday.');
    expect(within(row).getByText('Open chat')).toBeTruthy();

    fireEvent.click(row);
    await waitFor(() => expect(api.markSeen).toHaveBeenCalledWith(['a']));
    expect(state.items[0]?.seenAt).not.toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'For you' })).toBeTruthy());
    expect(screen.getByTestId('unread-chats').textContent).toBe('');
  });

  it('ends each item with a link line that says where it leads, and none when it leads nowhere', async () => {
    const { api } = fakeServer([
      item({ id: 'chat', text: 'Call the dentist' }),
      item({
        id: 'approval',
        text: 'A message is waiting for your OK',
        link: { type: 'approval', sessionId: 'mail-chat', approvalId: 'approval-1' },
      }),
      item({ id: 'space', text: 'Your trip page changed', link: { type: 'space', spaceId: 'trip' } }),
      item({ id: 'none', text: 'Your backup finished', link: null }),
    ]);
    renderDevice(api);
    fireEvent.click(await screen.findByRole('button', { name: /For you/ }));

    const linkLine = async (text: RegExp) =>
      (await screen.findByRole('button', { name: text })).querySelector('[data-role="delivery-link"]')?.textContent;
    expect(await linkLine(/Call the dentist/)).toBe('Open chat');
    expect(await linkLine(/waiting for your OK/)).toBe('Open chat to answer');
    expect(await linkLine(/trip page changed/)).toBe('Open space');
    expect(await linkLine(/backup finished/)).toBeUndefined();
  });

  it('shows seen on one device as seen on the other', async () => {
    const { api } = fakeServer([item({ id: 'a' })]);
    const phone = renderDevice(api);
    const laptop = render(
      <DeliveriesProvider api={api} pollMs={POLL_MS}>
        <DeliveryBell />
      </DeliveriesProvider>,
    );
    await within(laptop.container).findByRole('button', { name: 'For you, 1 unread' });

    fireEvent.click(await within(phone.container).findByRole('button', { name: /For you/ }));
    fireEvent.click(await within(phone.container).findByRole('button', { name: /Mark all seen/ }));
    await waitFor(() => expect(api.markAllSeen).toHaveBeenCalled());

    // The laptop's next check reads the shared server state.
    await waitFor(() => expect(within(laptop.container).getByRole('button', { name: 'For you' })).toBeTruthy(), {
      timeout: 3_000,
    });
  });

  it('marks every unread item seen, including ones not loaded yet', async () => {
    const { api, state } = fakeServer([item({ id: 'a' })]);
    vi.mocked(api.unreadCount).mockResolvedValueOnce(150);
    renderDevice(api);
    fireEvent.click(await screen.findByRole('button', { name: 'For you, 150 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: /Mark all seen/ }));

    await waitFor(() => expect(api.markAllSeen).toHaveBeenCalledTimes(1));
    expect(api.markSeen).not.toHaveBeenCalled();
    expect(state.items.every(row => row.seenAt !== null)).toBe(true);
    expect(await screen.findByRole('button', { name: 'For you' })).toBeTruthy();
  });

  it('shows the latest items each time the panel opens, even when the count did not change', async () => {
    const { api, state } = fakeServer([item({ id: 'a', text: 'First thing' })]);
    renderDevice(api);
    const bell = await screen.findByRole('button', { name: 'For you, 1 unread' });

    // One item was seen elsewhere and another arrived, so the count is still 1.
    state.items = [item({ id: 'b', text: 'Second thing' }), { ...item({ id: 'a', text: 'First thing' }), seenAt: 'x' }];
    fireEvent.click(bell);

    expect(await screen.findByRole('button', { name: /Second thing/ })).toBeTruthy();
  });

  it('says what an empty feed means', async () => {
    const { api } = fakeServer([]);
    renderDevice(api);
    fireEvent.click(await screen.findByRole('button', { name: 'For you' }));
    expect(await screen.findByText('Nothing for you yet')).toBeTruthy();
  });
});

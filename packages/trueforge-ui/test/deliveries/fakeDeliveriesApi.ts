import { vi } from 'vitest';

import type { DeliveriesApi, DeliveryItem } from '@/deliveries/types.js';

export function item(overrides: Partial<DeliveryItem> & { id: string }): DeliveryItem {
  return {
    kind: 'reminder',
    text: 'Call the dentist',
    reason: 'You asked to be reminded on Monday.',
    link: { type: 'chat', sessionId: 'reminders-chat' },
    createdAt: '2026-10-31T10:00:00.000Z',
    seenAt: null,
    ...overrides,
  };
}

/** A push key that reads back the same after a round trip through bytes. */
export const SERVER_KEY = 'AAECAwQF';

/** A server that holds the feed once, the way the real one does, so two "devices" can share it. */
export function fakeServer(initial: DeliveryItem[]) {
  const state = { items: initial, pushKey: SERVER_KEY as string | null };
  const unread = () => state.items.filter(row => row.seenAt === null).length;
  const api: DeliveriesApi = {
    pushWorker: { url: '/sw.js', scope: '/' },
    list: vi.fn(() => Promise.resolve({ items: [...state.items], nextPageToken: undefined })),
    unreadCount: vi.fn(() => Promise.resolve(unread())),
    markSeen: vi.fn((ids: readonly string[]) => {
      state.items = state.items.map(row =>
        ids.includes(row.id) && row.seenAt === null ? { ...row, seenAt: '2026-10-31T11:00:00.000Z' } : row,
      );
      return Promise.resolve(unread());
    }),
    markAllSeen: vi.fn(() => {
      state.items = state.items.map(row =>
        row.seenAt === null ? { ...row, seenAt: '2026-10-31T11:00:00.000Z' } : row,
      );
      return Promise.resolve(unread());
    }),
    get: vi.fn((id: string) => Promise.resolve(state.items.find(row => row.id === id) ?? null)),
    pushPublicKey: vi.fn(() => Promise.resolve(state.pushKey)),
    savePushDevice: vi.fn((): Promise<'saved' | 'taken'> => Promise.resolve('saved')),
    removePushDevice: vi.fn(() => Promise.resolve()),
  };
  return { api, state };
}

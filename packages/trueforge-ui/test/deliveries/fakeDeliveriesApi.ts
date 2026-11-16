import { vi } from 'vitest';

import type {
  DeliveriesApi,
  DeliveryItem,
  ReachSettings,
  ReachSuggestion,
  ReachView,
  TextStatus,
} from '@/deliveries/types.js';

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

export const QUIET_SETTINGS: ReachSettings = {
  noticingOn: false,
  textsOn: false,
  callsOn: false,
  alwaysImportant: [],
  dismissedSuggestions: [],
  callKinds: [],
  callForUrgentReminders: false,
  quietHours: { enabled: true, start: '21:00', end: '08:00' },
  timezone: 'UTC',
  maxNudgesPerDay: 5,
  minHoursBetweenCalls: 6,
  travelLeadMinutes: 90,
  approvalWaitMinutes: 15,
};

const NO_NUMBER: TextStatus = {
  phone: null,
  confirmed: false,
  mode: 'private',
  optedOut: false,
  codePending: false,
  pendingPhone: null,
  privatePreview: 'Mannie: a reminder is due. Open the app to see it.',
  words: [],
};

/** A server that holds the feed once, the way the real one does, so two "devices" can share it. */
export function fakeServer(initial: DeliveryItem[]) {
  const state: {
    items: DeliveryItem[];
    pushKey: string | null;
    pushEndpoints: Set<string>;
    reach: ReachView;
    suggestions: ReachSuggestion[];
    texts: TextStatus;
  } = {
    items: initial,
    pushKey: SERVER_KEY,
    pushEndpoints: new Set<string>(),
    reach: {
      settings: QUIET_SETTINGS,
      saved: false,
      availability: {
        texts: {
          available: false,
          note: 'Texts are not set up on this server. To set them up, follow the Text messages page in the Aman docs.',
          problem: null,
        },
        calls: { available: false, note: 'Phone calls are not set up yet.', problem: null },
      },
      maxLevels: {
        mail_always: 'call',
        calendar_clash: 'call',
        travel: 'call',
        bill_due: 'nudge',
        approval_waiting: 'nudge',
      },
      mailProblem: null,
      calendarProblem: null,
      mailSource: null,
      mailSenderConfirmation: null,
    },
    suggestions: [],
    texts: NO_NUMBER,
  };
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
    savePushDevice: vi.fn((device: { endpoint: string }): Promise<'saved' | 'taken'> => {
      state.pushEndpoints.add(device.endpoint);
      return Promise.resolve('saved');
    }),
    removePushDevice: vi.fn((endpoint: string) => {
      state.pushEndpoints.delete(endpoint);
      return Promise.resolve();
    }),
    pushDeviceSaved: vi.fn((endpoint: string) => Promise.resolve(state.pushEndpoints.has(endpoint))),
    reach: {
      get: vi.fn(() => Promise.resolve(state.reach)),
      save: vi.fn((settings: ReachSettings) => {
        state.reach = { ...state.reach, settings, saved: true };
        return Promise.resolve(state.reach);
      }),
      suggestions: vi.fn(() => Promise.resolve(state.suggestions)),
      test: vi.fn(() => Promise.resolve({ devicesReached: 1 })),
      texts: {
        status: vi.fn(() => Promise.resolve(state.texts)),
        sendCode: vi.fn((phone: string) => {
          // Like the server: a new number waits beside a confirmed one until its code is confirmed.
          state.texts =
            state.texts.confirmed && state.texts.phone !== phone
              ? { ...state.texts, pendingPhone: phone, codePending: true }
              : { ...state.texts, phone, confirmed: false, codePending: true, pendingPhone: null };
          return Promise.resolve(state.texts);
        }),
        confirm: vi.fn((code: string) => {
          if (code !== '123456') return Promise.reject(new Error('That code is not right. You have 4 tries left.'));
          state.texts = {
            ...state.texts,
            phone: state.texts.pendingPhone ?? state.texts.phone,
            confirmed: true,
            codePending: false,
            pendingPhone: null,
          };
          return Promise.resolve(state.texts);
        }),
        setMode: vi.fn((mode: TextStatus['mode']) => {
          state.texts = { ...state.texts, mode };
          return Promise.resolve(state.texts);
        }),
        addWord: vi.fn((word: string) => {
          if (!/^[A-Za-z]{2,24}$/.test(word))
            return Promise.reject(new Error('Use letters only, with no spaces, digits or signs.'));
          state.texts = { ...state.texts, words: [...state.texts.words, word.toLowerCase()].sort() };
          return Promise.resolve(state.texts);
        }),
        removeWord: vi.fn((word: string) => {
          state.texts = { ...state.texts, words: state.texts.words.filter(listed => listed !== word) };
          return Promise.resolve(state.texts);
        }),
        remove: vi.fn(() => {
          state.texts = NO_NUMBER;
          return Promise.resolve();
        }),
      },
    },
  };
  return { api, state };
}

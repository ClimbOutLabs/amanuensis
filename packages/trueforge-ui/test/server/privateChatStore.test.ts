import { afterEach, describe, expect, it } from 'vitest';

import {
  adoptPrivateChat,
  forgetPrivateChat,
  readPrivateChatState,
  setPendingPrivateChat,
  withOpenPrivateChatOnly,
} from '@/server/privateChatStore.js';

afterEach(() => {
  const { openSessionId } = readPrivateChatState();
  if (openSessionId !== undefined) forgetPrivateChat(openSessionId);
  setPendingPrivateChat(false);
});

const rows = [
  { id: 'normal', isIncognito: false },
  { id: 'private-open', isIncognito: true },
  { id: 'private-other', isIncognito: true },
];

describe('privateChatStore', () => {
  it('holds the Private choice until the chat is created, then makes that chat the open one', () => {
    setPendingPrivateChat(true);
    expect(readPrivateChatState()).toEqual({ pending: true, openSessionId: undefined });

    adoptPrivateChat('private-open');

    expect(readPrivateChatState()).toEqual({ pending: false, openSessionId: 'private-open' });
  });

  it('forgets only the chat it is told was closed', () => {
    adoptPrivateChat('private-open');
    forgetPrivateChat('another-chat');
    expect(readPrivateChatState().openSessionId).toBe('private-open');

    forgetPrivateChat('private-open');
    expect(readPrivateChatState().openSessionId).toBeUndefined();
  });

  it('lists no private chat when none is open, and only the open one otherwise', () => {
    expect(withOpenPrivateChatOnly(rows).map(row => row.id)).toEqual(['normal']);

    adoptPrivateChat('private-open');

    expect(withOpenPrivateChatOnly(rows).map(row => row.id)).toEqual(['normal', 'private-open']);
  });
});

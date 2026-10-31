import { describe, expect, it } from 'vitest';

import {
  canReuseMutableShell,
  filterChatsByTitle,
  formatRelativeShort,
  groupRecentChats,
  readThreadAgentName,
  readThreadIsMutable,
  threadListIndicesByRecency,
  threadListItemIsMutable,
  visibleChats,
} from '@/atoms/lib/threadListMeta.js';

describe('formatRelativeShort', () => {
  const now = new Date('2026-08-06T12:00:00.000Z');

  it('formats minutes, hours, and days', () => {
    expect(formatRelativeShort(new Date('2026-08-06T11:30:00.000Z'), now)).toBe('30m');
    expect(formatRelativeShort(new Date('2026-08-05T14:00:00.000Z'), now)).toBe('22h');
    expect(formatRelativeShort(new Date('2026-08-05T12:00:00.000Z'), now)).toBe('1d');
  });
});

describe('readThreadAgentName', () => {
  it('reads agentName from custom metadata', () => {
    expect(readThreadAgentName({ agentName: 'from-sdk' })).toBe('from-sdk');
    expect(readThreadAgentName({})).toBeUndefined();
    expect(readThreadAgentName(null)).toBeUndefined();
    expect(readThreadAgentName({ agentName: 1 })).toBeUndefined();
  });
});

describe('threadListItemIsMutable', () => {
  it('prefers custom.isMutable over agentName presence', () => {
    expect(readThreadIsMutable({ isMutable: false })).toBe(false);
    expect(threadListItemIsMutable({ isMutable: false })).toBe(false);
    // Orphaned named ref: no agentName, but still immutable on the wire.
    expect(threadListItemIsMutable({ isMutable: false })).toBe(false);
    expect(threadListItemIsMutable({ isMutable: true, agentName: 'x' })).toBe(true);
  });

  it('falls back to agentName heuristic when isMutable is absent', () => {
    expect(threadListItemIsMutable({ agentName: 'from-sdk' })).toBe(false);
    expect(threadListItemIsMutable({})).toBe(true);
    expect(threadListItemIsMutable(null)).toBe(true);
  });
});

describe('threadListIndicesByRecency', () => {
  it('orders by lastMessageAt newest-first even when ids were appended', () => {
    const older = new Date('2026-08-06T11:00:00.000Z');
    const newer = new Date('2026-08-06T12:00:00.000Z');
    // Selected session appended at end (assistant-ui switchToThread fetch race).
    expect(
      threadListIndicesByRecency({
        threadIds: ['older', 'newer-appended'],
        threadItems: [
          { id: 'older', remoteId: 'older', lastMessageAt: older },
          { id: 'newer-appended', remoteId: 'newer-appended', lastMessageAt: newer },
        ],
      }),
    ).toEqual([1, 0]);
  });

  it('pins threads without lastMessageAt above dated history (empty New Chat)', () => {
    const older = new Date('2026-08-06T11:00:00.000Z');
    const newer = new Date('2026-08-06T12:00:00.000Z');
    // Local new thread appended at end with no timestamp.
    expect(
      threadListIndicesByRecency({
        threadIds: ['older', 'newer', 'new-chat'],
        threadItems: [
          { id: 'older', remoteId: 'older', lastMessageAt: older },
          { id: 'newer', remoteId: 'newer', lastMessageAt: newer },
          { id: 'new-chat', remoteId: null, lastMessageAt: undefined },
        ],
      }),
    ).toEqual([2, 1, 0]);
  });
});

describe('canReuseMutableShell', () => {
  it('allows blank drafts to share the mutable shell', () => {
    expect(
      canReuseMutableShell({
        sessionMutable: true,
        shellMutable: true,
        remoteId: 'sess-b',
        pendingSessionId: 'sess-a',
      }),
    ).toBe(true);
  });

  it('blocks Edit-bound shells from reusing chrome on a different session', () => {
    expect(
      canReuseMutableShell({
        sessionMutable: true,
        shellMutable: true,
        shellAgentName: 'writer',
        remoteId: 'sess-b',
        pendingSessionId: 'sess-a',
      }),
    ).toBe(false);
  });

  it('allows Edit-bound shells to switchToThread for their pending session', () => {
    expect(
      canReuseMutableShell({
        sessionMutable: true,
        shellMutable: true,
        shellAgentName: 'writer',
        remoteId: 'sess-a',
        pendingSessionId: 'sess-a',
      }),
    ).toBe(true);
  });
});

describe('groupRecentChats', () => {
  // Local midnight is the boundary, so the test builds its dates in local time.
  const now = new Date(2026, 9, 23, 14, 0, 0);
  const chat = (key: string, time: number, folderId?: string) => ({ key, time, folderId });
  const a = chat('a', new Date(2026, 9, 23, 9, 0, 0).getTime());
  const b = chat('b', new Date(2026, 9, 22, 23, 59, 0).getTime(), 'work');
  // A chat with no message yet counts as newest.
  const c = chat('c', Number.POSITIVE_INFINITY);
  const d = chat('d', new Date(2026, 9, 23, 0, 0, 0).getTime());
  const e = chat('e', new Date(2026, 9, 20, 8, 0, 0).getTime(), 'work');
  const f = chat('f', new Date(2026, 9, 22, 8, 0, 0).getTime());

  it('puts chats used since local midnight under today, and the rest under earlier', () => {
    expect(groupRecentChats({ chats: [a, c, d, f], folderIds: [], now })).toEqual({
      folders: [],
      today: [a, c, d],
      earlier: [f],
    });
  });

  it('keeps a chat in its folder only, with folders newest use first', () => {
    const grouped = groupRecentChats({ chats: [a, b, c, d, e], folderIds: ['home', 'work'], now });

    expect(grouped.folders).toEqual([
      { folderId: 'work', chats: [b, e] },
      { folderId: 'home', chats: [] },
    ]);
    expect(grouped.today).toEqual([a, c, d]);
    expect(grouped.earlier).toEqual([]);
  });

  it('keeps the order of the chats it is given within each group', () => {
    expect(groupRecentChats({ chats: [d, c, a], folderIds: [], now })).toEqual({
      folders: [],
      today: [d, c, a],
      earlier: [],
    });
  });
});

describe('visibleChats', () => {
  const chats = ['0', '1', '2', '3', '4', '5', '6'].map(key => ({ key }));

  it('shows the first page of a group', () => {
    expect(visibleChats({ chats, limit: 5, openKey: undefined }).map(chat => chat.key)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('keeps the open chat even when it falls past the limit', () => {
    expect(visibleChats({ chats, limit: 5, openKey: '6' }).map(chat => chat.key)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '6',
    ]);
  });

  it('grows with the limit', () => {
    expect(visibleChats({ chats, limit: 10, openKey: undefined })).toHaveLength(7);
  });
});

describe('filterChatsByTitle', () => {
  const chats = [{ title: 'Plan the Trip' }, { title: 'Groceries' }, { title: '' }];

  it('keeps every chat for a blank query', () => {
    expect(filterChatsByTitle({ chats, query: '   ' })).toEqual(chats);
  });

  it('matches titles that contain the query, ignoring case', () => {
    expect(filterChatsByTitle({ chats, query: 'trip' })).toEqual([chats[0]]);
    expect(filterChatsByTitle({ chats, query: 'GROC' })).toEqual([chats[1]]);
  });
});

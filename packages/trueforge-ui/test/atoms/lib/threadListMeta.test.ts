import { describe, expect, it } from 'vitest';

import {
  canReuseMutableShell,
  filterIndicesByTitle,
  formatRelativeShort,
  groupRecentChats,
  readThreadAgentName,
  readThreadIsMutable,
  threadListIndicesByRecency,
  threadListItemIsMutable,
  visibleChatIndices,
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
  const threadIds = ['a', 'b', 'c', 'd', 'e'];
  const threadItems = [
    { id: 'a', remoteId: 'ra', lastMessageAt: new Date(2026, 9, 23, 9, 0, 0) },
    { id: 'b', remoteId: 'rb', lastMessageAt: new Date(2026, 9, 22, 23, 59, 0) },
    { id: 'c', remoteId: 'rc', lastMessageAt: null },
    { id: 'd', remoteId: 'rd', lastMessageAt: new Date(2026, 9, 23, 0, 0, 0) },
    { id: 'e', remoteId: 're', lastMessageAt: new Date(2026, 9, 20, 8, 0, 0) },
  ];
  const folderOf: Record<string, string> = { re: 'work', rb: 'work' };

  it('puts chats used since local midnight under today, and the rest under earlier', () => {
    expect(
      groupRecentChats({
        indices: [0, 1, 2, 3],
        threadIds,
        threadItems,
        folderIds: [],
        folderIdOf: remoteId => folderOf[remoteId],
        now,
      }),
    ).toEqual({ folders: [], today: [0, 2, 3], earlier: [] });
  });

  it('keeps a chat in its folder only, with folders newest use first', () => {
    const grouped = groupRecentChats({
      indices: [0, 1, 2, 3, 4],
      threadIds,
      threadItems,
      folderIds: ['work', 'home'],
      folderIdOf: remoteId => folderOf[remoteId],
      now,
    });

    expect(grouped.folders).toEqual([
      { folderId: 'work', indices: [1, 4] },
      { folderId: 'home', indices: [] },
    ]);
    expect(grouped.today).toEqual([0, 2, 3]);
    expect(grouped.earlier).toEqual([]);
  });

  it('keeps the order of the indices it is given within each group', () => {
    const grouped = groupRecentChats({
      indices: [3, 2, 0],
      threadIds,
      threadItems,
      folderIds: [],
      folderIdOf: () => undefined,
      now,
    });

    expect(grouped).toEqual({ folders: [], today: [3, 2, 0], earlier: [] });
  });
});

describe('visibleChatIndices', () => {
  it('shows the first page of a group', () => {
    expect(visibleChatIndices({ indices: [0, 1, 2, 3, 4, 5, 6], limit: 5, openIndex: undefined })).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('keeps the open chat even when it falls past the limit', () => {
    expect(visibleChatIndices({ indices: [0, 1, 2, 3, 4, 5, 6], limit: 5, openIndex: 6 })).toEqual([0, 1, 2, 3, 4, 6]);
  });

  it('grows with the limit', () => {
    expect(visibleChatIndices({ indices: [0, 1, 2, 3, 4, 5, 6], limit: 10, openIndex: undefined })).toHaveLength(7);
  });
});

describe('filterIndicesByTitle', () => {
  const threadIds = ['a', 'b', 'c'];
  const threadItems = [
    { id: 'a', title: 'Plan the Trip' },
    { id: 'b', title: 'Groceries' },
    { id: 'c', title: null },
  ];

  it('keeps every index for a blank query', () => {
    expect(filterIndicesByTitle({ indices: [0, 1, 2], threadIds, threadItems, query: '   ' })).toEqual([0, 1, 2]);
  });

  it('matches titles that contain the query, ignoring case', () => {
    expect(filterIndicesByTitle({ indices: [0, 1, 2], threadIds, threadItems, query: 'trip' })).toEqual([0]);
    expect(filterIndicesByTitle({ indices: [0, 1, 2], threadIds, threadItems, query: 'GROC' })).toEqual([1]);
  });
});

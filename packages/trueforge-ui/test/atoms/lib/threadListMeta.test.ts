import { describe, expect, it } from 'vitest';

import {
  canReuseMutableShell,
  filterIndicesByTitle,
  formatRelativeShort,
  readThreadAgentName,
  readThreadIsMutable,
  splitIndicesByDay,
  threadListIndicesByRecency,
  threadListItemIsMutable,
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

describe('splitIndicesByDay', () => {
  // Local midnight is the boundary, so the test builds its dates in local time.
  const now = new Date(2026, 9, 23, 14, 0, 0);
  const threadIds = ['a', 'b', 'c', 'd'];
  const threadItems = [
    { id: 'a', lastMessageAt: new Date(2026, 9, 23, 9, 0, 0) },
    { id: 'b', lastMessageAt: new Date(2026, 9, 22, 23, 59, 0) },
    { id: 'c', lastMessageAt: null },
    { id: 'd', lastMessageAt: new Date(2026, 9, 23, 0, 0, 0), remoteId: 'remote-d' },
  ];

  it('puts chats used since local midnight under today, and older ones under earlier', () => {
    expect(splitIndicesByDay({ indices: [0, 1, 2, 3], threadIds, threadItems, now })).toEqual({
      today: [0, 2, 3],
      earlier: [1],
    });
  });

  it('keeps the order of the indices it is given', () => {
    expect(splitIndicesByDay({ indices: [3, 1, 0], threadIds, threadItems, now })).toEqual({
      today: [3, 0],
      earlier: [1],
    });
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

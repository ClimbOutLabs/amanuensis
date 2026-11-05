// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHAT_ANSWERS_SEEN_STORAGE_KEY } from '@/chatAnswers/answerMarks.js';
import { ChatAnswerMarksProvider } from '@/chatAnswers/ChatAnswerMarksContext.js';
import type { ChatAnswerMark, ChatAnswerMarksApi } from '@/chatAnswers/types.js';
import { ThreadListContainer } from '@/containers/ThreadListContainer.js';

const { loadMore, runtimeState } = vi.hoisted(() => ({
  loadMore: vi.fn().mockResolvedValue(undefined),
  runtimeState: {
    mainThreadId: 't1',
    threadIds: ['t1'],
    threadItems: [{ id: 't1', remoteId: 's1', lastMessageAt: undefined, custom: { isMutable: false } }],
  },
}));

class ResizeObserverMock implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    threads: () => ({
      loadMore,
      switchToThread: vi.fn(),
      switchToNewThread: vi.fn(),
    }),
  }),
  useAuiState: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      threads: {
        isLoading: false,
        isLoadingMore: false,
        hasMore: false,
        threadIds: runtimeState.threadIds,
        threadItems: runtimeState.threadItems,
        mainThreadId: runtimeState.mainThreadId,
      },
      threadListItem: {
        id: 't1',
        remoteId: 's1',
        title: 'Session',
        lastMessageAt: undefined,
        custom: undefined,
      },
    }),
  ThreadListItemByIndexProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ThreadListPrimitive: {
    Root: ({ children, className }: { children?: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
  ThreadListItemPrimitive: {
    Root: ({ children, className }: { children?: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    Delete: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  },
  ThreadListItemMorePrimitive: {
    Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
    Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  },
}));

vi.mock('@/server/ServerContext.js', () => ({
  useOptionalServer: () => undefined,
  useOptionalAgentSessionsServer: () => null,
  useOptionalPermissionsServer: () => null,
  useOptionalScheduleServer: () => null,
}));

vi.mock('@/server/ShellModeContext.js', () => ({
  useOptionalShellMode: () => ({
    isLibraryEnabled: false,
    isNewChatEnabled: true,
    isComposerEnabled: false,
    mode: {
      status: 'active',
      isMutable: false,
      isCreateAgent: false,
      agentName: 'agent',
      agentId: 'agent',
      locked: false,
    },
    setSettingsOpen: vi.fn(),
    setLibraryOpen: vi.fn(),
    setSchedulesOpen: vi.fn(),
    setSessionsOpen: vi.fn(),
    selectLibraryAgent: vi.fn(),
    openDraft: vi.fn(),
    openAgentBuilder: vi.fn(),
    openHistorySession: vi.fn(),
  }),
}));

const POLL_MS = 1_000;
const T1 = '2026-11-03T10:00:00.000Z';
const T2 = '2026-11-03T12:00:00.000Z';

function fakeApi(initial: ChatAnswerMark[]) {
  const state = { marks: initial };
  const api: ChatAnswerMarksApi = {
    listAnswerMarks: vi.fn(() => Promise.resolve([...state.marks])),
  };
  return { api, state };
}

function tree(api: ChatAnswerMarksApi) {
  return (
    <ChatAnswerMarksProvider api={api} pollMs={POLL_MS}>
      <ThreadListContainer />
    </ChatAnswerMarksProvider>
  );
}

function dot() {
  return screen.queryByRole('img', { name: 'New in this chat' });
}

beforeEach(() => {
  window.localStorage.clear();
  runtimeState.mainThreadId = 't1';
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ThreadListContainer unseen-answer dot', () => {
  it('marks the open chat seen on every stamp update while it stays open', async () => {
    window.localStorage.setItem(CHAT_ANSWERS_SEEN_STORAGE_KEY, JSON.stringify({ s1: T1 }));
    const { api, state } = fakeApi([{ sessionId: 's1', answeredAt: T1 }]);
    render(tree(api));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(dot()).not.toBeInTheDocument();

    // A new answer lands; its stamp reaches this browser while the chat is open,
    // and the person is looking at it, so it must never dot the chat afterwards.
    state.marks = [{ sessionId: 's1', answeredAt: T2 }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(dot()).not.toBeInTheDocument();
    expect(window.localStorage.getItem(CHAT_ANSWERS_SEEN_STORAGE_KEY)).toBe(JSON.stringify({ s1: T2 }));
  });

  it('dots a chat that is not open and clears the dot when the chat opens', async () => {
    window.localStorage.setItem(CHAT_ANSWERS_SEEN_STORAGE_KEY, JSON.stringify({ s1: T1 }));
    runtimeState.mainThreadId = 't-other';
    const { api } = fakeApi([{ sessionId: 's1', answeredAt: T2 }]);
    const { rerender } = render(tree(api));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(dot()).toBeInTheDocument();

    runtimeState.mainThreadId = 't1';
    rerender(tree(api));

    expect(dot()).not.toBeInTheDocument();
    expect(window.localStorage.getItem(CHAT_ANSWERS_SEEN_STORAGE_KEY)).toBe(JSON.stringify({ s1: T2 }));
  });
});

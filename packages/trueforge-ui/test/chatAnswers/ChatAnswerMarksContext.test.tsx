// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatAnswerMarksProvider, useOptionalChatAnswerMarks } from '@/chatAnswers/ChatAnswerMarksContext.js';
import { CHAT_ANSWERS_SEEN_STORAGE_KEY } from '@/chatAnswers/answerMarks.js';
import type { ChatAnswerMark, ChatAnswerMarksApi } from '@/chatAnswers/types.js';

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

function Marks() {
  const marks = useOptionalChatAnswerMarks();
  return (
    <div>
      <p data-testid="unseen">{[...(marks?.unseenAnswerChatIds ?? [])].sort().join(',')}</p>
      <button type="button" onClick={() => marks?.markAnswerSeen('chat-a')}>
        Open chat a
      </button>
    </div>
  );
}

function renderMarks(api: ChatAnswerMarksApi) {
  return render(
    <ChatAnswerMarksProvider api={api} pollMs={POLL_MS}>
      <Marks />
    </ChatAnswerMarksProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the unseen-answer marks', () => {
  it('does not dot chats on a first run: answers that already exist count as seen', async () => {
    const { api } = fakeApi([{ sessionId: 'chat-a', answeredAt: T1 }]);
    renderMarks(api);

    await waitFor(() => expect(api.listAnswerMarks).toHaveBeenCalled());
    expect(screen.getByTestId('unseen').textContent).toBe('');
    expect(window.localStorage.getItem(CHAT_ANSWERS_SEEN_STORAGE_KEY)).toBe(JSON.stringify({ 'chat-a': T1 }));
  });

  it('dots a chat when a new answer lands, and opening the chat clears the dot', async () => {
    vi.useFakeTimers();
    const { api, state } = fakeApi([{ sessionId: 'chat-a', answeredAt: T1 }]);
    renderMarks(api);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('unseen').textContent).toBe('');

    state.marks = [{ sessionId: 'chat-a', answeredAt: T2 }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(screen.getByTestId('unseen').textContent).toBe('chat-a');

    fireEvent.click(screen.getByRole('button', { name: 'Open chat a' }));
    expect(screen.getByTestId('unseen').textContent).toBe('');
    expect(window.localStorage.getItem(CHAT_ANSWERS_SEEN_STORAGE_KEY)).toBe(JSON.stringify({ 'chat-a': T2 }));
  });

  it('dots only the chats answered after the record this browser already kept', async () => {
    window.localStorage.setItem(CHAT_ANSWERS_SEEN_STORAGE_KEY, JSON.stringify({ 'chat-a': T1, 'chat-b': T2 }));
    const { api } = fakeApi([
      { sessionId: 'chat-a', answeredAt: T2 },
      { sessionId: 'chat-b', answeredAt: T2 },
    ]);
    renderMarks(api);

    await waitFor(() => expect(screen.getByTestId('unseen').textContent).toBe('chat-a'));
  });

  it('records nothing for a chat opened before any stamp for it is known', async () => {
    vi.useFakeTimers();
    const { api, state } = fakeApi([]);
    renderMarks(api);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.listAnswerMarks).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open chat a' }));
    expect(window.localStorage.getItem(CHAT_ANSWERS_SEEN_STORAGE_KEY)).toBe(JSON.stringify({}));

    // The stamp arrives on a later check, and the earlier open does not hide it.
    state.marks = [{ sessionId: 'chat-a', answeredAt: T1 }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(screen.getByTestId('unseen').textContent).toBe('chat-a');
  });

  it('keeps another tab’s marks when writing its own', async () => {
    window.localStorage.setItem(CHAT_ANSWERS_SEEN_STORAGE_KEY, JSON.stringify({ 'chat-a': T1 }));
    const { api } = fakeApi([{ sessionId: 'chat-a', answeredAt: T2 }]);
    renderMarks(api);
    await waitFor(() => expect(screen.getByTestId('unseen').textContent).toBe('chat-a'));

    // Another tab records a different chat after this tab loaded its record.
    window.localStorage.setItem(CHAT_ANSWERS_SEEN_STORAGE_KEY, JSON.stringify({ 'chat-a': T1, 'chat-b': T2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Open chat a' }));

    expect(window.localStorage.getItem(CHAT_ANSWERS_SEEN_STORAGE_KEY)).toBe(
      JSON.stringify({ 'chat-a': T2, 'chat-b': T2 }),
    );
  });

  it('takes in marks another tab records, through the storage event', async () => {
    window.localStorage.setItem(CHAT_ANSWERS_SEEN_STORAGE_KEY, JSON.stringify({ 'chat-a': T1 }));
    const { api } = fakeApi([{ sessionId: 'chat-a', answeredAt: T2 }]);
    renderMarks(api);
    await waitFor(() => expect(screen.getByTestId('unseen').textContent).toBe('chat-a'));

    act(() => {
      window.localStorage.setItem(CHAT_ANSWERS_SEEN_STORAGE_KEY, JSON.stringify({ 'chat-a': T2 }));
      window.dispatchEvent(new StorageEvent('storage', { key: CHAT_ANSWERS_SEEN_STORAGE_KEY }));
    });

    expect(screen.getByTestId('unseen').textContent).toBe('');
  });
});

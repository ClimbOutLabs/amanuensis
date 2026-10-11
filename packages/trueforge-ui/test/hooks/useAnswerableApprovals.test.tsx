// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { thread, runtimePending } = vi.hoisted(() => ({
  thread: { messages: [] as unknown[] },
  runtimePending: { current: [] as Array<{ approvalId: string }> },
}));

vi.mock('@assistant-ui/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return {
    ...actual,
    useAuiState: (selector: (state: unknown) => unknown) => selector({ thread }),
  };
});

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryApprovals: () => ({ pending: runtimePending.current, respond: vi.fn() }),
}));

import { useAnswerableApprovals } from '@/hooks/useAnswerableApprovals.js';

function call(id: string) {
  return { type: 'tool-call', toolCallId: id, toolName: 'web_search', approval: { id, approved: undefined } };
}

describe('useAnswerableApprovals', () => {
  it('drops a card left pending on the first turn of a chat that moved on', () => {
    thread.messages = [
      { role: 'assistant', content: [call('old')] },
      { role: 'user', content: [] },
      { role: 'assistant', content: [] },
    ];
    runtimePending.current = [{ approvalId: 'old' }];

    const { result } = renderHook(() => useAnswerableApprovals());

    expect(result.current.pending).toEqual([]);
  });

  it('keeps cards on the newest message, including a sub-agent call', () => {
    thread.messages = [
      { role: 'assistant', content: [call('old')] },
      {
        role: 'assistant',
        content: [
          call('now'),
          {
            type: 'tool-call',
            toolName: 'create_sub_agent',
            messages: [{ role: 'assistant', content: [call('nested')] }],
          },
        ],
      },
    ];
    runtimePending.current = [{ approvalId: 'old' }, { approvalId: 'now' }, { approvalId: 'nested' }];

    const { result } = renderHook(() => useAnswerableApprovals());

    expect(result.current.pending.map(item => item.approvalId)).toEqual(['now', 'nested']);
  });

  it('keeps nothing when the chat has no messages', () => {
    thread.messages = [];
    runtimePending.current = [{ approvalId: 'old' }];

    const { result } = renderHook(() => useAnswerableApprovals());

    expect(result.current.pending).toEqual([]);
  });
});

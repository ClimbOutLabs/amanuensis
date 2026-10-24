// @vitest-environment jsdom
//
// Cancel must take the chat out of the running state within a few seconds, even when the server
// never confirms by ending the turn's stream, and keep what the turn already showed.
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentChatServer, Session, TurnStreamData } from '@truefoundry/assistant-ui-runtime/server';
import { describe, expect, it, vi } from 'vitest';

import { useTrueFoundryAgentMessages } from '../node_modules/@truefoundry/assistant-ui-runtime/src/useTrueFoundryAgentMessages.js';

const sessionId = 'cancel-leaves-running-session';
const rootThreadId = 'main';
const createdAt = '2026-10-22T00:00:00.000Z';

/** The turn's opening events, then a stream that never ends: a server that never confirms Cancel. */
async function* stuckTurn(): AsyncGenerator<TurnStreamData> {
  yield {
    sequenceNumber: 0,
    event: {
      type: 'turn.created' as const,
      id: 'created-1',
      turnId: 'turn-1',
      input: [],
      state: { status: 'running' as const },
      createdAt,
    },
  };
  yield {
    sequenceNumber: 1,
    event: {
      type: 'model.message' as const,
      id: 'model-1',
      threadId: rootThreadId,
      content: 'Searching the web first.',
      createdAt,
    },
  };
  await new Promise<never>(() => undefined);
}

function stuckServer(cancelSession: AgentChatServer['cancelSession']): AgentChatServer {
  return {
    createSession: async () => {
      throw new Error('createSession is not used by this fixture');
    },
    listSessions: async () => ({ data: [] }),
    getSession: async ({ sessionId: id }): Promise<Session> => ({
      id,
      agentName: 'agent',
      isMutable: false,
      createdAt,
      updatedAt: createdAt,
    }),
    updateSession: async () => {
      throw new Error('updateSession is not used by this fixture');
    },
    cancelSession,
    listTurns: async () => ({ data: [] }),
    getTurn: async () => {
      throw new Error('getTurn is not used by this fixture');
    },
    listEvents: async () => ({ data: [] }),
    createTurn: () => stuckTurn(),
  };
}

async function startStuckTurn(cancelSession: AgentChatServer['cancelSession']) {
  const server = stuckServer(cancelSession);
  const hook = renderHook(() => useTrueFoundryAgentMessages({ server, sessionId, isMain: true }));
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  act(() => {
    void hook.result.current.sendTurn({ userMessage: 'What is on in town tonight?' });
  });
  await waitFor(() => expect(hook.result.current.isRunning).toBe(true));
  await waitFor(() =>
    expect(JSON.stringify(hook.result.current.messages.at(-1)?.content)).toContain('Searching the web first.'),
  );
  return hook;
}

describe('Cancel when the server does not confirm', () => {
  it('leaves the running state after the wait and keeps what the turn showed', async () => {
    const cancelSession = vi.fn(async () => undefined);
    const { result } = await startStuckTurn(cancelSession);

    vi.useFakeTimers();
    try {
      let cancelled: Promise<void> | undefined;
      act(() => {
        cancelled = result.current.cancel();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await cancelled;
      });
    } finally {
      vi.useRealTimers();
    }

    expect(cancelSession).toHaveBeenCalledWith({ sessionId });
    await waitFor(() => expect(result.current.isRunning).toBe(false));
    expect(JSON.stringify(result.current.messages.at(-1)?.content)).toContain('Searching the web first.');
  });

  it('leaves the running state even when the cancel request itself never answers', async () => {
    const cancelSession = vi.fn(() => new Promise<void>(() => undefined));
    const { result } = await startStuckTurn(cancelSession);

    vi.useFakeTimers();
    try {
      let cancelled: Promise<void> | undefined;
      act(() => {
        cancelled = result.current.cancel();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await cancelled;
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => expect(result.current.isRunning).toBe(false));
  });
});

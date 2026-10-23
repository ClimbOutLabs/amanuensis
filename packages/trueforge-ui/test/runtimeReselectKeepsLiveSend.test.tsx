// @vitest-environment jsdom
//
// Selecting a chat again while its send is still in flight must keep that send: the server may
// not have created the turn yet, so reloading from it would drop the message and the reply.
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentChatServer, Session, TurnStreamData } from '@truefoundry/assistant-ui-runtime/server';
import { describe, expect, it, vi } from 'vitest';

import { useTrueFoundryAgentMessages } from '../node_modules/@truefoundry/assistant-ui-runtime/src/useTrueFoundryAgentMessages.js';

const sessionId = 'reselect-keeps-live-send-session';
const createdAt = '2026-10-23T00:00:00.000Z';

/** A server slow to start the reply: the turn exists only once `start` is called. */
function slowServer(): { server: AgentChatServer; start: () => void; listTurns: ReturnType<typeof vi.fn> } {
  let start: () => void = () => undefined;
  const started = new Promise<void>(resolve => {
    start = resolve;
  });
  async function* slowTurn(): AsyncGenerator<TurnStreamData> {
    await started;
    yield {
      sequenceNumber: 0,
      event: {
        type: 'turn.created' as const,
        id: 'created-1',
        turnId: 'turn-1',
        input: [{ type: 'user.message' as const, content: 'Plan my week' }],
        state: { status: 'running' as const },
        createdAt,
      },
    };
    yield {
      sequenceNumber: 1,
      event: {
        type: 'model.message' as const,
        id: 'model-1',
        threadId: 'main',
        content: 'Looking at your calendar first.',
        createdAt,
      },
    };
    await new Promise<never>(() => undefined);
  }
  const listTurns = vi.fn(async () => ({ data: [] }));
  const server: AgentChatServer = {
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
    cancelSession: async () => undefined,
    listTurns,
    getTurn: async () => {
      throw new Error('getTurn is not used by this fixture');
    },
    listEvents: async () => ({ data: [] }),
    createTurn: () => slowTurn(),
  };
  return { server, start, listTurns };
}

describe('selecting a chat again while its send is in flight', () => {
  it('keeps the message and shows the reply once the server starts it', async () => {
    const { server, start, listTurns } = slowServer();
    const hook = renderHook(
      ({ isMain }: { isMain: boolean }) => useTrueFoundryAgentMessages({ server, sessionId, isMain }),
      {
        initialProps: { isMain: true },
      },
    );
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    const loadsBefore = listTurns.mock.calls.length;

    act(() => {
      void hook.result.current.sendTurn({ userMessage: 'Plan my week' });
    });
    await waitFor(() => expect(hook.result.current.isRunning).toBe(true));

    // The person opens another chat, then this one again, before the server has the turn.
    hook.rerender({ isMain: false });
    hook.rerender({ isMain: true });
    act(() => start());

    await waitFor(() =>
      expect(JSON.stringify(hook.result.current.messages.at(-1)?.content)).toContain('Looking at your calendar first.'),
    );
    expect(JSON.stringify(hook.result.current.messages)).toContain('Plan my week');
    expect(hook.result.current.isRunning).toBe(true);
    expect(listTurns.mock.calls.length).toBe(loadsBefore);
  });

  it('still reloads when the chat asks for it, as a resync after a lost connection does', async () => {
    const { server, listTurns } = slowServer();
    const hook = renderHook(() => useTrueFoundryAgentMessages({ server, sessionId, isMain: true }));
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    act(() => {
      void hook.result.current.sendTurn({ userMessage: 'Plan my week' });
    });
    await waitFor(() => expect(hook.result.current.isRunning).toBe(true));
    const loadsBefore = listTurns.mock.calls.length;

    act(() => hook.result.current.retryLoad());

    await waitFor(() => expect(listTurns.mock.calls.length).toBe(loadsBefore + 1));
  });
});

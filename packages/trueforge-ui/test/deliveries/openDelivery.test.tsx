// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { openDeliveryLink } from '@/deliveries/openDelivery.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import type { AgentUIServer } from '@/server/types.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

type GetSession = AgentUIServer['getSession'];

function setup(getSession: GetSession) {
  const server = createMockAgentUIServer({ getSession });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServerProvider server={server}>
      <ShellModeProvider>{children}</ShellModeProvider>
    </ServerProvider>
  );
  const { result } = renderHook(() => useShellMode(), { wrapper });
  return { server, result };
}

const loadedSession: GetSession = async ({ sessionId }) => ({
  id: sessionId,
  title: 'Reminders',
  isMutable: false,
  agentName: 'helper',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

describe('opening what a bell item leads to', () => {
  it('looks the chat up first and opens it with its own agent and mutability', async () => {
    const getSession = vi.fn(loadedSession);
    const { server, result } = setup(getSession);

    let outcome: Awaited<ReturnType<typeof openDeliveryLink>> | undefined;
    await act(async () => {
      outcome = await openDeliveryLink({ shell: result.current, server, link: { type: 'chat', sessionId: 'sess-1' } });
    });

    expect(outcome).toEqual({ opened: true });
    expect(getSession).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    expect(result.current.pendingSessionId).toBe('sess-1');
    expect(result.current.mode).toMatchObject({ isMutable: false, agentName: 'helper' });
  });

  it('opens an approval link as the chat that holds the card', async () => {
    const getSession = vi.fn(loadedSession);
    const { server, result } = setup(getSession);

    await act(async () => {
      await openDeliveryLink({
        shell: result.current,
        server,
        link: { type: 'approval', sessionId: 'sess-2', approvalId: 'appr-1' },
      });
    });

    expect(getSession).toHaveBeenCalledWith({ sessionId: 'sess-2' });
    expect(result.current.pendingSessionId).toBe('sess-2');
    expect(result.current.mode).toMatchObject({ isMutable: false, agentName: 'helper' });
  });

  it('opens a mutable chat as mutable', async () => {
    const getSession: GetSession = async ({ sessionId }) => ({
      id: sessionId,
      title: 'Draft',
      isMutable: true,
      agentName: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { server, result } = setup(getSession);

    await act(async () => {
      await openDeliveryLink({ shell: result.current, server, link: { type: 'chat', sessionId: 'sess-3' } });
    });

    expect(result.current.pendingSessionId).toBe('sess-3');
    expect(result.current.mode).toMatchObject({ isMutable: true });
  });

  it('says the chat was deleted when the server has forgotten it, and opens nothing', async () => {
    const gone = new Error('Session not found: sess-gone');
    gone.name = 'NotFoundError';
    const getSession = vi.fn(async (): Promise<never> => {
      throw gone;
    });
    const { server, result } = setup(getSession);

    let outcome: Awaited<ReturnType<typeof openDeliveryLink>> | undefined;
    await act(async () => {
      outcome = await openDeliveryLink({
        shell: result.current,
        server,
        link: { type: 'chat', sessionId: 'sess-gone' },
      });
    });

    expect(getSession).toHaveBeenCalledWith({ sessionId: 'sess-gone' });
    expect(outcome).toEqual({ opened: false, message: 'This chat was deleted' });
    expect(result.current.pendingSessionId).toBeUndefined();
    expect(result.current.mode).toMatchObject({ isMutable: true });
  });

  it('says to try again when the chat cannot be loaded for another reason', async () => {
    const getSession = vi.fn(async (): Promise<never> => {
      throw new Error('network down');
    });
    const { server, result } = setup(getSession);

    let outcome: Awaited<ReturnType<typeof openDeliveryLink>> | undefined;
    await act(async () => {
      outcome = await openDeliveryLink({ shell: result.current, server, link: { type: 'chat', sessionId: 'sess-1' } });
    });

    expect(outcome).toEqual({ opened: false, message: 'Could not open the chat. Try again' });
    expect(result.current.pendingSessionId).toBeUndefined();
  });

  it('opens a space without looking up any chat', async () => {
    const getSession = vi.fn(loadedSession);
    const { server, result } = setup(getSession);

    await act(async () => {
      await openDeliveryLink({ shell: result.current, server, link: { type: 'space', spaceId: 'space-1' } });
    });

    expect(getSession).not.toHaveBeenCalled();
    expect(result.current.spacesOpen).toBe(true);
    expect(result.current.selectedSpaceId).toBe('space-1');
  });
});

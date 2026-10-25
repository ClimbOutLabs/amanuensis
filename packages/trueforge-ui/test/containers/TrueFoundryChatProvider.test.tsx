// @vitest-environment jsdom
import { useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import { act, render, screen } from '@testing-library/react';
import {
  trueFoundryAttachmentAdapter,
  type TrueFoundryAgentConfig,
  type UseTrueFoundryAgentRuntimeOptions,
} from '@truefoundry/assistant-ui-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAgentUIServer } from '../server/mockServer.js';

const runtimeSpy = vi.hoisted(() => vi.fn<(options: UseTrueFoundryAgentRuntimeOptions) => void>());
const reloadSpy = vi.hoisted(() => vi.fn());
const loadedChat = vi.hoisted(() => ({
  messages: [] as { id: string; role: 'user'; content: string }[],
  cancelledTurn: undefined as { turnId: string; reason: string } | undefined,
}));
const defaultAttachmentAdapter = vi.hoisted(() => ({
  accept: 'image/*,application/pdf',
  add: vi.fn(),
  remove: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@truefoundry/assistant-ui-runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('@truefoundry/assistant-ui-runtime')>()),
  trueFoundryAttachmentAdapter: defaultAttachmentAdapter,
  useTrueFoundryAgentRuntime: (options: UseTrueFoundryAgentRuntimeOptions) => {
    runtimeSpy(options);
    // Called from ChatRuntimeScope (a React component), so hooks are valid here.
    return useExternalStoreRuntime<ThreadMessageLike>({
      messages: loadedChat.messages,
      isRunning: false,
      convertMessage: (message: ThreadMessageLike) => message,
      onNew: async () => {},
    });
  },
  useTrueFoundryReload: () => reloadSpy,
  useTrueFoundryCancelledTurn: () => loadedChat.cancelledTurn,
}));

import { DEFAULT_ASSISTANT_NAME } from '@truefoundry/trueforge-core/core/personas/assistantName';

import { ChatNoticeContainer } from '@/containers/ChatNoticeContainer.js';
import { TrueFoundryChatProvider } from '@/containers/TrueFoundryChatProvider.js';
import { ComposerBusyProvider } from '@/hooks/useComposerBusyState.js';
import { LiveConnectionLostError, ReplyStoppedByRestartError } from '@/utils/liveConnection.js';
import { sendRefusalText, type TurnRefusalCode } from '@/utils/turnRefusal.js';

function renderWithNotice(onError: (error: unknown) => void) {
  render(
    <TrueFoundryChatProvider server={createMockAgentUIServer()} agentName="my-agent" onError={onError}>
      <ComposerBusyProvider>
        <ChatNoticeContainer />
      </ComposerBusyProvider>
    </TrueFoundryChatProvider>,
  );
  const forwardedOnError = runtimeSpy.mock.calls[0]?.[0]?.onError;
  if (forwardedOnError === undefined) throw new Error('Expected runtime onError handler');
  return forwardedOnError;
}

describe('TrueFoundryChatProvider', () => {
  beforeEach(() => {
    runtimeSpy.mockClear();
    reloadSpy.mockClear();
    loadedChat.messages = [];
    loadedChat.cancelledTurn = undefined;
  });

  it('resyncs a dropped reply stream instead of reporting it as an error', async () => {
    const onError = vi.fn();
    render(
      <TrueFoundryChatProvider server={createMockAgentUIServer()} agentName="my-agent" onError={onError}>
        <div>chat-child</div>
      </TrueFoundryChatProvider>,
    );
    const forwardedOnError = runtimeSpy.mock.calls[0]?.[0]?.onError;

    await act(async () => {
      forwardedOnError?.(new LiveConnectionLostError({ cause: new TypeError('network error') }));
      await Promise.resolve();
    });

    expect(onError).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it.each<[TurnRefusalCode, number]>([
    ['previous_turn_running', 1],
    ['turn_could_not_start', 0],
  ])('says in one line in the chat why a send was refused (%s), never the server text', async (code, reloads) => {
    const onError = vi.fn();
    const forwardedOnError = renderWithNotice(onError);
    const refused = Object.assign(new Error('Previous turn 01m5 is still running; freezeAndGetTurn must be called'), {
      statusCode: 409,
      body: { error: { message: 'Previous turn 01m5 is still running', type: 'conflict', code } },
    });

    await act(async () => {
      forwardedOnError(refused);
      await Promise.resolve();
    });

    // Not reported as an error, so the typed text stays and no toast repeats the line.
    expect(onError).not.toHaveBeenCalled();
    // Only a reply still running is there to re-attach to.
    expect(reloadSpy).toHaveBeenCalledTimes(reloads);
    expect(screen.getByRole('status')).toHaveTextContent(
      sendRefusalText({ refusal: code, assistantName: DEFAULT_ASSISTANT_NAME }),
    );
    expect(screen.queryByText(/freezeAndGetTurn/)).not.toBeInTheDocument();
  });

  it('says in one line that a restart stopped the reply instead of reporting an error', async () => {
    const onError = vi.fn();
    const forwardedOnError = renderWithNotice(onError);

    await act(async () => {
      forwardedOnError(new ReplyStoppedByRestartError({ cause: new Error('Request failed (412)') }));
      await Promise.resolve();
    });

    expect(onError).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      sendRefusalText({ refusal: 'stopped_by_restart', assistantName: DEFAULT_ASSISTANT_NAME }),
    );
  });

  it('says it once when the page saw the restart and the chat also loaded it', async () => {
    loadedChat.messages = [{ id: 'turn-restarted-user', role: 'user', content: 'Tell me about Lantern Row' }];
    loadedChat.cancelledTurn = { turnId: 'turn-restarted', reason: 'abandoned' };
    const forwardedOnError = renderWithNotice(vi.fn());
    const line = sendRefusalText({ refusal: 'stopped_by_restart', assistantName: DEFAULT_ASSISTANT_NAME });
    expect(screen.getAllByText(line)).toHaveLength(1);

    await act(async () => {
      forwardedOnError(new ReplyStoppedByRestartError({ cause: new Error('Request failed (412)') }));
      await Promise.resolve();
    });

    expect(screen.getAllByText(line)).toHaveLength(1);
  });

  it('forwards legacy runtime options and supplies the default attachment adapter', () => {
    const server = createMockAgentUIServer();
    const onError = vi.fn();

    render(
      <TrueFoundryChatProvider server={server} agentName="my-agent" initialSessionId="session-123" onError={onError}>
        <div>chat-child</div>
      </TrueFoundryChatProvider>,
    );

    expect(screen.getByText('chat-child')).toBeInTheDocument();
    expect(runtimeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'my-agent',
        initialSessionId: 'session-123',
        listSessionsCreatedByMe: true,
        // The default adapter is wrapped so attached images are downscaled before upload: same
        // accept list and methods, but a different `add`.
        adapters: { attachments: expect.objectContaining({ accept: defaultAttachmentAdapter.accept }) },
      }),
    );
    const forwardedAttachments = runtimeSpy.mock.calls[0]?.[0]?.adapters?.attachments;
    expect(forwardedAttachments).not.toBe(defaultAttachmentAdapter);
    expect(forwardedAttachments?.add).not.toBe(defaultAttachmentAdapter.add);
    expect(forwardedAttachments?.send).toBe(defaultAttachmentAdapter.send);
    expect(runtimeSpy.mock.calls[0]?.[0]?.server).not.toBe(server);
    const forwardedOnError = runtimeSpy.mock.calls[0]?.[0]?.onError;
    expect(typeof forwardedOnError).toBe('function');
    expect(forwardedOnError).not.toBe(onError);

    act(() => {
      forwardedOnError?.(new Error('createSession failed'));
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('turns a chat read that never reached the server into a lost connection, and leaves other errors alone', async () => {
    const listEvents = vi.fn(async () => {
      throw new TypeError('Load failed');
    });
    const getTurn = vi.fn(async () => {
      throw Object.assign(new Error('Status code: 404'), { statusCode: 404 });
    });
    render(
      <TrueFoundryChatProvider server={createMockAgentUIServer({ listEvents, getTurn })} agentName="my-agent">
        <div>chat-child</div>
      </TrueFoundryChatProvider>,
    );
    const runtimeServer = runtimeSpy.mock.calls[0]?.[0]?.server;
    if (runtimeServer === undefined) throw new Error('Expected runtime server');

    await expect(runtimeServer.listEvents({ sessionId: 'ses_1' })).rejects.toBeInstanceOf(LiveConnectionLostError);
    await expect(runtimeServer.getTurn({ sessionId: 'ses_1', turnId: 'trn_1' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('filters create-agent sessions from runtime history', async () => {
    const listSessions = vi.fn(async () => ({
      data: [
        {
          id: 'chat-session',
          title: 'Chat',
          isMutable: true,
          createdAt: '2026-09-09T00:00:00.000Z',
          updatedAt: '2026-09-09T00:00:00.000Z',
        },
        {
          id: 'builder-session',
          title: 'Builder',
          isMutable: true,
          metadata: { is_create_agent: 'true' },
          createdAt: '2026-09-09T00:00:00.000Z',
          updatedAt: '2026-09-09T00:00:00.000Z',
        },
      ],
      nextPageToken: 'next-page',
    }));

    render(
      <TrueFoundryChatProvider server={createMockAgentUIServer({ listSessions })} agentName="my-agent">
        <div>chat-child</div>
      </TrueFoundryChatProvider>,
    );

    const runtimeServer = runtimeSpy.mock.calls[0]?.[0]?.server;
    if (runtimeServer === undefined) {
      throw new Error('Expected runtime server');
    }
    const result = await runtimeServer.listSessions();

    expect(result.data.map(session => session.id)).toEqual(['chat-session']);
    expect(result.nextPageToken).toBe('next-page');
  });

  it('wraps session creation used for local ownership tracking', async () => {
    const createSession = vi.fn(async () => ({
      id: 'new-session',
      isMutable: false,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    }));
    render(
      <TrueFoundryChatProvider server={createMockAgentUIServer({ createSession })} agentName="my-agent">
        <div>chat-child</div>
      </TrueFoundryChatProvider>,
    );
    const runtimeServer = runtimeSpy.mock.calls[0]?.[0]?.server;
    if (runtimeServer === undefined) throw new Error('Expected runtime server');

    await expect(runtimeServer.createSession({ agentName: 'my-agent' })).resolves.toEqual({
      id: 'new-session',
      isMutable: false,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
    expect(createSession).toHaveBeenCalledWith({ agentName: 'my-agent' });
  });

  it('forwards a discriminated agent configuration', () => {
    const agent: TrueFoundryAgentConfig = {
      mode: 'named',
      agentName: 'configured-agent',
    };

    render(
      <TrueFoundryChatProvider server={createMockAgentUIServer()} agent={agent}>
        <div>chat-child</div>
      </TrueFoundryChatProvider>,
    );

    expect(runtimeSpy).toHaveBeenCalledWith(expect.objectContaining({ agent }));
  });

  it('preserves a consumer-provided attachment adapter', () => {
    const attachmentAdapter = { ...trueFoundryAttachmentAdapter };

    render(
      <TrueFoundryChatProvider
        server={createMockAgentUIServer()}
        agentName="my-agent"
        adapters={{ attachments: attachmentAdapter }}
      >
        <div>chat-child</div>
      </TrueFoundryChatProvider>,
    );

    expect(runtimeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adapters: { attachments: attachmentAdapter },
      }),
    );
  });

  it('uses the toaster as the default runtime error handler', async () => {
    render(
      <TrueFoundryChatProvider server={createMockAgentUIServer()} agentName="my-agent">
        <div>chat-child</div>
      </TrueFoundryChatProvider>,
    );
    const options = runtimeSpy.mock.calls[0]?.[0];
    if (options?.onError === undefined) {
      throw new Error('Expected runtime onError handler');
    }

    act(() => {
      options.onError?.(new Error('runtime failed'));
    });

    expect(await screen.findByText('runtime failed')).toBeInTheDocument();
  });
});

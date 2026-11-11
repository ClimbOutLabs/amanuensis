// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivateChatBanner } from '@/atoms/privateChat/PrivateChatBanner.js';
import {
  PRIVATE_CHAT_CHOICE_LINE,
  PRIVATE_CHAT_DELETE_WARNING,
  PRIVATE_CHAT_HOVER_LINE,
  PRIVATE_CHAT_LOCAL_LINE,
} from '@/atoms/privateChat/privateChatCopy.js';
import { PrivateChatToggle } from '@/atoms/privateChat/PrivateChatToggle.js';
import { registerPersonaMutation } from '@/personaMutationGate.js';
import {
  adoptPrivateChat,
  forgetPrivateChat,
  readPrivateChatState,
  setPendingPrivateChat,
} from '@/server/privateChatStore.js';
import { ServerProvider } from '@/server/ServerContext.js';

import { RuntimeHarness } from '../../containers/RuntimeHarness.js';
import { createMockAgentUIServer } from '../../server/mockServer.js';

afterEach(() => {
  const { openSessionId } = readPrivateChatState();
  if (openSessionId !== undefined) forgetPrivateChat(openSessionId);
  setPendingPrivateChat(false);
});

describe('PrivateChatToggle and PrivateChatBanner', () => {
  it('offers Incognito on a new chat and says what it means once chosen', () => {
    render(
      <RuntimeHarness messages={[]}>
        <PrivateChatBanner />
        <PrivateChatToggle />
      </RuntimeHarness>,
    );
    const toggle = screen.getByRole('button', { name: 'Start incognito chat' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(PRIVATE_CHAT_CHOICE_LINE)).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(PRIVATE_CHAT_CHOICE_LINE)).toBeInTheDocument();
    expect(readPrivateChatState().pending).toBe(true);
  });

  it('offers no choice once the chat exists', () => {
    render(
      <RuntimeHarness messages={[]} threadId="t1" remoteId="ses_normal">
        <PrivateChatToggle />
        <PrivateChatBanner />
      </RuntimeHarness>,
    );
    expect(screen.queryByRole('button', { name: 'Start incognito chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close and delete' })).not.toBeInTheDocument();
  });

  it('shows where the open private chat is answered, with Close and delete', async () => {
    const getChatPrivacy = vi.fn(async () => ({
      leavesMachine: true,
      hostedProviders: [{ type: 'anthropic', name: 'anthropic' }],
    }));
    const server = { ...createMockAgentUIServer(), getChatPrivacy };
    act(() => adoptPrivateChat('ses_private'));

    render(
      <ServerProvider server={server}>
        <RuntimeHarness messages={[]} threadId="t1" remoteId="ses_private">
          <PrivateChatBanner />
        </RuntimeHarness>
      </ServerProvider>,
    );

    expect(
      await screen.findByText(
        'Nothing from this chat is kept here. It is answered by Anthropic, so the words do leave this machine.',
      ),
    ).toBeInTheDocument();
    expect(getChatPrivacy).toHaveBeenCalledWith({ sessionId: 'ses_private' });
    expect(screen.getByRole('button', { name: 'Close and delete' })).toBeInTheDocument();
  });

  it('reads where the chat is answered again after a switch to a persona on a hosted model', async () => {
    let hosted = false;
    const getChatPrivacy = vi.fn(async () =>
      hosted
        ? { leavesMachine: true, hostedProviders: [{ type: 'anthropic', name: 'anthropic' }] }
        : { leavesMachine: false, hostedProviders: [] },
    );
    const server = { ...createMockAgentUIServer(), getChatPrivacy };
    act(() => adoptPrivateChat('ses_private'));
    render(
      <ServerProvider server={server}>
        <RuntimeHarness messages={[]} threadId="t1" remoteId="ses_private">
          <PrivateChatBanner />
        </RuntimeHarness>
      </ServerProvider>,
    );
    expect(await screen.findByText(PRIVATE_CHAT_LOCAL_LINE)).toBeInTheDocument();

    hosted = true;
    await act(async () => {
      registerPersonaMutation(Promise.resolve());
      await Promise.resolve();
    });

    expect(
      await screen.findByText(
        'Nothing from this chat is kept here. It is answered by Anthropic, so the words do leave this machine.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(PRIVATE_CHAT_LOCAL_LINE)).not.toBeInTheDocument();
  });

  it('reads it again when the window comes back into focus', async () => {
    const getChatPrivacy = vi.fn(async () => ({ leavesMachine: false, hostedProviders: [] }));
    const server = { ...createMockAgentUIServer(), getChatPrivacy };
    act(() => adoptPrivateChat('ses_private'));
    render(
      <ServerProvider server={server}>
        <RuntimeHarness messages={[]} threadId="t1" remoteId="ses_private">
          <PrivateChatBanner />
        </RuntimeHarness>
      </ServerProvider>,
    );
    await screen.findByText(PRIVATE_CHAT_LOCAL_LINE);
    const before = getChatPrivacy.mock.calls.length;

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await vi.waitFor(() => expect(getChatPrivacy.mock.calls.length).toBe(before + 1));
  });

  it('warns that everything is gone for good before it deletes, and Keep leaves the chat open', async () => {
    const server = {
      ...createMockAgentUIServer(),
      getChatPrivacy: vi.fn(async () => ({ leavesMachine: false, hostedProviders: [] })),
    };
    act(() => adoptPrivateChat('ses_private'));
    render(
      <ServerProvider server={server}>
        <RuntimeHarness messages={[]} threadId="t1" remoteId="ses_private">
          <PrivateChatBanner />
        </RuntimeHarness>
      </ServerProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Close and delete' }));
    const warning = (await screen.findByText(PRIVATE_CHAT_DELETE_WARNING)).closest('dialog');
    expect(warning).toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Delete for good' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(warning).not.toHaveAttribute('open');
    expect(readPrivateChatState().openSessionId).toBe('ses_private');
  });

  it('says what the Start incognito chat button does on hover', async () => {
    render(
      <RuntimeHarness messages={[]}>
        <PrivateChatToggle />
      </RuntimeHarness>,
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Start incognito chat' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(PRIVATE_CHAT_HOVER_LINE);
  });
});

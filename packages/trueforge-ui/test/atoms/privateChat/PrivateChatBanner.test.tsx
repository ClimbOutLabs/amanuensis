// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivateChatBanner } from '@/atoms/privateChat/PrivateChatBanner.js';
import { PRIVATE_CHAT_CHOICE_LINE } from '@/atoms/privateChat/privateChatCopy.js';
import { PrivateChatToggle } from '@/atoms/privateChat/PrivateChatToggle.js';
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
  it('offers Private on a new chat and says what it means once chosen', () => {
    render(
      <RuntimeHarness messages={[]}>
        <PrivateChatBanner />
        <PrivateChatToggle />
      </RuntimeHarness>,
    );
    const toggle = screen.getByRole('button', { name: 'Private chat' });
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
    expect(screen.queryByRole('button', { name: 'Private chat' })).not.toBeInTheDocument();
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
});

// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UserMessageContainer } from '@/containers/UserMessageContainer.js';
import { RuntimeHarness } from './RuntimeHarness.js';

function renderUserMessage(messages: ThreadMessageLike[], options?: { isRunning?: boolean }) {
  return render(
    <RuntimeHarness messages={messages} isRunning={options?.isRunning}>
      <ThreadPrimitive.Messages>{() => <UserMessageContainer />}</ThreadPrimitive.Messages>
    </RuntimeHarness>,
  );
}

describe('UserMessageContainer', () => {
  it('renders user text content through UserMessageBubble', () => {
    renderUserMessage([{ role: 'user', content: 'what is the capital of France?' }]);
    expect(screen.getByText('what is the capital of France?')).toHaveStyle({
      borderRadius: 'var(--composer-radius, 1.5rem)',
    });
  });

  it('renders an image attachment as a named chip until its re-encoded copy exists', () => {
    renderUserMessage([
      {
        role: 'user',
        content: 'What is this?',
        attachments: [
          {
            id: 'att-1',
            type: 'image',
            name: 'logo.png',
            contentType: 'image/png',
            status: { type: 'complete' },
            content: [
              {
                type: 'image',
                image: 'data:image/png;base64,iVBORw0KGgo=',
                filename: 'logo.png',
              },
            ],
          },
        ],
      },
    ]);
    expect(screen.getByText('What is this?')).toBeInTheDocument();
    expect(screen.getByText('logo.png')).toBeInTheDocument();
    expect(document.querySelector('img[src^="data:"]')).toBeNull();
  });

  it('renders a file attachment chip above the text bubble', () => {
    renderUserMessage([
      {
        role: 'user',
        content: 'See attached',
        attachments: [
          {
            id: 'att-1',
            type: 'file',
            name: 'report.pdf',
            contentType: 'application/pdf',
            status: { type: 'complete' },
            content: [
              {
                type: 'file',
                mimeType: 'application/pdf',
                filename: 'report.pdf',
                data: 'data:application/pdf;base64,AAAA',
              },
            ],
          },
        ],
      },
    ]);
    expect(screen.getByText('See attached')).toBeInTheDocument();
    const chip = screen.getByText('report.pdf').closest("[data-slot='aui_attachment-chip']");
    expect(chip).toHaveStyle({ maxWidth: '12rem' });
  });

  it('shows the action bar when the thread is idle', () => {
    renderUserMessage(
      [
        {
          role: 'user',
          content: 'hello',
          id: 'turn-1-user',
          createdAt: new Date('2026-07-09T14:05:42'),
        },
      ],
      { isRunning: false },
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument();
  });

  it('hides the action bar while the thread is running', () => {
    renderUserMessage([{ role: 'user', content: 'hello', id: 'turn-1-user' }], {
      isRunning: true,
    });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  describe('copy over a plain http address', () => {
    afterEach(() => {
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    });

    it('copies the message through the fallback instead of failing when navigator.clipboard is missing', async () => {
      Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      const exec = vi.fn(() => true);
      Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
      renderUserMessage([{ role: 'user', content: 'copy me' }]);
      fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
      expect(exec).toHaveBeenCalledWith('copy');
    });
  });
});

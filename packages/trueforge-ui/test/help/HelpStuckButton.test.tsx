// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PageHeader } from '@/atoms/PageHeader.js';
import { HelpProvider, useOptionalHelp, type HelpApi, type HelpSession } from '@/help/HelpProvider.js';
import { HelpStuckButton } from '@/help/HelpStuckButton.js';
import { rememberErrorText } from '@/help/lastError.js';

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ threads: () => ({ switchToNewThread: () => Promise.resolve() }) }),
  useAuiState: () => 'thread-1',
}));

const API: HelpApi = {
  getHealthCheck: () => Promise.reject(new Error('not used here')),
  ensureGuide: () => Promise.resolve(false),
};

/** Reads the help session so a test can see what the button started. */
function SessionProbe({ onSession }: { onSession: (session: HelpSession | null) => void }) {
  const help = useOptionalHelp();
  onSession(help?.session ?? null);
  return null;
}

describe('HelpStuckButton', () => {
  it('is a real button with the words "Help, I\'m stuck"', () => {
    render(
      <HelpProvider api={API}>
        <PageHeader title="Chat" helpAction />
      </HelpProvider>,
    );

    const button = screen.getByRole('button', { name: "Help, I'm stuck" });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('starts a help chat with the screen and the last error the person saw', () => {
    const seen: (HelpSession | null)[] = [];
    rememberErrorText('Connection lost: Check your connection. The chat re-syncs automatically when it returns.');
    render(
      <HelpProvider api={API}>
        <HelpStuckButton />
        <SessionProbe onSession={session => seen.push(session)} />
      </HelpProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: "Help, I'm stuck" }));

    const latest = seen.at(-1);
    expect(latest?.screen).toBe('Chat');
    expect(latest?.lastError).toBe(
      'Connection lost: Check your connection. The chat re-syncs automatically when it returns.',
    );
    expect(latest?.phase).toBe('pending');
  });

  it('renders nothing outside a help provider', () => {
    const { container } = render(<HelpStuckButton />);

    expect(container.innerHTML).toBe('');
  });
});

// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PageHeader } from '@/atoms/PageHeader.js';
import { HelpProvider, useOptionalHelp, type HelpApi, type HelpSession } from '@/help/HelpProvider.js';
import { HelpNewChatBridge, HelpStuckButton } from '@/help/HelpStuckButton.js';
import { rememberErrorText } from '@/help/lastError.js';

const { runtime, shell } = vi.hoisted(() => ({
  runtime: { localThreadId: 'thread-1' },
  shell: { openDraft: vi.fn(), enabled: false },
}));

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ threads: () => ({ switchToNewThread: () => Promise.resolve() }) }),
  useAuiState: () => runtime.localThreadId,
}));

vi.mock('@/server/ShellModeContext.js', () => {
  const noop = () => undefined;
  return {
    useOptionalShellMode: () =>
      shell.enabled
        ? {
            isComposerEnabled: true,
            openDraft: shell.openDraft,
            setLibraryOpen: noop,
            setSessionsOpen: noop,
            setSettingsOpen: noop,
            setSchedulesOpen: noop,
            closeSpaces: noop,
          }
        : null,
  };
});

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
    rememberErrorText('Connection lost: Check your network, then try again.');
    render(
      <HelpProvider api={API}>
        <HelpStuckButton />
        <SessionProbe onSession={session => seen.push(session)} />
      </HelpProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: "Help, I'm stuck" }));

    const latest = seen.at(-1);
    expect(latest?.screen).toBe('Chat');
    expect(latest?.lastError).toBe('Connection lost: Check your network, then try again.');
    expect(latest?.phase).toBe('pending');
  });

  it('renders nothing outside a help provider', () => {
    const { container } = render(<HelpStuckButton />);

    expect(container.innerHTML).toBe('');
  });

  it('opens one fresh chat per press, even when the runtime remounts for it', () => {
    shell.enabled = true;
    shell.openDraft.mockClear();
    runtime.localThreadId = 'thread-1';
    const seen: (HelpSession | null)[] = [];
    // Stands in for the runtime key: opening a draft remounts everything under the chat provider.
    const runtimeTree = (runtimeKey: string) => (
      <div key={runtimeKey}>
        <HelpNewChatBridge />
      </div>
    );
    const { rerender } = render(
      <HelpProvider api={API}>
        <HelpStuckButton />
        <SessionProbe onSession={session => seen.push(session)} />
        {runtimeTree('chat:0')}
      </HelpProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: "Help, I'm stuck" }));
    expect(shell.openDraft).toHaveBeenCalledTimes(1);

    // The draft replaces the runtime, so the bridge mounts again with the new thread.
    runtime.localThreadId = 'thread-2';
    rerender(
      <HelpProvider api={API}>
        <HelpStuckButton />
        <SessionProbe onSession={session => seen.push(session)} />
        {runtimeTree('chat:1')}
      </HelpProvider>,
    );

    expect(shell.openDraft).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)?.idBeforeOpen).toBe('thread-1');
    expect(seen.at(-1)?.boundThreadId).toBe('thread-2');
    shell.enabled = false;
  });
});

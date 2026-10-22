// @vitest-environment jsdom
import { AgentConfigInstructionsProvider } from '@/atoms/draft/AgentConfigInstructionsContext.js';
import { ChatHistoryPanel } from '@/layouts/ChatHistoryPanel.js';
import { SidebarLayout } from '@/layouts/SidebarLayout.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider } from '@/server/ShellModeContext.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeHarness } from '../containers/RuntimeHarness.js';
import { createMockAgentUIServer, createMockCatalog } from '../server/mockServer.js';

// The real list needs live sessions; this stub exposes one pick control and forwards the pick.
vi.mock('@/containers/ThreadListContainer.js', () => ({
  ThreadListContainer: ({ onThreadOpen }: { onThreadOpen?: () => void }) => (
    <button type="button" onClick={() => onThreadOpen?.()}>
      Pick test chat
    </button>
  ),
}));

const PIN_STORAGE_KEY = 'aui-history-pinned';
const KEEP_OPEN = 'Keep chat history open';
const LET_CLOSE = 'Let chat history close';

function ChatHistoryPanelHarness({ onClose }: { onClose: () => void }) {
  const conversationRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={returnFocusRef} type="button">
        Hide recent chats
      </button>
      <ChatHistoryPanel conversationRef={conversationRef} returnFocusRef={returnFocusRef} onClose={onClose} />
      <div ref={conversationRef} data-testid="conversation">
        <div data-slot="aui_composer-root">
          <textarea aria-label="Message input" />
        </div>
      </div>
    </>
  );
}

function renderPanel(onClose = vi.fn()) {
  render(<ChatHistoryPanelHarness onClose={onClose} />);
  return onClose;
}

const panel = () => screen.getByRole('complementary', { name: 'Recent chats' });
const pick = () => screen.getByRole('button', { name: 'Pick test chat' });
const pressConversation = () => fireEvent.pointerDown(screen.getByTestId('conversation'));
const focusComposer = () => fireEvent.focusIn(screen.getByLabelText('Message input'));
/** The close animation ends on the width transition; jsdom never runs one, so the test fires it. */
const finishCloseTransition = () => {
  const transitionEnd = new Event('transitionend', { bubbles: true });
  Object.defineProperty(transitionEnd, 'propertyName', { value: 'width' });
  act(() => {
    panel().dispatchEvent(transitionEnd);
  });
};
const isClosing = () => panel().className.includes('w-0');
const pinButton = () => screen.getByRole('button', { name: /^(Keep chat history open|Let chat history close)$/ });

function mockReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

describe('ChatHistoryPanel auto-close', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('closes after a pick, once the close transition ends', () => {
    const onClose = renderPanel();

    fireEvent.click(pick());
    expect(isClosing()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    finishCloseTransition();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the person presses into the conversation area', () => {
    const onClose = renderPanel();

    pressConversation();
    finishCloseTransition();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the composer gets focus', () => {
    const onClose = renderPanel();

    focusComposer();
    finishCloseTransition();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close while the pointer is over the panel', () => {
    const onClose = renderPanel();

    fireEvent.pointerEnter(panel());
    pressConversation();
    focusComposer();

    expect(isClosing()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerLeave(panel());
    pressConversation();
    finishCloseTransition();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close while the panel has keyboard focus', () => {
    const onClose = renderPanel();

    fireEvent.focusIn(pick());
    pressConversation();

    expect(isClosing()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.focusOut(pick(), { relatedTarget: screen.getByLabelText('Message input') });
    pressConversation();
    finishCloseTransition();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still closes when a mouse click left focus on a panel control', () => {
    const onClose = renderPanel();

    // Browsers focus the clicked control between pointerdown and pointerup.
    fireEvent.pointerDown(pinButton());
    fireEvent.focusIn(pinButton());
    fireEvent.pointerUp(pinButton());
    pressConversation();
    finishCloseTransition();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close while the list is scrolling, and closes once scrolling settles', async () => {
    const onClose = renderPanel();

    fireEvent.scroll(panel());
    pressConversation();
    expect(isClosing()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    await new Promise(resolve => setTimeout(resolve, 200));
    pressConversation();
    finishCloseTransition();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes at once without a transition when reduced motion is preferred', () => {
    mockReducedMotion(true);
    const onClose = renderPanel();

    fireEvent.click(pick());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the panel and returns focus to the button that opened it', () => {
    const onClose = renderPanel();

    act(() => pick().focus());
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByRole('button', { name: 'Hide recent chats' })).toHaveFocus();
    finishCloseTransition();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel open through picks and conversation presses while pinned', () => {
    const onClose = renderPanel();

    fireEvent.click(pinButton());
    expect(screen.getByRole('button', { name: LET_CLOSE })).toBeInTheDocument();
    expect(localStorage.getItem(PIN_STORAGE_KEY)).toBe('true');

    fireEvent.click(pick());
    pressConversation();
    focusComposer();

    expect(isClosing()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape still closes a pinned panel', () => {
    const onClose = renderPanel();

    fireEvent.click(pinButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    finishCloseTransition();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('remembers the pin across a remount and can be unpinned', () => {
    const { unmount } = render(<ChatHistoryPanelHarness onClose={vi.fn()} />);
    fireEvent.click(pinButton());
    unmount();

    renderPanel();
    expect(screen.getByRole('button', { name: LET_CLOSE })).toBeInTheDocument();

    fireEvent.click(pinButton());
    expect(screen.getByRole('button', { name: KEEP_OPEN })).toBeInTheDocument();
    expect(localStorage.getItem(PIN_STORAGE_KEY)).toBe('false');
  });

  it('starts unpinned when storage holds no value', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: KEEP_OPEN })).toBeInTheDocument();
  });
});

function renderSidebar() {
  return (
    <SlotsProvider>
      <ServerProvider server={createMockAgentUIServer({ catalog: createMockCatalog() })}>
        <ShellModeProvider>
          <AgentConfigInstructionsProvider>
            <RuntimeHarness messages={[]}>
              <div className="h-96">
                <SidebarLayout />
              </div>
            </RuntimeHarness>
          </AgentConfigInstructionsProvider>
        </ShellModeProvider>
      </ServerProvider>
    </SlotsProvider>
  );
}

describe('SidebarLayout phone overlay', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('closes the navigation overlay on a pick and offers no pin there', () => {
    render(renderSidebar());

    fireEvent.click(screen.getByRole('button', { name: 'Navigation' }));
    const dialog = screen.getByRole('dialog', { name: 'Navigation' });

    expect(within(dialog).queryByRole('button', { name: KEEP_OPEN })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pick test chat' }));

    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveVoiceBridge } from '@/containers/LiveVoiceBridge.js';
import {
  endLiveLine,
  getVoiceMode,
  hasLiveLine,
  liveLineEnded,
  liveLineEvents,
  setLiveLine,
  setLiveNotice,
  setVoiceMode,
  useLiveNotice,
} from '@/utils/voiceMode.js';
import { RuntimeHarness } from './RuntimeHarness.js';

const reload = vi.fn();

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryReload: () => reload,
}));

function Notice() {
  return <p data-testid="notice">{useLiveNotice() ?? ''}</p>;
}

const chat = (remoteId: string) => (
  <RuntimeHarness messages={[]} threadId={`thread-for-${remoteId}`} remoteId={remoteId}>
    <LiveVoiceBridge />
    <Notice />
  </RuntimeHarness>
);

function openLine(sessionId: string) {
  const stop = vi.fn();
  setLiveLine({ stop, sessionId });
  setVoiceMode('listening');
  return stop;
}

describe('LiveVoiceBridge', () => {
  beforeEach(() => {
    reload.mockReset();
  });
  afterEach(() => {
    endLiveLine();
    setLiveNotice(null);
  });

  it('reloads the chat when the line saved a spoken turn', () => {
    render(chat('chat-1'));
    act(() => liveLineEvents.onTurnSaved());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['closed', 'the connection closed'],
    ['mic_lost', 'the microphone stopped'],
  ] as const)('says why in plain words when the line ends because it %s', (reason, words) => {
    render(chat('chat-1'));
    openLine('chat-1');
    act(() => liveLineEnded(reason));
    expect(screen.getByTestId('notice').textContent).toContain(words);
    expect(getVoiceMode()).toBe('off');
  });

  it('keeps the line while it is the same chat, even when the chat reloads', () => {
    const view = render(chat('chat-1'));
    const stop = openLine('chat-1');
    act(() => liveLineEvents.onTurnSaved());
    view.rerender(chat('chat-1'));
    expect(stop).not.toHaveBeenCalled();
    expect(hasLiveLine()).toBe(true);
  });

  it('ends the line when another chat is shown', async () => {
    const view = render(chat('chat-1'));
    const stop = openLine('chat-1');
    view.rerender(chat('chat-2'));
    await waitFor(() => {
      expect(stop).toHaveBeenCalledTimes(1);
    });
    expect(getVoiceMode()).toBe('off');
  });

  it('ends the line when the tab is hidden, and leaves it alone while the tab is shown', () => {
    render(chat('chat-1'));
    const stop = openLine('chat-1');
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(stop).not.toHaveBeenCalled();
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(stop).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it('ends the line and clears the notice when the chat goes away', () => {
    const view = render(chat('chat-1'));
    const stop = openLine('chat-1');
    act(() => setLiveNotice('Something was said.'));
    view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getVoiceMode()).toBe('off');
  });
});

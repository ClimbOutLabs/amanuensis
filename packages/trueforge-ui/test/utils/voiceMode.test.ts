import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginLiveStart,
  chatChanged,
  endLiveLine,
  finishLiveStart,
  getLiveLineSession,
  getVoiceMode,
  hasLiveLine,
  liveLineEnded,
  mountLiveLineBridge,
  nameLiveStartSession,
  setLiveLine,
  setLiveNotice,
  setVoiceMode,
} from '@/utils/voiceMode.js';

afterEach(() => {
  endLiveLine();
  setLiveNotice(null);
});

describe('the live voice line', () => {
  it('belongs to the chat it started in: another chat ends it, the same chat does not', () => {
    const stop = vi.fn();
    setLiveLine({ stop, sessionId: 'chat-1' });
    setVoiceMode('listening');
    chatChanged('chat-1');
    expect(stop).not.toHaveBeenCalled();
    chatChanged('chat-2');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(hasLiveLine()).toBe(false);
    expect(getVoiceMode()).toBe('off');
  });

  it('aborts a start for the old chat when another chat is shown, but not one for a new chat getting its id', () => {
    const old = beginLiveStart('chat-1');
    chatChanged('chat-2');
    expect(old.signal.aborted).toBe(true);

    const fresh = beginLiveStart(null);
    chatChanged('chat-3');
    expect(fresh.signal.aborted).toBe(false);
    nameLiveStartSession({ controller: fresh, sessionId: 'chat-3' });
    chatChanged('chat-3');
    expect(fresh.signal.aborted).toBe(false);
    chatChanged('chat-4');
    expect(fresh.signal.aborted).toBe(true);
    finishLiveStart(fresh);
  });

  it("a new chat's start ends when another chat was shown while the new one was being created", () => {
    chatChanged(null);
    const fresh = beginLiveStart(null);
    chatChanged('chat-9');
    nameLiveStartSession({ controller: fresh, sessionId: 'chat-new' });
    expect(fresh.signal.aborted).toBe(true);
    expect(getVoiceMode()).toBe('off');
  });

  it.each(['before', 'after'])("a new chat's start survives its own id arriving %s it is named", order => {
    chatChanged(null);
    const fresh = beginLiveStart(null);
    if (order === 'before') chatChanged('chat-new');
    nameLiveStartSession({ controller: fresh, sessionId: 'chat-new' });
    if (order === 'after') chatChanged('chat-new');
    expect(fresh.signal.aborted).toBe(false);
    finishLiveStart(fresh);
  });

  it('a new start replaces one still opening', () => {
    const first = beginLiveStart('chat-1');
    const second = beginLiveStart('chat-1');
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    finishLiveStart(second);
  });

  it('reports a line that closed by itself to the chat bridge, and forgets the line', () => {
    const onEnded = vi.fn();
    const unmount = mountLiveLineBridge({ onTurnSaved: vi.fn(), onEnded });
    setLiveLine({ stop: vi.fn(), sessionId: 'chat-1' });
    liveLineEnded('closed');
    expect(onEnded).toHaveBeenCalledWith('closed');
    expect(getLiveLineSession()).toBeNull();
    unmount();
  });

  it('ends the line and clears the notice when the chat bridge goes away', () => {
    const stop = vi.fn();
    const unmount = mountLiveLineBridge({ onTurnSaved: vi.fn(), onEnded: vi.fn() });
    setLiveLine({ stop, sessionId: 'chat-1' });
    setLiveNotice('Something to say.');
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getVoiceMode()).toBe('off');
  });
});

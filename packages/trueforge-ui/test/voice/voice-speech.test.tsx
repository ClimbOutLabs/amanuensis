// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceSettingsProvider } from '@/voice/VoiceSettingsContext.js';
import { useVoiceSpeech, VoiceSpeechProvider } from '@/voice/VoiceSpeechContext.js';

type UtteranceListener = () => void;

class MockUtterance {
  text: string;
  voice: null = null;
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<UtteranceListener>>();

  constructor(text = '') {
    this.text = text;
  }

  addEventListener(type: string, listener: UtteranceListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: UtteranceListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: 'end' | 'error'): void {
    if (type === 'end') this.onend?.();
    else this.onerror?.();
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

function installSpeechSynthesis() {
  const utterances: MockUtterance[] = [];
  const synthesis = {
    speak: vi.fn((utterance: MockUtterance) => {
      utterances.push(utterance);
    }),
    cancel: vi.fn(() => {
      utterances.length = 0;
    }),
    getVoices: vi.fn((): SpeechSynthesisVoice[] => []),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, 'speechSynthesis', {
    value: synthesis,
    configurable: true,
    writable: true,
  });
  vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance);
  return { synthesis, utterances };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <VoiceSettingsProvider>
      <VoiceSpeechProvider>{children}</VoiceSpeechProvider>
    </VoiceSettingsProvider>
  );
}

describe('VoiceSpeechProvider', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports unsupported when speechSynthesis is missing', () => {
    // Ensure the API is absent for this test.
    Object.defineProperty(window, 'speechSynthesis', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const { result } = renderHook(() => useVoiceSpeech(), { wrapper });
    expect(result.current.supported).toBe(false);
    act(() => {
      result.current.speak({ id: 'm1', text: 'hello' });
    });
    expect(result.current.speakingId).toBeNull();
  });

  it('speaks an utterance and tracks the speaking message id', () => {
    const { synthesis, utterances } = installSpeechSynthesis();
    const { result } = renderHook(() => useVoiceSpeech(), { wrapper });

    act(() => {
      result.current.speak({ id: 'm1', text: 'hello there' });
    });

    expect(result.current.supported).toBe(true);
    expect(synthesis.speak).toHaveBeenCalledTimes(1);
    expect(utterances).toHaveLength(1);
    expect(utterances[0]?.text).toBe('hello there');
    expect(result.current.speakingId).toBe('m1');
  });

  it('speaking a second message cancels the first one', () => {
    const { synthesis, utterances } = installSpeechSynthesis();
    const { result } = renderHook(() => useVoiceSpeech(), { wrapper });

    act(() => {
      result.current.speak({ id: 'm1', text: 'first' });
    });
    act(() => {
      result.current.speak({ id: 'm2', text: 'second' });
    });

    expect(synthesis.cancel).toHaveBeenCalled();
    expect(utterances[utterances.length - 1]?.text).toBe('second');
    expect(result.current.speakingId).toBe('m2');
  });

  it('clears the speaking id when the utterance ends', async () => {
    const { utterances } = installSpeechSynthesis();
    const { result } = renderHook(() => useVoiceSpeech(), { wrapper });

    act(() => {
      result.current.speak({ id: 'm1', text: 'hello' });
    });
    expect(result.current.speakingId).toBe('m1');

    await act(async () => {
      utterances[0]?.fire('end');
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(result.current.speakingId).toBeNull();
  });

  it('stop cancels playback and clears the speaking id', () => {
    const { synthesis } = installSpeechSynthesis();
    const { result } = renderHook(() => useVoiceSpeech(), { wrapper });

    act(() => {
      result.current.speak({ id: 'm1', text: 'hello' });
    });
    act(() => {
      result.current.stop();
    });

    expect(synthesis.cancel).toHaveBeenCalled();
    expect(result.current.speakingId).toBeNull();
  });
});

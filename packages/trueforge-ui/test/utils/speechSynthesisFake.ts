import { renderHook } from '@testing-library/react';
import { vi, type Mock } from 'vitest';

import { useSpokenReply } from '@/components/SpokenReplyContext.js';

/** The utterance fields the read-aloud code sets and reads. */
export class FakeUtterance {
  text: string;
  voice: SpeechSynthesisVoice | null = null;
  lang = '';
  private listeners = new Map<string, Array<() => void>>();

  constructor(text: string) {
    this.text = text;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Plays the browser telling the page that this utterance ended. */
  finish(): void {
    for (const listener of this.listeners.get('end') ?? []) listener();
  }
}

export type FakeSpeechSynthesis = {
  speak: Mock<(utterance: FakeUtterance) => void>;
  cancel: Mock<() => void>;
  getVoices: Mock<() => SpeechSynthesisVoice[]>;
  addEventListener: Mock<() => void>;
  removeEventListener: Mock<() => void>;
};

export function makeVoice(
  overrides: Partial<SpeechSynthesisVoice> & Pick<SpeechSynthesisVoice, 'voiceURI'>,
): SpeechSynthesisVoice {
  return { default: false, lang: 'en-US', localService: true, name: overrides.voiceURI, ...overrides };
}

/** Installs a browser-like `window.speechSynthesis` and the `SpeechSynthesisUtterance` constructor. */
/** An on-device browser default voice, so speech has a voice to use unless a test says otherwise. */
const BROWSER_DEFAULT_VOICE = makeVoice({ voiceURI: 'browser-default', default: true });

export function installSpeechSynthesis({
  voices = [BROWSER_DEFAULT_VOICE],
}: { voices?: SpeechSynthesisVoice[] } = {}): FakeSpeechSynthesis {
  const synthesis: FakeSpeechSynthesis = {
    speak: vi.fn<(utterance: FakeUtterance) => void>(),
    cancel: vi.fn<() => void>(),
    getVoices: vi.fn<() => SpeechSynthesisVoice[]>(() => voices),
    addEventListener: vi.fn<() => void>(),
    removeEventListener: vi.fn<() => void>(),
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  return synthesis;
}

/** Makes the browser look like it has no speech synthesis at all. */
export function removeSpeechSynthesis(): void {
  Reflect.deleteProperty(window, 'speechSynthesis');
  vi.unstubAllGlobals();
}

/** The text of every utterance handed to `speak`, in order. */
export function spokenTexts(synthesis: FakeSpeechSynthesis): string[] {
  return synthesis.speak.mock.calls.map(([utterance]) => utterance.text);
}

/** Stops whatever the shared browser-only spoken reply player is reading, so tests do not leak into each other. */
export function stopSpokenReply(): void {
  renderHook(() => useSpokenReply()).result.current.stop();
}

import { vi, type Mock } from 'vitest';

/** The utterance fields the read-aloud code sets and reads. */
export class FakeUtterance {
  text: string;
  voice: SpeechSynthesisVoice | null = null;
  lang = '';
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(text: string) {
    this.text = text;
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
export function installSpeechSynthesis({ voices = [] }: { voices?: SpeechSynthesisVoice[] } = {}): FakeSpeechSynthesis {
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

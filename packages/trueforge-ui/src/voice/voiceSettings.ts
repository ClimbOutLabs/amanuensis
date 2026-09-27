'use client';

/**
 * Voice preferences. Client-local only (localStorage): voices and speech
 * engines live in the browser, so there is nothing for the server to store.
 */

export interface VoiceSettings {
  /** Push-to-talk dictation in the composer. */
  voiceInputEnabled: boolean;
  /** Read-aloud (TTS) for assistant messages. */
  ttsEnabled: boolean;
  /** Automatically speak new assistant messages as they complete. */
  autoRead: boolean;
  /** `SpeechSynthesisVoice.voiceURI`, or null for the system default voice. */
  voiceURI: string | null;
  /** Speech rate multiplier, 0.5 to 2. */
  rate: number;
  /** Speech pitch multiplier, 0 to 2. */
  pitch: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voiceInputEnabled: true,
  ttsEnabled: true,
  autoRead: false,
  voiceURI: null,
  rate: 1,
  pitch: 1,
};

const VOICE_SETTINGS_KEY = 'aman:voice-settings';

/** Storage key for the client-local voice preferences. Exported for tests. */
export { VOICE_SETTINGS_KEY };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function sanitize(raw: unknown): VoiceSettings {
  if (!isRecord(raw)) return { ...DEFAULT_VOICE_SETTINGS };
  return {
    voiceInputEnabled:
      typeof raw.voiceInputEnabled === 'boolean' ? raw.voiceInputEnabled : DEFAULT_VOICE_SETTINGS.voiceInputEnabled,
    ttsEnabled: typeof raw.ttsEnabled === 'boolean' ? raw.ttsEnabled : DEFAULT_VOICE_SETTINGS.ttsEnabled,
    autoRead: typeof raw.autoRead === 'boolean' ? raw.autoRead : DEFAULT_VOICE_SETTINGS.autoRead,
    voiceURI: typeof raw.voiceURI === 'string' && raw.voiceURI.length > 0 ? raw.voiceURI : null,
    rate: clampNumber(raw.rate, 0.5, 2, DEFAULT_VOICE_SETTINGS.rate),
    pitch: clampNumber(raw.pitch, 0, 2, DEFAULT_VOICE_SETTINGS.pitch),
  };
}

export function readVoiceSettings(): VoiceSettings {
  try {
    if (typeof window === 'undefined') return { ...DEFAULT_VOICE_SETTINGS };
    const raw = window.localStorage.getItem(VOICE_SETTINGS_KEY);
    if (raw == null) return { ...DEFAULT_VOICE_SETTINGS };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

/** True when the settings are now in storage; false when the store is blocked. */
export function writeVoiceSettings(settings: VoiceSettings): boolean {
  try {
    if (typeof window === 'undefined') return false;
    window.localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

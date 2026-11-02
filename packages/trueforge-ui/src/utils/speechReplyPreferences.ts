import { createBooleanDisplayPreference } from './booleanDisplayPreference.js';

/**
 * Whether replies to a voice-sent message are read aloud. Kept in this browser like the other
 * display switches, and on unless switched off.
 */
export const SPEAK_VOICE_REPLIES_STORAGE_KEY = 'aman.speak_voice_replies';

const speakVoiceReplies = createBooleanDisplayPreference({
  storageKey: SPEAK_VOICE_REPLIES_STORAGE_KEY,
  defaultValue: true,
});

export function useSpeakVoiceReplies(): { enabled: boolean; setEnabled: (enabled: boolean) => void } {
  const enabled = speakVoiceReplies.useValue();
  return { enabled, setEnabled: speakVoiceReplies.set };
}

/** The browser voice URI the person picked, or null for the browser's default voice. */
export const SPEECH_VOICE_STORAGE_KEY = 'aman.speech_voice';

export function readSpeechVoiceURI(): string | null {
  try {
    return window.localStorage.getItem(SPEECH_VOICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeSpeechVoiceURI(voiceURI: string | null): void {
  try {
    if (voiceURI === null) {
      window.localStorage.removeItem(SPEECH_VOICE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(SPEECH_VOICE_STORAGE_KEY, voiceURI);
    }
  } catch {
    // Not kept; the choice still applies until the page reloads.
  }
}

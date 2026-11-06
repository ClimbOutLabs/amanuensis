import { createBooleanDisplayPreference } from './booleanDisplayPreference.js';
import { createDisplayPreference } from './displayPreference.js';

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

/**
 * Voices of the reading voice on the person's own computer. The ids are the voices baked into the
 * `aman-tts` image (`VOICE_IDS` in its pins); the first is its default.
 */
export const SERVER_VOICES = [
  { id: 'af_heart', label: 'Heart, a woman (default)' },
  { id: 'af_bella', label: 'Bella, a woman' },
  { id: 'af_nicole', label: 'Nicole, a woman' },
  { id: 'af_sarah', label: 'Sarah, a woman' },
  { id: 'am_michael', label: 'Michael, a man' },
  { id: 'am_fenrir', label: 'Fenrir, a man' },
] as const;

export type ServerVoiceId = (typeof SERVER_VOICES)[number]['id'];

export const SERVER_VOICE_STORAGE_KEY = 'aman.server_voice';

export function isServerVoiceId(value: string): value is ServerVoiceId {
  return SERVER_VOICES.some(voice => voice.id === value);
}

const serverVoice = createDisplayPreference<ServerVoiceId>({
  storageKey: SERVER_VOICE_STORAGE_KEY,
  defaultValue: 'af_heart',
  parse: stored => (isServerVoiceId(stored) ? stored : undefined),
  serialize: id => id,
});

/** The computer voice the person picked; read when each reply is read aloud. */
export const readServerVoice = serverVoice.read;

export function useServerVoice(): { voice: ServerVoiceId; setVoice: (voice: ServerVoiceId) => void } {
  return { voice: serverVoice.useValue(), setVoice: serverVoice.set };
}

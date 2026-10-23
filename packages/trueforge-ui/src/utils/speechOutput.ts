import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Reads text aloud with the browser's own speech synthesis, using only voices that run on this device.
 * Some browsers offer network voices that send the text to a server, so those are never used. Only one
 * answer speaks at a time; the speaking key says which one (a message id) so its button can show a stop.
 */

/** Checked on every call: a browser without speech synthesis hides the controls and never throws. */
export function isSpeechOutputSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
}

let speakingKey: string | null = null;
let activeUtterance: SpeechSynthesisUtterance | null = null;
const listeners = new Set<() => void>();

function setSpeakingKey(next: string | null): void {
  speakingKey = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The message id being read aloud right now, or null. */
export function useSpeakingKey(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => speakingKey,
    () => null,
  );
}

/** Reads `text` aloud as `key`, replacing anything already being read. An unknown voice falls back to the browser default. */
export function speakText({ key, text, voiceURI }: { key: string; text: string; voiceURI?: string | null }): void {
  if (!isSpeechOutputSupported()) return;
  const spoken = text.trim();
  if (spoken === '') return;
  const voices = onDeviceVoices();
  const voice =
    (voiceURI == null ? undefined : voices.find(item => item.voiceURI === voiceURI)) ?? defaultVoice(voices);
  // No on-device voice yet (browsers load them late): stay silent rather than fall back to a network voice.
  if (voice === undefined) return;
  const synthesis = window.speechSynthesis;
  synthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(spoken);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  // A cancelled utterance can still report its end after the next one starts; only the active one may clear the state.
  const finish = () => {
    if (activeUtterance !== utterance) return;
    activeUtterance = null;
    setSpeakingKey(null);
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  activeUtterance = utterance;
  setSpeakingKey(key);
  synthesis.speak(utterance);
}

/** Stops whatever is being read aloud. Safe to call when nothing is. */
export function stopSpeaking(): void {
  if (!isSpeechOutputSupported()) return;
  window.speechSynthesis.cancel();
  activeUtterance = null;
  if (speakingKey !== null) setSpeakingKey(null);
}

/** The voices that run on this device. Network voices send the text to a server, so they are left out. */
function onDeviceVoices(): SpeechSynthesisVoice[] {
  return isSpeechOutputSupported() ? window.speechSynthesis.getVoices().filter(voice => voice.localService) : [];
}

function defaultVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  return voices.find(voice => voice.default) ?? voices[0];
}

/** The on-device voices. Browsers load them late, so the list refreshes when they arrive. */
export function useSpeechVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(onDeviceVoices);
  useEffect(() => {
    if (!isSpeechOutputSupported()) return;
    const synthesis = window.speechSynthesis;
    const refresh = () => setVoices(onDeviceVoices());
    synthesis.addEventListener('voiceschanged', refresh);
    refresh();
    return () => synthesis.removeEventListener('voiceschanged', refresh);
  }, []);
  return voices;
}

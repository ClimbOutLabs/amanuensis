import { useEffect, useState } from 'react';

/**
 * Helpers for the browser's own speech synthesis, which only ever uses voices that run on this device.
 * Some browsers offer network voices that send the text to a server, so those are never used.
 */

/** Checked on every call: a browser without speech synthesis hides the controls and never throws. */
export function isSpeechOutputSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
}

/** The voices that run on this device. Network voices send the text to a server, so they are left out. */
function onDeviceVoices(): SpeechSynthesisVoice[] {
  return isSpeechOutputSupported() ? window.speechSynthesis.getVoices().filter(voice => voice.localService) : [];
}

/** The voice the person chose if it still runs on this device, else the browser default; undefined when none can be used. */
export function pickOnDeviceVoice(voiceURI: string | null): SpeechSynthesisVoice | undefined {
  const voices = onDeviceVoices();
  return (voiceURI === null ? undefined : voices.find(item => item.voiceURI === voiceURI)) ?? defaultVoice(voices);
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

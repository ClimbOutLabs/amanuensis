'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { isSpeechSynthesisSupported } from './speechSupport.js';
import { useVoiceSettings } from './VoiceSettingsContext.js';

export interface SpeakRequest {
  /** Message id; used for the speaking highlight. */
  id: string;
  text: string;
  onEnd?: () => void;
}

export interface VoiceSpeechContextValue {
  supported: boolean;
  voices: SpeechSynthesisVoice[];
  /** Id of the utterance currently playing, or null. */
  speakingId: string | null;
  /** True when `id` is being read, manually or via auto-read. */
  isSpeaking: (id: string) => boolean;
  speak: (request: SpeakRequest) => void;
  stop: () => void;
}

const defaultValue: VoiceSpeechContextValue = {
  supported: false,
  voices: [],
  speakingId: null,
  isSpeaking: () => false,
  speak: () => {},
  stop: () => {},
};

const VoiceSpeechContext = createContext<VoiceSpeechContextValue>(defaultValue);

/**
 * Owns the single shared `speechSynthesis` queue so per-message read-aloud
 * buttons, auto-read, and hands-free never talk over each other.
 */
export function VoiceSpeechProvider({ children }: { children: ReactNode }) {
  const { settings } = useVoiceSettings();
  const [supported] = useState(isSpeechSynthesisSupported);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const onEndRef = useRef<(() => void) | undefined>(undefined);
  // Generation counter: a superseded utterance's late end/error events must
  // not clear the callback or highlight of the utterance that replaced it.
  const speechSeqRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (!supported) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, [supported]);

  // Chrome throttles long utterances into a pause; a periodic resume keeps
  // long messages playing. Harmless when not paused.
  useEffect(() => {
    if (!supported || speakingId === null) return;
    const timer = window.setInterval(() => {
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [supported, speakingId]);

  // Disabling TTS mid-speech stops playback immediately.
  useEffect(() => {
    if (!supported || settings.ttsEnabled) return;
    speechSeqRef.current += 1;
    onEndRef.current = undefined;
    window.speechSynthesis.cancel();
    setSpeakingId(null);
  }, [supported, settings.ttsEnabled]);

  const stop = useCallback(() => {
    if (!supported) return;
    speechSeqRef.current += 1;
    onEndRef.current = undefined;
    window.speechSynthesis.cancel();
    setSpeakingId(null);
  }, [supported]);

  const speak = useCallback(
    (request: SpeakRequest) => {
      if (!supported) return;
      const current = settingsRef.current;
      if (!current.ttsEnabled) return;
      const text = request.text.trim();
      if (text.length === 0) return;
      const synth = window.speechSynthesis;
      // Cancel the previous utterance before registering the new one, so a
      // late event from the old utterance cannot touch the new one's state.
      speechSeqRef.current += 1;
      onEndRef.current = undefined;
      synth.cancel();
      const seq = speechSeqRef.current;
      const utterance = new SpeechSynthesisUtterance(text);
      if (current.voiceURI !== null) {
        const voice = synth.getVoices().find(candidate => candidate.voiceURI === current.voiceURI);
        if (voice !== undefined) utterance.voice = voice;
      }
      utterance.rate = current.rate;
      utterance.pitch = current.pitch;
      // Deferred to a macrotask: React commits setSpeakingId(null) first, so
      // the callback (e.g. the hands-free loop) observes the fresh state.
      const finish = (invokeCallback: boolean) => {
        if (speechSeqRef.current !== seq) return;
        setSpeakingId(null);
        const callback = onEndRef.current;
        onEndRef.current = undefined;
        if (invokeCallback && callback !== undefined) window.setTimeout(callback, 0);
      };
      onEndRef.current = request.onEnd;
      utterance.onend = () => finish(true);
      utterance.onerror = () => finish(true);
      setSpeakingId(request.id);
      synth.speak(utterance);
    },
    [supported],
  );

  const isSpeaking = useCallback((id: string) => speakingId === id, [speakingId]);

  const value = useMemo<VoiceSpeechContextValue>(
    () => ({ supported, voices, speakingId, isSpeaking, speak, stop }),
    [supported, voices, speakingId, isSpeaking, speak, stop],
  );

  return <VoiceSpeechContext.Provider value={value}>{children}</VoiceSpeechContext.Provider>;
}

export function useVoiceSpeech(): VoiceSpeechContextValue {
  return useContext(VoiceSpeechContext);
}

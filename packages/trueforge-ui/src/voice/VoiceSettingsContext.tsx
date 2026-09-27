'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { isSpeechRecognitionSupported, isSpeechSynthesisSupported } from './speechSupport.js';
import { DEFAULT_VOICE_SETTINGS, readVoiceSettings, writeVoiceSettings, type VoiceSettings } from './voiceSettings.js';

export interface VoiceSettingsContextValue {
  settings: VoiceSettings;
  updateSettings: (patch: Partial<VoiceSettings>) => void;
  speechRecognitionSupported: boolean;
  speechSynthesisSupported: boolean;
}

const defaultValue: VoiceSettingsContextValue = {
  settings: DEFAULT_VOICE_SETTINGS,
  updateSettings: () => {},
  speechRecognitionSupported: false,
  speechSynthesisSupported: false,
};

const VoiceSettingsContext = createContext<VoiceSettingsContextValue>(defaultValue);

/**
 * Client-local voice preferences (localStorage). Mount above the chat shell;
 * the default context degrades to "everything on, nothing persisted".
 */
export function VoiceSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<VoiceSettings>(readVoiceSettings);
  const [speechRecognitionSupported] = useState(isSpeechRecognitionSupported);
  const [speechSynthesisSupported] = useState(isSpeechSynthesisSupported);

  const updateSettings = useCallback((patch: Partial<VoiceSettings>) => {
    setSettings(previous => {
      const next = { ...previous, ...patch };
      writeVoiceSettings(next);
      return next;
    });
  }, []);

  const value = useMemo<VoiceSettingsContextValue>(
    () => ({ settings, updateSettings, speechRecognitionSupported, speechSynthesisSupported }),
    [settings, updateSettings, speechRecognitionSupported, speechSynthesisSupported],
  );

  return <VoiceSettingsContext.Provider value={value}>{children}</VoiceSettingsContext.Provider>;
}

export function useVoiceSettings(): VoiceSettingsContextValue {
  return useContext(VoiceSettingsContext);
}

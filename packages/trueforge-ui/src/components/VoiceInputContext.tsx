'use client';

import { createContext, useContext, type FC, type ReactNode } from 'react';

/** Transcript returned by `POST /api/v1/voice/transcribe` (snake_case wire shape). */
export type VoiceTranscription = {
  text: string;
  language: string;
  duration_ms: number;
  model: string;
};

/** STT availability from `GET /api/v1/voice/status`. */
export type VoiceStatus = {
  stt_available: boolean;
  model: string;
};

export type VoiceInputApi = {
  /** Probes STT availability; the composer hides voice input when unavailable. */
  getStatus: () => Promise<VoiceStatus>;
  /** Posts 16 kHz mono WAV audio and resolves with the transcript. */
  transcribe: (input: { audio: Blob; language?: string }) => Promise<VoiceTranscription>;
};

const VoiceInputContext = createContext<VoiceInputApi | null>(null);

export const VoiceInputProvider: FC<{ api: VoiceInputApi; children: ReactNode }> = ({ api, children }) => (
  <VoiceInputContext.Provider value={api}>{children}</VoiceInputContext.Provider>
);

/** Null when no host has wired a `VoiceInputProvider` — callers hide the mic control in that case. */
export function useOptionalVoiceInput(): VoiceInputApi | null {
  return useContext(VoiceInputContext);
}

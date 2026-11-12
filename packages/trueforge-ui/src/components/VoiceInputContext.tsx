'use client';

import { createContext, useContext, type FC, type ReactNode } from 'react';

/** Transcript returned by `POST /api/v1/voice/transcribe` (snake_case wire shape). */
export type VoiceTranscription = {
  text: string;
  language: string;
  duration_ms: number;
  model: string;
};

/** Voice availability reported through the `voice` capability flag. `null` while unread. */
export type VoiceAvailability = boolean | null;

/** Where and how to open the live voice line for one chat (`POST /api/v1/voice/connect`). */
export type VoiceConnection = {
  /** Full `ws:` or `wss:` address of the voice line. */
  url: string;
  /** Sub-protocols to ask for: the voice protocol, then the one-time ticket. */
  protocols: string[];
};

export type VoiceInputApi = {
  /**
   * Subscribes to voice availability, driven by the `voice` capability flag in
   * `/api/v1/capabilities`. The listener fires immediately with the cached value
   * (`null` before the first read) and again on every change. The host latches
   * availability: once observed true it never flips back within the session.
   */
  subscribeAvailability: (listener: (available: VoiceAvailability) => void) => () => void;
  /**
   * Posts 16 kHz mono WAV audio and resolves with the transcript. The optional
   * signal aborts the request (cancel, unmount, route change); the host layers
   * the client-side transcription timeout on top of it.
   */
  transcribe: (input: { audio: Blob; signal?: AbortSignal }) => Promise<VoiceTranscription>;
  /** Asks the server to let this chat open a live voice conversation, and resolves with how to reach it. */
  connect: (input: { sessionId: string; signal?: AbortSignal }) => Promise<VoiceConnection>;
};

const VoiceInputContext = createContext<VoiceInputApi | null>(null);

export const VoiceInputProvider: FC<{ api: VoiceInputApi; children: ReactNode }> = ({ api, children }) => (
  <VoiceInputContext.Provider value={api}>{children}</VoiceInputContext.Provider>
);

/** Null when no host wired a `VoiceInputProvider` — callers hide the mic control in that case. */
export function useOptionalVoiceInput(): VoiceInputApi | null {
  return useContext(VoiceInputContext);
}

'use client';

/** The browser's SpeechRecognition constructor, or null where unsupported. */
export function getSpeechRecognitionConstructor(): NonNullable<Window['SpeechRecognition']> | null {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionConstructor() !== null;
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.speechSynthesis !== 'undefined';
}

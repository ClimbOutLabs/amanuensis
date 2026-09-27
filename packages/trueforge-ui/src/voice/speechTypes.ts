'use client';

/**
 * Web Speech API event types for v1 voice input. The result/utterance shapes
 * come from TS's DOM lib, and the `Window.SpeechRecognition` declaration from
 * `@assistant-ui/core`; only the event types are missing, so only those live
 * here.
 */

export interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

export interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

/** Instance type of the browser's SpeechRecognition constructor. */
export type BrowserSpeechRecognition = InstanceType<NonNullable<Window['SpeechRecognition']>>;

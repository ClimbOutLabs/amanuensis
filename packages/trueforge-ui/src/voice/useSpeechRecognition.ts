'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getSpeechRecognitionConstructor } from './speechSupport.js';
import type { BrowserSpeechRecognition, SpeechRecognitionErrorEvent, SpeechRecognitionEvent } from './speechTypes.js';

export type SpeechRecognitionStatus = 'idle' | 'listening' | 'processing';

export interface UseSpeechRecognitionOptions {
  onFinalTranscript?: (transcript: string) => void;
  onEnd?: () => void;
  /** Raw engine error code, e.g. `not-allowed`, `no-speech`, `network`. */
  onError?: (error: string) => void;
}

/** The adapter's instance type omits handler properties, so narrow from the DOM event. */
function isSpeechRecognitionEvent(event: Event): event is SpeechRecognitionEvent {
  return 'results' in event;
}

function isSpeechRecognitionErrorEvent(event: Event): event is SpeechRecognitionErrorEvent {
  return 'error' in event;
}

/**
 * One-shot Web Speech API recognition. A fresh instance is created per
 * `start()` because reusing an instance across start/stop cycles is flaky.
 * Instances are singletons per hook: callers that must never overlap (the
 * composer mic button and the hands-free loop) each own one and coordinate
 * through the hands-free context.
 */
export function useSpeechRecognition(options: UseSpeechRecognitionOptions = {}) {
  const [supported] = useState(() => getSpeechRecognitionConstructor() !== null);
  const [status, setStatus] = useState<SpeechRecognitionStatus>('idle');
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const abort = useCallback(() => {
    try {
      recognitionRef.current?.abort();
    } catch {
      // Already ended; nothing to tear down.
    }
    recognitionRef.current = null;
    setStatus('idle');
  }, []);

  const start = useCallback(() => {
    const Constructor = getSpeechRecognitionConstructor();
    if (Constructor === null) return;
    try {
      recognitionRef.current?.abort();
    } catch {
      // A dead instance is fine to drop.
    }
    const recognition = new Constructor();
    recognitionRef.current = recognition;
    recognition.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    // maxAlternatives defaults to 1 per the spec; the single best transcript is all v1 needs.

    let finalTranscript = '';
    // A fresh instance per start(), so listeners never accumulate.
    recognition.addEventListener('result', event => {
      if (!isSpeechRecognitionEvent(event)) return;
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternative = result?.[0];
        if (result === undefined || alternative === undefined) continue;
        if (result.isFinal) {
          finalTranscript += alternative.transcript;
        } else {
          interim += alternative.transcript;
        }
      }
      if (finalTranscript.trim().length > 0) {
        setStatus('processing');
        optionsRef.current.onFinalTranscript?.(finalTranscript.trim());
        finalTranscript = '';
      } else if (interim.length > 0) {
        setStatus('listening');
      }
    });
    recognition.addEventListener('error', event => {
      if (!isSpeechRecognitionErrorEvent(event)) return;
      if (event.error === 'aborted') return;
      optionsRef.current.onError?.(event.error);
    });
    recognition.addEventListener('end', () => {
      recognitionRef.current = null;
      setStatus('idle');
      optionsRef.current.onEnd?.();
    });

    setStatus('listening');
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setStatus('idle');
    }
  }, []);

  // Unmounting with a live instance aborts it. The try/catch inside `abort`
  // covers engines that throw on an already-dead instance.
  useEffect(() => abort, [abort]);

  // Stable identity: orchestrators depend on this object in effects.
  return useMemo(() => ({ supported, status, start, stop, abort }), [supported, status, start, stop, abort]);
}

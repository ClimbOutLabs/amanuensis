'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useOptionalVoiceInput, type VoiceAvailability, type VoiceInputApi } from '../components/VoiceInputContext.js';
import { Icon } from '../icons/Icon.js';
import { auiButtonClass } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';
import { isVoiceCaptureSupported, startVoiceRecording, type VoiceRecorder } from './lib/voiceRecorder.js';

const TRANSCRIBE_ERROR_MESSAGE = 'Transcription failed, try again or type instead.';
const MIC_UNAVAILABLE_MESSAGE = 'Microphone unavailable. Check your microphone and try again.';
const RECORD_LIMIT_MESSAGE = 'Recording stopped at the 3-minute limit. Tap the mic to record another segment.';

type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'denied';

function appendTranscript(current: string, transcript: string): string {
  const trimmed = transcript.trim();
  if (trimmed === '') {
    return current;
  }
  if (current.trim() === '') {
    return trimmed;
  }
  return current.endsWith(' ') || current.endsWith('\n') ? `${current}${trimmed}` : `${current} ${trimmed}`;
}

/** getUserMedia rejects with these when the user (or browser policy) blocks the mic. */
function isPermissionDenial(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
}

function VoiceInputButtonInner({ api, disabled }: { api: VoiceInputApi; disabled: boolean }) {
  const aui = useAui();
  const composerText = useAuiState(s => s.composer.text);
  const [available, setAvailable] = useState<VoiceAvailability>(null);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [acquiring, setAcquiring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const composerTextRef = useRef(composerText);
  composerTextRef.current = composerText;

  useEffect(() => api.subscribeAvailability(setAvailable), [api]);

  // Fail-closed teardown: abort any in-flight transcription and release the mic
  // when the recording UI unmounts (covers in-app route changes too).
  useEffect(
    () => () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      recorderRef.current?.cancel();
      recorderRef.current = null;
    },
    [],
  );

  // Fail-closed on tab backgrounding: the voice session ends and tracks stop.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') {
        return;
      }
      const recorder = recorderRef.current;
      recorderRef.current = null;
      recorder?.cancel();
      abortRef.current?.abort();
      abortRef.current = null;
      setPhase(current => (current === 'recording' || current === 'transcribing' ? 'idle' : current));
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // Fail-closed on SPA route changes: the voice session ends and tracks stop,
  // even if the composer stays mounted across navigation.
  useEffect(() => {
    const onRouteChange = () => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      recorder?.cancel();
      abortRef.current?.abort();
      abortRef.current = null;
      setPhase(current => (current === 'recording' || current === 'transcribing' ? 'idle' : current));
    };
    window.addEventListener('trueforge:routechange', onRouteChange);
    return () => window.removeEventListener('trueforge:routechange', onRouteChange);
  }, []);

  const stopAndTranscribe = useCallback(
    async ({ autoStopped }: { autoStopped: boolean }): Promise<void> => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder == null) {
        return;
      }
      setPhase('transcribing');
      setError(null);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        // Releases the mic tracks before the network round-trip (fail-closed).
        const audio = await recorder.stop();
        const result = await api.transcribe({ audio, signal: controller.signal });
        if (!mountedRef.current || controller.signal.aborted) {
          return;
        }
        aui.composer().setText(appendTranscript(composerTextRef.current, result.text));
        if (autoStopped) {
          setNotice(RECORD_LIMIT_MESSAGE);
        }
      } catch {
        // Abort (cancel, unmount, route change, backgrounding) discards silently.
        if (controller.signal.aborted || !mountedRef.current) {
          return;
        }
        setError(TRANSCRIBE_ERROR_MESSAGE);
        if (autoStopped) {
          setNotice(RECORD_LIMIT_MESSAGE);
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        if (mountedRef.current) {
          setPhase(current => (current === 'transcribing' ? 'idle' : current));
        }
      }
    },
    [api, aui],
  );

  const startRecording = useCallback(async (): Promise<boolean> => {
    setError(null);
    setNotice(null);
    setAcquiring(true);
    try {
      const recorder = await startVoiceRecording({
        onAutoStop: () => {
          void stopAndTranscribe({ autoStopped: true });
        },
        onStreamEnded: () => {
          // Mic revoked mid-recording: release and surface the denied state.
          const lost = recorderRef.current;
          recorderRef.current = null;
          lost?.cancel();
          if (mountedRef.current) {
            setPhase('denied');
          }
        },
      });
      recorderRef.current = recorder;
      if (!mountedRef.current) {
        recorder.cancel();
        return false;
      }
      setPhase('recording');
      return true;
    } catch (error) {
      if (!mountedRef.current) {
        return false;
      }
      if (isPermissionDenial(error)) {
        setPhase('denied');
      } else {
        setError(MIC_UNAVAILABLE_MESSAGE);
      }
      return false;
    } finally {
      if (mountedRef.current) {
        setAcquiring(false);
      }
    }
  }, [stopAndTranscribe]);

  const cancelTranscription = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const toggle = () => {
    if (acquiring || phase === 'transcribing') {
      return;
    }
    if (phase === 'recording') {
      void stopAndTranscribe({ autoStopped: false });
      return;
    }
    if (phase === 'denied') {
      setPopoverOpen(true);
      return;
    }
    void startRecording();
  };

  const tryAgain = () => {
    void (async () => {
      const started = await startRecording();
      if (started) {
        setPopoverOpen(false);
      }
    })();
  };

  // Hidden until the `voice` capability flag has been observed true; the host
  // latches availability so the mic never disappears mid-session.
  if (available !== true) {
    return null;
  }

  const micTitle =
    phase === 'denied'
      ? 'Microphone access denied. Tap for help.'
      : phase === 'recording'
        ? 'Stop and transcribe'
        : 'Record voice message';

  return (
    <span className="relative inline-flex min-w-0 items-center gap-1">
      {phase === 'transcribing' ? (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span role="status" className="text-text-secondary text-xs whitespace-nowrap">
            Transcribing…
          </span>
          <button
            type="button"
            onClick={cancelTranscription}
            aria-label="Cancel transcription"
            className={auiButtonClass({ variant: 'ghost', size: 'small' })}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={toggle}
          disabled={acquiring || (disabled && phase !== 'recording')}
          title={micTitle}
          aria-label={micTitle}
          aria-pressed={phase === 'recording'}
          className={cn(
            auiButtonClass({ variant: 'ghost', size: 'icon' }),
            phase === 'recording' && 'bg-failure-bg/15',
            phase === 'denied' && 'text-failure-text',
          )}
        >
          {phase === 'recording' ? (
            <span aria-hidden="true" className="block h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
          ) : phase === 'denied' ? (
            <span className="relative inline-flex" aria-hidden="true">
              <Icon name="mic" />
              <span className="absolute top-1/2 left-1/2 h-px w-5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current" />
            </span>
          ) : (
            <Icon name="mic" />
          )}
        </button>
      )}
      {popoverOpen && phase === 'denied' && (
        <div
          role="dialog"
          aria-label="Microphone access denied"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              setPopoverOpen(false);
            }
          }}
          className="bg-card-bg border-border absolute right-0 bottom-full z-50 mb-2 w-64 rounded-lg border p-3 shadow-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-text-primary text-xs font-medium">Microphone access denied</p>
            <button
              type="button"
              onClick={() => setPopoverOpen(false)}
              aria-label="Close microphone help"
              className="text-text-secondary hover:text-text-primary shrink-0"
            >
              <Icon name="xmark" />
            </button>
          </div>
          <p className="text-text-secondary mt-1 text-xs">
            Microphone access denied. Enable it in your browser settings to use voice input, or type instead.
          </p>
          <p className="text-text-secondary mt-1 text-xs">
            Open site settings from the icon in the address bar, set Microphone to Allow, then try again.
          </p>
          <button
            type="button"
            onClick={tryAgain}
            className={auiButtonClass({ variant: 'secondary', size: 'small', className: 'mt-2' })}
          >
            Try again
          </button>
        </div>
      )}
      {error != null && (
        <span role="alert" className="text-failure-text inline-flex max-w-48 items-center gap-1 text-xs">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss transcription error"
            title="Dismiss"
            className="hover:text-text-primary shrink-0"
          >
            <Icon name="xmark" />
          </button>
        </span>
      )}
      {notice != null && (
        <span role="status" className="text-text-secondary inline-flex max-w-64 items-center gap-1 text-xs">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss recording limit notice"
            title="Dismiss"
            className="hover:text-text-primary shrink-0"
          >
            <Icon name="xmark" />
          </button>
        </span>
      )}
    </span>
  );
}

/**
 * Mic button for the chat composer. Hidden entirely until the host observes the
 * `voice` capability flag true (and when no host wired voice input or the
 * browser cannot capture audio). Tap-to-toggle: tap to record, tap again to
 * stop and transcribe. Denial surfaces as a tappable denied state with a help
 * popover, never a disabled button.
 */
export function VoiceInputButton({ disabled }: { disabled: boolean }) {
  const api = useOptionalVoiceInput();
  if (api == null || !isVoiceCaptureSupported()) {
    return null;
  }
  return <VoiceInputButtonInner api={api} disabled={disabled} />;
}

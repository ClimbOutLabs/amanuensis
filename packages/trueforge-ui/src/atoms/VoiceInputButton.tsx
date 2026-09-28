'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useOptionalVoiceInput, type VoiceInputApi } from '../components/VoiceInputContext.js';
import { Icon } from '../icons/Icon.js';
import { auiButtonClass } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';
import {
  isVoiceCaptureSupported,
  startVoiceRecording,
  VOICE_MAX_RECORD_SECONDS,
  type VoiceRecorder,
} from './lib/voiceRecorder.js';

const TRANSCRIBE_ERROR_MESSAGE = 'Transcription failed, try again or type instead.';
const MIC_ERROR_MESSAGE = 'Microphone unavailable. Check browser permission and try again.';
/** Re-probe STT availability this often while the sidecar is unreachable (it warms slowly). */
const STATUS_REPROBE_INTERVAL_MS = 30_000;

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

function formatRecordTime(totalSeconds: number): string {
  const capped = Math.min(totalSeconds, VOICE_MAX_RECORD_SECONDS);
  const minutes = Math.floor(capped / 60);
  const seconds = capped % 60;
  const maxMinutes = Math.floor(VOICE_MAX_RECORD_SECONDS / 60);
  const maxSeconds = VOICE_MAX_RECORD_SECONDS % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')} / ${maxMinutes}:${String(maxSeconds).padStart(2, '0')}`;
}

function VoiceInputButtonInner({ api, disabled }: { api: VoiceInputApi; disabled: boolean }) {
  const aui = useAui();
  const composerText = useAuiState(s => s.composer.text);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  /** Last recorded audio, kept when transcription fails so the user can retry. */
  const failedAudioRef = useRef<Blob | null>(null);
  const composerTextRef = useRef(composerText);
  composerTextRef.current = composerText;
  const availableRef = useRef(available);
  availableRef.current = available;

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const status = await api.getStatus();
        if (!cancelled) {
          setAvailable(status.stt_available);
        }
      } catch {
        if (!cancelled) {
          setAvailable(false);
        }
      }
    };
    void probe();
    // The sidecar can take minutes to warm; keep probing while unavailable so
    // the button recovers without a page reload.
    const interval = setInterval(() => {
      if (availableRef.current === false) {
        void probe();
      }
    }, STATUS_REPROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [api]);

  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
    },
    [],
  );

  // Recording elapsed-time display.
  useEffect(() => {
    if (!recording) {
      setRecordSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const interval = setInterval(() => {
      setRecordSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [recording]);

  const transcribeAudio = useCallback(
    async (audio: Blob) => {
      setTranscribing(true);
      setError(null);
      try {
        const result = await api.transcribe({ audio });
        failedAudioRef.current = null;
        aui.composer().setText(appendTranscript(composerTextRef.current, result.text));
      } catch {
        // Keep the audio so the user can retry instead of re-recording.
        failedAudioRef.current = audio;
        setError(TRANSCRIBE_ERROR_MESSAGE);
      } finally {
        setTranscribing(false);
      }
    },
    [api, aui],
  );

  const stopAndTranscribe = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder == null) {
      return;
    }
    setRecording(false);
    try {
      const audio = await recorder.stop();
      await transcribeAudio(audio);
    } catch {
      setError(TRANSCRIBE_ERROR_MESSAGE);
    }
  }, [transcribeAudio]);

  const retryTranscribe = useCallback(() => {
    const audio = failedAudioRef.current;
    if (audio != null) {
      void transcribeAudio(audio);
    }
  }, [transcribeAudio]);

  const startRecording = useCallback(async () => {
    setError(null);
    failedAudioRef.current = null;
    setBusy(true);
    try {
      const recorder = await startVoiceRecording({
        onAutoStop: () => {
          void stopAndTranscribe();
        },
      });
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError(MIC_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }, [stopAndTranscribe]);

  const toggle = () => {
    if (busy || transcribing) {
      return;
    }
    if (recording) {
      void stopAndTranscribe();
    } else {
      void startRecording();
    }
  };

  if (available === false) {
    return (
      <button
        type="button"
        disabled
        title="Voice input unavailable"
        aria-label="Voice input unavailable"
        className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
      >
        <Icon name="mic" />
      </button>
    );
  }

  const isBusy = busy || transcribing;

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled || isBusy || available == null}
        title={recording ? 'Stop and transcribe' : 'Record voice message'}
        aria-label={recording ? 'Stop recording and transcribe' : 'Record voice message'}
        aria-pressed={recording}
        className={cn(auiButtonClass({ variant: 'ghost', size: 'icon' }), recording && 'bg-failure-bg/15')}
      >
        {recording ? (
          <span aria-hidden="true" className="block h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
        ) : (
          <Icon name="mic" />
        )}
      </button>
      {recording && (
        <span aria-live="polite" className="text-text-secondary text-xs tabular-nums">
          {formatRecordTime(recordSeconds)}
        </span>
      )}
      {transcribing && (
        <span aria-live="polite" className="text-text-secondary inline-flex items-center gap-1 text-xs">
          <span aria-hidden="true" className="block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Transcribing…
        </span>
      )}
      {error != null && (
        <span role="alert" className="text-failure-text inline-flex max-w-48 items-center gap-1 text-xs">
          <span className="truncate">{error}</span>
          {failedAudioRef.current != null && !transcribing && (
            <button
              type="button"
              onClick={retryTranscribe}
              aria-label="Retry transcription"
              title="Retry with the same recording"
              className="hover:text-text-primary shrink-0 underline"
            >
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setError(null);
              failedAudioRef.current = null;
            }}
            aria-label="Dismiss transcription error"
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
 * Mic button for the chat composer. Hidden entirely when no host wired voice
 * input or the browser cannot capture audio; disabled with a tooltip while the
 * STT sidecar is unreachable.
 */
export function VoiceInputButton({ disabled }: { disabled: boolean }) {
  const api = useOptionalVoiceInput();
  if (api == null || !isVoiceCaptureSupported()) {
    return null;
  }
  return <VoiceInputButtonInner api={api} disabled={disabled} />;
}

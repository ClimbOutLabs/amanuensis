'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useOptionalVoiceInput, type VoiceInputApi } from '../components/VoiceInputContext.js';
import { Icon } from '../icons/Icon.js';
import { auiButtonClass } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';
import { isVoiceCaptureSupported, startVoiceRecording, type VoiceRecorder } from './lib/voiceRecorder.js';

const TRANSCRIBE_ERROR_MESSAGE = 'Transcription failed, try again or type instead.';
const MIC_ERROR_MESSAGE = 'Microphone unavailable. Check browser permission and try again.';

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

function VoiceInputButtonInner({ api, disabled }: { api: VoiceInputApi; disabled: boolean }) {
  const aui = useAui();
  const composerText = useAuiState(s => s.composer.text);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const composerTextRef = useRef(composerText);
  composerTextRef.current = composerText;

  useEffect(() => {
    let cancelled = false;
    api.getStatus().then(
      status => {
        if (!cancelled) {
          setAvailable(status.stt_available);
        }
      },
      () => {
        if (!cancelled) {
          setAvailable(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
    },
    [],
  );

  const stopAndTranscribe = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder == null) {
      return;
    }
    setRecording(false);
    setBusy(true);
    try {
      const audio = await recorder.stop();
      const result = await api.transcribe({ audio });
      aui.composer().setText(appendTranscript(composerTextRef.current, result.text));
    } catch {
      setError(TRANSCRIBE_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }, [api, aui]);

  const startRecording = useCallback(async () => {
    setError(null);
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
    if (busy) {
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

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled || busy || available == null}
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
      {error != null && (
        <span role="alert" className="text-failure-text inline-flex max-w-48 items-center gap-1 text-xs">
          <span className="truncate">{error}</span>
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

'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useSpokenReply } from '../components/SpokenReplyContext.js';
import { useOptionalVoiceInput, type VoiceAvailability, type VoiceInputApi } from '../components/VoiceInputContext.js';
import { Icon } from '../icons/Icon.js';
import { hotkeyById, matchesHotkey, usePushToTalkHotkey } from '../utils/pushToTalkHotkey.js';
import {
  beginLiveStart,
  endLiveLine,
  finishLiveStart,
  getVoiceMode,
  liveLineEnded,
  liveLineEvents,
  nameLiveStartSession,
  setLiveLine,
  setLiveNotice,
  setVoiceMode,
  useLiveNotice,
  useVoiceMode,
} from '../utils/voiceMode.js';
import { markDraftFromVoice } from '../utils/voiceTurn.js';
import { auiButtonClass } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';
import { startLiveVoice } from './lib/liveVoice.js';
import { isVoiceCaptureSupported, startVoiceRecording, type VoiceRecorder } from './lib/voiceRecorder.js';
import { Tooltip } from './primitives/Tooltip.js';

const TRANSCRIBE_ERROR_MESSAGE = 'Transcription failed, try again or type instead.';
const MIC_UNAVAILABLE_MESSAGE = 'Microphone unavailable. Check your microphone and try again.';
const RECORD_LIMIT_MESSAGE = 'Recording stopped at the 3-minute limit. Tap the mic to record another segment.';
const VOICE_MODE_FAILED_MESSAGE = 'Voice mode could not start. Check your microphone, then try again.';

/** The hints are a sentence long, so they wrap instead of running off a narrow screen. */
const VOICE_HINT_CLASS = 'w-max max-w-64 whitespace-normal text-center';

const VOICE_MODE_LABELS = {
  connecting: 'Getting ready…',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking. Talk to interrupt.',
} as const;

type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'denied';

/** A press held at least this long after recording starts is push-to-talk: letting go sends. */
export const HOLD_TO_SEND_MS = 400;

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

function VoiceInputButtonInner({
  api,
  disabled,
  isRunning,
}: {
  api: VoiceInputApi;
  disabled: boolean;
  isRunning: boolean;
}) {
  const aui = useAui();
  const sessionId = useAuiState(s => s.threadListItem.remoteId);
  const voiceMode = useVoiceMode();
  const composerText = useAuiState(s => s.composer.text);
  const [available, setAvailable] = useState<VoiceAvailability>(null);
  const spokenReply = useSpokenReply();
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [acquiring, setAcquiring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept outside the button, so a message for the person survives the composer being rebuilt.
  const notice = useLiveNotice();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  // Each start takes the next number; a stop bumps it, so a start still waiting on the mic is dropped.
  const startTokenRef = useRef(0);
  const recordingStartedAtRef = useRef<number | null>(null);
  // A press (pointer or hotkey) that started the recording and is still held.
  const pressHeldRef = useRef(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const [sendPending, setSendPending] = useState(false);
  const { hotkeyId } = usePushToTalkHotkey();
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
      startTokenRef.current++;
      abortRef.current?.abort();
      abortRef.current = null;
      recorderRef.current?.cancel();
      recorderRef.current = null;
    },
    [],
  );

  /** Ends any recording, a start still waiting on the mic, and a transcription in flight. */
  const cancelVoice = useCallback(() => {
    startTokenRef.current++;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    recordingStartedAtRef.current = null;
    recorder?.cancel();
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase(current => (current === 'recording' || current === 'transcribing' ? 'idle' : current));
  }, []);

  /** Ends voice mode: the line, the mic and any playback. One tap anywhere ends it. */
  const endVoiceMode = useCallback(() => {
    endLiveLine();
  }, []);

  // Fail-closed on tab backgrounding: a recording ends and tracks stop. The chat's bridge ends voice mode.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') cancelVoice();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [cancelVoice]);

  // Fail-closed on SPA route changes: the recording ends and tracks stop, even if the composer
  // stays mounted across navigation. Voice mode stays: a new chat changes its address when it gets
  // its id, and switching to another chat ends it (below).
  useEffect(() => {
    const onRouteChange = () => {
      if (getVoiceMode() !== 'off') return;
      cancelVoice();
    };
    window.addEventListener('trueforge:routechange', onRouteChange);
    return () => window.removeEventListener('trueforge:routechange', onRouteChange);
  }, [cancelVoice]);

  const stopAndTranscribe = useCallback(
    async ({ autoStopped, send }: { autoStopped: boolean; send: boolean }): Promise<void> => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      recordingStartedAtRef.current = null;
      pressHeldRef.current = false;
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
        const spoke = result.text.trim() !== '';
        if (spoke) markDraftFromVoice();
        aui.composer().setText(appendTranscript(composerTextRef.current, result.text));
        // Sent once the new text has rendered, through the same submit path as the Send button.
        if (send && spoke && !autoStopped) {
          setSendPending(true);
        }
        if (autoStopped) {
          setLiveNotice(RECORD_LIMIT_MESSAGE);
        }
      } catch {
        // Abort (cancel, unmount, route change, backgrounding) discards silently.
        if (controller.signal.aborted || !mountedRef.current) {
          return;
        }
        setError(TRANSCRIBE_ERROR_MESSAGE);
        if (autoStopped) {
          setLiveNotice(RECORD_LIMIT_MESSAGE);
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
    // Speaking a reply and recording a new message at once would have the mic hear the reply.
    spokenReply.stop();
    setError(null);
    setLiveNotice(null);
    setAcquiring(true);
    const token = ++startTokenRef.current;
    try {
      const recorder = await startVoiceRecording({
        onAutoStop: () => {
          void stopAndTranscribe({ autoStopped: true, send: false });
        },
        onStreamEnded: () => {
          // Mic revoked mid-recording: release and surface the denied state.
          cancelVoice();
          if (mountedRef.current) {
            setPhase('denied');
          }
        },
      });
      // Stopped (or unmounted) while the mic was opening: drop this recording.
      if (token !== startTokenRef.current || !mountedRef.current) {
        recorder.cancel();
        return false;
      }
      recorderRef.current = recorder;
      recordingStartedAtRef.current = Date.now();
      setPhase('recording');
      return true;
    } catch (error) {
      if (token !== startTokenRef.current || !mountedRef.current) {
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
  }, [stopAndTranscribe, spokenReply, cancelVoice]);

  const toggleVoiceMode = () => {
    if (getVoiceMode() !== 'off') {
      endVoiceMode();
      return;
    }
    if (acquiring || phase !== 'idle' || disabled) return;
    setLiveNotice(null);
    setError(null);
    // Reading a reply aloud by hand and listening at once would have the mic hear the reply.
    spokenReply.stop();
    setVoiceMode('connecting');
    const controller = beginLiveStart(sessionId ?? null);
    void (async () => {
      try {
        // A new chat has no session yet; it is created the same way the first typed send creates one.
        const chatId = sessionId ?? (await aui.threadListItem().initialize()).remoteId;
        nameLiveStartSession({ controller, sessionId: chatId });
        // The person moved to another chat while this one was being created.
        if (controller.signal.aborted) return;
        const connection = await api.connect({ sessionId: chatId, signal: controller.signal });
        const live = await startLiveVoice({
          connection,
          events: {
            onState: setVoiceMode,
            ...liveLineEvents,
            onEnded: reason => {
              // A line that was replaced or ended on purpose has nothing more to report.
              if (!controller.signal.aborted) liveLineEnded(reason);
            },
          },
        });
        // Ended (a tap, another chat, leaving) while the line was opening.
        if (controller.signal.aborted || getVoiceMode() === 'off') {
          live.stop();
          return;
        }
        setLiveLine({ stop: live.stop, sessionId: chatId });
        setVoiceMode('listening');
      } catch (failure) {
        if (controller.signal.aborted) return;
        // Whichever way the button is placed now, voice mode is off again and the person hears why.
        setVoiceMode('off');
        if (isPermissionDenial(failure)) setPhase('denied');
        else {
          const message =
            failure instanceof Error && failure.message !== '' ? failure.message : VOICE_MODE_FAILED_MESSAGE;
          // A button that was rebuilt meanwhile cannot show an error of its own, so the person hears it as a notice.
          if (mountedRef.current) setError(message);
          else setLiveNotice(message);
        }
      } finally {
        finishLiveStart(controller);
      }
    })();
  };

  const cancelTranscription = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Start of a press on the mic or the hotkey. While recording, a press stops it and leaves the
   * text in the box to check; otherwise it starts recording.
   */
  const beginPress = (): boolean => {
    // The hotkey listens while the mic is still hidden; it does nothing until the mic shows.
    if (available !== true || acquiring || phase === 'transcribing') {
      return false;
    }
    if (disabled && phase !== 'recording') {
      return false;
    }
    // Taking the mic by hand ends voice mode; a recording in progress is kept for the box.
    if (getVoiceMode() !== 'off') endVoiceMode();
    if (phase === 'recording') {
      void stopAndTranscribe({ autoStopped: false, send: false });
      return true;
    }
    if (phase === 'denied') {
      setPopoverOpen(true);
      return true;
    }
    pressHeldRef.current = true;
    void startRecording();
    return true;
  };

  /**
   * End of a press. A short press was a tap, so recording goes on until the next tap. A press held
   * while recording for at least HOLD_TO_SEND_MS was push-to-talk, so the words are sent.
   */
  const endPress = () => {
    if (!pressHeldRef.current) {
      return;
    }
    pressHeldRef.current = false;
    const startedAt = recordingStartedAtRef.current;
    if (recorderRef.current != null && startedAt != null && Date.now() - startedAt >= HOLD_TO_SEND_MS) {
      void stopAndTranscribe({ autoStopped: false, send: true });
    }
  };

  const pressRef = useRef({ beginPress, endPress });
  pressRef.current = { beginPress, endPress };

  useEffect(() => {
    if (!sendPending) return;
    setSendPending(false);
    rootRef.current?.closest('form')?.requestSubmit();
  }, [sendPending]);

  useEffect(() => {
    const hotkey = hotkeyById(hotkeyId);
    if (hotkey === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesHotkey(event, hotkey)) return;
      // The keys are left to the page whenever they would do nothing here.
      if (event.repeat ? pressHeldRef.current : pressRef.current.beginPress()) event.preventDefault();
    };
    // Modifiers may be let go first, so the press ends on Space alone.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') pressRef.current.endPress();
    };
    // A key let go in another window never reports here; treat leaving the window as letting go.
    const onBlur = () => pressRef.current.endPress();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [hotkeyId]);

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
  // While a turn runs, Stop is the only control at the end of the bar, unless voice mode is on:
  // then its switch stays so one tap can end it while the answer is read.
  if (isRunning && voiceMode === 'off') {
    return null;
  }

  const micTitle =
    phase === 'denied'
      ? 'Microphone access denied. Tap for help.'
      : phase === 'recording'
        ? 'Stop and transcribe'
        : 'Record voice message';
  // The mic and the voice mode switch sit side by side, so each hint says what it is before how to use it.
  const micHint =
    phase === 'denied'
      ? micTitle
      : 'Voice message: tap to record and check the words, or hold to talk and let go to send.';
  const voiceModeHint =
    voiceMode === 'off'
      ? 'Voice mode: just talk, pause, and hear the answer. Talk over it to interrupt.'
      : 'End voice mode.';

  return (
    <span ref={rootRef} className="relative inline-flex min-w-0 items-center gap-1">
      {!isRunning && (
        <>
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
            // No hint while recording: a tap stops it, but letting go of a hold sends, and one hint cannot say both.
            <Tooltip content={phase === 'recording' ? null : micHint} className={VOICE_HINT_CLASS}>
              <button
                type="button"
                onPointerDown={event => {
                  if (event.button !== 0) return;
                  // Keeps the release reported here when the finger or pointer drifts off the button.
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  beginPress();
                }}
                onPointerUp={endPress}
                onPointerCancel={endPress}
                onContextMenu={event => event.preventDefault()}
                onClick={event => {
                  // Pointer presses are handled above; only keyboard activation (no click count) gets here as a tap.
                  if (event.detail !== 0) return;
                  beginPress();
                  endPress();
                }}
                disabled={acquiring || (disabled && phase !== 'recording')}
                aria-label={micTitle}
                aria-pressed={phase === 'recording'}
                className={cn(
                  auiButtonClass({ variant: 'ghost', size: 'icon' }),
                  'touch-none select-none',
                  phase === 'recording' && 'bg-failure-bg/15',
                  phase === 'denied' && 'text-failure-text',
                )}
              >
                {phase === 'recording' ? (
                  <span aria-hidden="true" className="block h-2.5 w-2.5 animate-pulse rounded-full bg-recording" />
                ) : phase === 'denied' ? (
                  <span className="relative inline-flex" aria-hidden="true">
                    <Icon name="mic" />
                    <span className="absolute top-1/2 left-1/2 h-px w-5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current" />
                  </span>
                ) : (
                  <Icon name="mic" />
                )}
              </button>
            </Tooltip>
          )}
        </>
      )}
      {phase !== 'denied' && (
        <Tooltip content={voiceModeHint} className={VOICE_HINT_CLASS}>
          <button
            type="button"
            onClick={toggleVoiceMode}
            disabled={voiceMode === 'off' && (acquiring || disabled || phase !== 'idle')}
            aria-label={voiceMode === 'off' ? 'Start voice mode' : 'End voice mode'}
            aria-pressed={voiceMode !== 'off'}
            className={cn(
              auiButtonClass({ variant: 'ghost', size: 'icon' }),
              voiceMode !== 'off' && 'bg-card-bg',
              voiceMode === 'listening' && 'animate-pulse',
            )}
          >
            <Icon name="audio-lines" />
          </button>
        </Tooltip>
      )}
      {voiceMode !== 'off' && (
        <span role="status" className="text-text-secondary text-xs whitespace-nowrap">
          {VOICE_MODE_LABELS[voiceMode]}
        </span>
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
            onClick={() => setLiveNotice(null)}
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
 * browser cannot capture audio). Tap to record and tap again to put the words
 * in the box; or hold (the button or the push-to-talk hotkey) to talk and let
 * go to send. Denial surfaces as a tappable denied state with a help popover,
 * never a disabled button.
 */
export function VoiceInputButton({ disabled, isRunning = false }: { disabled: boolean; isRunning?: boolean }) {
  const api = useOptionalVoiceInput();
  if (api == null || !isVoiceCaptureSupported()) {
    return null;
  }
  return <VoiceInputButtonInner api={api} disabled={disabled} isRunning={isRunning} />;
}

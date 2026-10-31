'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useSpokenReply } from '../components/SpokenReplyContext.js';
import { useOptionalVoiceInput, type VoiceAvailability, type VoiceInputApi } from '../components/VoiceInputContext.js';
import { Icon } from '../icons/Icon.js';
import { hotkeyById, matchesHotkey, usePushToTalkHotkey } from '../utils/pushToTalkHotkey.js';
import { getHandsFree, hasDraftFromVoice, markDraftFromVoice, setHandsFree, useHandsFree } from '../utils/voiceTurn.js';
import { auiButtonClass } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';
import {
  isVoiceCaptureSupported,
  type SilenceEvent,
  startVoiceRecording,
  type VoiceRecorder,
} from './lib/voiceRecorder.js';

const TRANSCRIBE_ERROR_MESSAGE = 'Transcription failed, try again or type instead.';
const MIC_UNAVAILABLE_MESSAGE = 'Microphone unavailable. Check your microphone and try again.';
const RECORD_LIMIT_MESSAGE = 'Recording stopped at the 3-minute limit. Tap the mic to record another segment.';
const HANDS_FREE_QUIET_MESSAGE = 'Hands-free stopped because it was quiet for a while. Tap it to start again.';
const HANDS_FREE_NOT_SENT_MESSAGE = 'Hands-free stopped because the message could not be sent yet. Check the box.';

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
  const composerText = useAuiState(s => s.composer.text);
  const [available, setAvailable] = useState<VoiceAvailability>(null);
  const spokenReply = useSpokenReply();
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [acquiring, setAcquiring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  // A press (pointer or hotkey) that started the recording and is still held.
  const pressHeldRef = useRef(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const [sendPending, setSendPending] = useState(false);
  const handsFree = useHandsFree();
  // Starts the next hands-free listen; set below, once startRecording exists.
  const listenRef = useRef<() => void>(() => {});
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
      setHandsFree('off');
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
      // Hands-free belongs to one chat; leaving it ends the conversation.
      setHandsFree('off');
      setPhase(current => (current === 'recording' || current === 'transcribing' ? 'idle' : current));
    };
    window.addEventListener('trueforge:routechange', onRouteChange);
    return () => window.removeEventListener('trueforge:routechange', onRouteChange);
  }, []);

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
        } else if (getHandsFree() !== 'off') {
          if (autoStopped) setHandsFree('off');
          // Nothing was heard but noise: keep listening.
          else if (!spoke) listenRef.current();
        }
        if (autoStopped) {
          setNotice(RECORD_LIMIT_MESSAGE);
        }
      } catch {
        // Abort (cancel, unmount, route change, backgrounding) discards silently.
        if (controller.signal.aborted || !mountedRef.current) {
          return;
        }
        setHandsFree('off');
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

  const startRecording = useCallback(
    async ({ listen }: { listen: boolean }): Promise<boolean> => {
      // Speaking a reply and recording a new message at once would have the mic hear the reply.
      spokenReply.stop();
      setError(null);
      setNotice(null);
      setAcquiring(true);
      try {
        const recorder = await startVoiceRecording({
          onAutoStop: () => {
            void stopAndTranscribe({ autoStopped: true, send: false });
          },
          // Hands-free: a pause after speech sends; a long quiet ends the conversation.
          ...(listen
            ? {
                onSilence: (event: SilenceEvent) => {
                  if (event === 'pause') {
                    void stopAndTranscribe({ autoStopped: false, send: true });
                    return;
                  }
                  const quiet = recorderRef.current;
                  recorderRef.current = null;
                  quiet?.cancel();
                  if (!mountedRef.current) return;
                  setHandsFree('off');
                  setPhase(current => (current === 'recording' ? 'idle' : current));
                  setNotice(HANDS_FREE_QUIET_MESSAGE);
                },
              }
            : {}),
          onStreamEnded: () => {
            // Mic revoked mid-recording: release and surface the denied state.
            const lost = recorderRef.current;
            recorderRef.current = null;
            lost?.cancel();
            if (mountedRef.current) {
              setHandsFree('off');
              setPhase('denied');
            }
          },
        });
        recorderRef.current = recorder;
        if (!mountedRef.current) {
          recorder.cancel();
          return false;
        }
        recordingStartedAtRef.current = Date.now();
        setPhase('recording');
        return true;
      } catch (error) {
        if (!mountedRef.current) {
          return false;
        }
        setHandsFree('off');
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
    },
    [stopAndTranscribe, spokenReply],
  );

  listenRef.current = () => {
    setHandsFree('listening');
    void startRecording({ listen: true });
  };

  // Hands-free listens again once the answer is over, and picks up where it was after the composer
  // remounts. A hidden tab never listens.
  useEffect(() => {
    // Mounted mid-listen (the composer remounted): that recording is gone, so listen afresh.
    if (getHandsFree() === 'listening') setHandsFree('listen-due');
  }, []);

  useEffect(() => {
    if (available !== true || handsFree !== 'listen-due') return;
    if (document.visibilityState === 'hidden') {
      setHandsFree('off');
      return;
    }
    listenRef.current();
  }, [handsFree, available]);

  const toggleHandsFree = () => {
    if (getHandsFree() !== 'off') {
      setHandsFree('off');
      const recorder = recorderRef.current;
      recorderRef.current = null;
      recordingStartedAtRef.current = null;
      recorder?.cancel();
      setPhase(current => (current === 'recording' ? 'idle' : current));
      return;
    }
    if (acquiring || phase === 'recording' || phase === 'transcribing' || disabled) return;
    setNotice(null);
    listenRef.current();
  };

  const cancelTranscription = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Start of a press on the mic or the hotkey. While recording, a press stops it and leaves the
   * text in the box to check; otherwise it starts recording.
   */
  const beginPress = () => {
    // The hotkey listens while the mic is still hidden; it does nothing until the mic shows.
    if (available !== true || acquiring || phase === 'transcribing') {
      return;
    }
    if (disabled && phase !== 'recording') {
      return;
    }
    // Taking the mic by hand ends hands-free; a recording in progress is kept for the box.
    if (getHandsFree() !== 'off') setHandsFree('off');
    if (phase === 'recording') {
      void stopAndTranscribe({ autoStopped: false, send: false });
      return;
    }
    if (phase === 'denied') {
      setPopoverOpen(true);
      return;
    }
    pressHeldRef.current = true;
    void startRecording({ listen: false });
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
    if (getHandsFree() === 'off') return;
    // The composer takes the voice draft only when it sends; a draft still here was not sent.
    if (hasDraftFromVoice()) {
      setHandsFree('off');
      setNotice(HANDS_FREE_NOT_SENT_MESSAGE);
    } else {
      setHandsFree('answering');
    }
  }, [sendPending]);

  useEffect(() => {
    const hotkey = hotkeyById(hotkeyId);
    if (hotkey === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesHotkey(event, hotkey)) return;
      event.preventDefault();
      if (!event.repeat) pressRef.current.beginPress();
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
      const started = await startRecording({ listen: false });
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
  // While a turn runs, Stop is the only control at the end of the bar, unless a hands-free
  // conversation is on: then its switch stays so it can be ended while Aman answers.
  if (isRunning && handsFree === 'off') {
    return null;
  }

  const micTitle =
    phase === 'denied'
      ? 'Microphone access denied. Tap for help.'
      : phase === 'recording'
        ? 'Stop and transcribe'
        : 'Record voice message';
  const micHint = phase === 'idle' ? 'Tap to record, or hold to talk and let go to send.' : micTitle;

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
              title={micHint}
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
          )}
        </>
      )}
      {phase !== 'denied' && (
        <button
          type="button"
          onClick={toggleHandsFree}
          disabled={handsFree === 'off' && (acquiring || disabled || phase !== 'idle')}
          title={
            handsFree === 'off' ? 'Talk hands-free: pause to send, and the answer is read aloud' : 'Stop hands-free'
          }
          aria-label={handsFree === 'off' ? 'Start hands-free conversation' : 'Stop hands-free conversation'}
          aria-pressed={handsFree !== 'off'}
          className={cn(auiButtonClass({ variant: 'ghost', size: 'icon' }), handsFree !== 'off' && 'bg-failure-bg/15')}
        >
          <Icon name="audio-lines" />
        </button>
      )}
      {handsFree !== 'off' && (
        <span role="status" className="text-text-secondary text-xs whitespace-nowrap">
          {handsFree === 'answering'
            ? 'Waiting for the answer…'
            : phase === 'recording'
              ? 'Listening. Pause to send.'
              : ''}
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

'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useAui, useAuiState, type ThreadMessage } from '@assistant-ui/react';
import { useEffect, useRef } from 'react';

import { useComposerBusyState } from '../hooks/useComposerBusyState.js';
import { useHandsFree } from './HandsFreeContext.js';
import { messageTextOf } from './messageText.js';
import { useSpeechRecognition } from './useSpeechRecognition.js';
import { useVoiceSettings } from './VoiceSettingsContext.js';
import { useVoiceSpeech } from './VoiceSpeechContext.js';

/** Pause after a silence-timeout before the hands-free loop listens again. */
const LISTEN_RESTART_DELAY_MS = 400;

/** Latest completed assistant message, if any. */
function lastCompletedAssistantMessage(messages: readonly ThreadMessage[]): ThreadMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== 'assistant') continue;
    if (message.status.type !== 'complete') continue;
    return message;
  }
  return undefined;
}

/**
 * The hands-free / auto-read orchestrator. Mounted once inside the thread
 * view (it needs the assistant-ui runtime):
 *
 * - Auto-read: when enabled, a completed assistant message is spoken aloud.
 * - Hands-free: after the response finishes speaking, listening starts
 *   automatically; the dictated turn is sent, and the loop continues.
 * - Escape exits hands-free from anywhere in the chat view.
 *
 * Manual dictation (the composer mic button) owns its own recognition
 * instance; clicking it exits hands-free first, so the two never overlap.
 */
export function VoiceLoopContainer() {
  const aui = useAui();
  const handsFree = useHandsFree();
  const { settings } = useVoiceSettings();
  const speech = useVoiceSpeech();
  const { send: sendWithBusy } = useComposerBusyState();

  const messages = useAuiState(s => s.thread.messages);
  const isThreadRunning = useThreadIsRunning();
  const composerText = useAuiState(s => s.composer.text);

  // Event-time snapshot; recognition/speech callbacks always see the latest.
  const stateRef = useRef({ handsFree: false, running: false, speaking: false });
  stateRef.current = {
    handsFree: handsFree.active,
    running: isThreadRunning,
    speaking: speech.speakingId !== null,
  };
  const composerTextRef = useRef(composerText);
  composerTextRef.current = composerText;
  const lastAutoReadId = useRef<string | null>(null);
  const restartTimer = useRef<number | null>(null);

  const recognition = useSpeechRecognition({
    onFinalTranscript: transcript => {
      const text = transcript.trim();
      if (text.length === 0) return;
      const composer = aui.composer();
      if (stateRef.current.handsFree) {
        // Hands-free keeps the loop going: send the turn right away.
        composer.setText(text);
        sendWithBusy(() => {
          composer.send();
        });
      } else {
        // Manual dictation appends to the draft; the user sends when ready.
        const current = composerTextRef.current;
        composer.setText(current.length > 0 ? `${current} ${text}` : text);
      }
    },
    onEnd: () => {
      const state = stateRef.current;
      if (!state.handsFree || state.running || state.speaking) return;
      // Silence timeout while hands-free: keep the conversation loop alive.
      if (restartTimer.current !== null) window.clearTimeout(restartTimer.current);
      restartTimer.current = window.setTimeout(() => {
        restartTimer.current = null;
        const now = stateRef.current;
        if (now.handsFree && !now.running && !now.speaking) {
          recognition.start();
        }
      }, LISTEN_RESTART_DELAY_MS);
    },
    onError: error => {
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        // The mic is blocked: hands-free cannot continue.
        handsFree.setActive(false);
      }
    },
  });

  const startListening = recognition.start;

  // Auto-read: speak each completed assistant message once. When hands-free is
  // on but TTS is unavailable, go straight back to listening instead.
  useEffect(() => {
    if (!settings.autoRead && !handsFree.active) return;
    const last = lastCompletedAssistantMessage(messages);
    if (last === undefined || last.id === lastAutoReadId.current) return;
    const text = messageTextOf(last.content);
    if (text.length === 0) return;
    lastAutoReadId.current = last.id;
    if (!settings.ttsEnabled || !speech.supported) {
      const now = stateRef.current;
      if (now.handsFree && !now.running && !now.speaking) startListening();
      return;
    }
    speech.speak({
      id: last.id,
      text,
      onEnd: () => {
        // Response was read: listen for the next turn.
        const now = stateRef.current;
        if (now.handsFree && !now.running && !now.speaking) startListening();
      },
    });
  }, [messages, settings.ttsEnabled, settings.autoRead, handsFree.active, speech, startListening]);

  // Hands-free transitions: turning it on starts listening; turning it off
  // stops recognition, pending restarts, and any speech. Transition-gated so
  // unrelated re-renders (settings changes, status flips) never cut audio.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = handsFree.active;
    if (handsFree.active && !wasActive) {
      const state = stateRef.current;
      if (!state.running && !state.speaking) startListening();
    } else if (!handsFree.active && wasActive) {
      if (restartTimer.current !== null) {
        window.clearTimeout(restartTimer.current);
        restartTimer.current = null;
      }
      recognition.stop();
      speech.stop();
    }
  }, [handsFree.active, startListening, recognition, speech]);

  // Escape exits hands-free from anywhere in the chat view.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!stateRef.current.handsFree) return;
      handsFree.setActive(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handsFree]);

  useEffect(
    () => () => {
      if (restartTimer.current !== null) window.clearTimeout(restartTimer.current);
    },
    [],
  );

  return null;
}

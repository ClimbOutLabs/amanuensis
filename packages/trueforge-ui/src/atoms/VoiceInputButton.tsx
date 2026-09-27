'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import { useRef } from 'react';

import { Icon } from '../icons/Icon.js';
import { useHandsFree } from '../voice/HandsFreeContext.js';
import { useSpeechRecognition } from '../voice/useSpeechRecognition.js';
import { useVoiceSettings } from '../voice/VoiceSettingsContext.js';
import { useVoiceSpeech } from '../voice/VoiceSpeechContext.js';
import { cn } from './lib/cn.js';
import { IconButton } from './primitives/IconButton.js';
import { Spinner } from './primitives/Spinner.js';

/**
 * Push-to-talk dictation for the composer. Toggle to start and stop;
 * finalized transcripts stream into the composer draft. Hidden unless voice
 * input is enabled in settings; where the Web Speech API is unavailable it
 * degrades to a disabled button explaining why.
 */
export function VoiceInputButton() {
  const aui = useAui();
  const { settings } = useVoiceSettings();
  const speech = useVoiceSpeech();
  const handsFree = useHandsFree();
  const composerText = useAuiState(s => s.composer.text);
  const composerTextRef = useRef(composerText);
  composerTextRef.current = composerText;

  const recognition = useSpeechRecognition({
    onFinalTranscript: transcript => {
      const text = transcript.trim();
      if (text.length === 0) return;
      const current = composerTextRef.current;
      aui.composer().setText(current.length > 0 ? `${current} ${text}` : text);
    },
  });

  if (!settings.voiceInputEnabled) return null;

  if (!recognition.supported) {
    return (
      <IconButton
        aria-label="Voice input unavailable"
        tooltip="Voice input is not supported in this browser. Try Chrome or Edge."
        variant="ghost"
        disabled
        className="text-text-secondary/50"
      >
        <Icon name="mic-off" size="1rem" />
      </IconButton>
    );
  }

  const listening = recognition.status === 'listening';
  const processing = recognition.status === 'processing';

  return (
    <IconButton
      aria-label={listening ? 'Stop dictation' : 'Dictate with your voice'}
      tooltip={listening ? 'Stop dictation' : 'Dictate with your voice'}
      aria-pressed={listening}
      variant="ghost"
      onClick={() => {
        // Any mic click exits hands-free; the loop's own recognition stops with it.
        if (handsFree.active) handsFree.setActive(false);
        if (listening || processing) {
          recognition.stop();
        } else {
          // Stop any playback so the mic does not pick up the assistant's voice.
          speech.stop();
          recognition.start();
        }
      }}
      className={cn(listening && 'animate-pulse bg-failure-bg/15 text-failure-bg')}
    >
      {processing ? <Spinner size={16} /> : <Icon name="mic" size="1rem" />}
    </IconButton>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    VoiceInputButton: typeof VoiceInputButton;
  }
}

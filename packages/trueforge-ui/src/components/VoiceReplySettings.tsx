'use client';

import { useState } from 'react';

import { isVoiceCaptureSupported } from '../atoms/lib/voiceRecorder.js';
import { Switch } from '../atoms/primitives/Switch.js';
import { isHotkeyId, PUSH_TO_TALK_HOTKEYS, usePushToTalkHotkey } from '../utils/pushToTalkHotkey.js';
import { useSpeechVoices } from '../utils/speechOutput.js';
import { readSpeechVoiceURI, useSpeakVoiceReplies, writeSpeechVoiceURI } from '../utils/speechReplyPreferences.js';
import { useSpokenReply } from './SpokenReplyContext.js';
import { useOptionalVoiceInput } from './VoiceInputContext.js';

const selectClassName =
  'w-full rounded-md border border-border/70 bg-secondary-bg px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus-visible:border-focus-ring focus-visible:ring-2 focus-visible:ring-focus-ring/50';

/** Read-aloud settings for voice conversations. Hidden when this browser cannot read text aloud. */
export function VoiceReplySettings() {
  const { enabled, setEnabled } = useSpeakVoiceReplies();
  const voices = useSpeechVoices();
  const spokenReply = useSpokenReply();
  const [voiceURI, setVoiceURI] = useState(() => readSpeechVoiceURI() ?? '');

  if (!spokenReply.canSpeak()) return null;

  return (
    <section className="mt-4 rounded-xl border border-border bg-card-bg p-4" aria-labelledby="voice-reply-heading">
      <h4 id="voice-reply-heading" className="text-sm font-semibold text-text-primary">
        Voice replies
      </h4>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p id="voice-reply-switch-label" className="text-sm font-medium text-text-primary">
            Speak replies when I use my voice
          </p>
          <p id="voice-reply-switch-hint" className="mt-1 text-xs leading-snug text-text-secondary">
            Only replies to messages you spoke are read aloud. Saved in this browser only.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={checked => {
            setEnabled(checked);
            if (!checked) spokenReply.stop();
          }}
          aria-labelledby="voice-reply-switch-label"
          aria-describedby="voice-reply-switch-hint"
        />
      </div>
      {voices.length > 0 && (
        <div className="mt-4">
          <label htmlFor="voice-reply-voice" className="mb-1.5 block text-sm font-medium text-text-primary">
            Voice
          </label>
          <select
            id="voice-reply-voice"
            className={selectClassName}
            value={voiceURI}
            onChange={event => {
              setVoiceURI(event.target.value);
              writeSpeechVoiceURI(event.target.value === '' ? null : event.target.value);
            }}
          >
            <option value="">Browser default</option>
            {voices.map(voice => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {`${voice.name} (${voice.lang})`}
              </option>
            ))}
          </select>
        </div>
      )}
    </section>
  );
}

/** Talking settings. Hidden when no voice input is wired or this browser cannot record. */
export function VoiceInputSettings() {
  const voiceInput = useOptionalVoiceInput();
  const { hotkeyId, setHotkeyId } = usePushToTalkHotkey();

  if (voiceInput == null || !isVoiceCaptureSupported()) return null;

  return (
    <section className="mt-4 rounded-xl border border-border bg-card-bg p-4" aria-labelledby="voice-input-heading">
      <h4 id="voice-input-heading" className="text-sm font-semibold text-text-primary">
        Talking to Aman
      </h4>
      <p className="mt-1 text-xs leading-snug text-text-secondary">
        Tap the mic to record, then check the words before you send. Or hold the mic, talk, and let go to send.
      </p>
      <div className="mt-4">
        <label htmlFor="push-to-talk-hotkey" className="mb-1.5 block text-sm font-medium text-text-primary">
          Hold-to-talk keys
        </label>
        <select
          id="push-to-talk-hotkey"
          aria-describedby="push-to-talk-hotkey-hint"
          className={selectClassName}
          value={hotkeyId}
          onChange={event => {
            if (isHotkeyId(event.target.value)) setHotkeyId(event.target.value);
          }}
        >
          <option value="off">Off</option>
          {PUSH_TO_TALK_HOTKEYS.map(hotkey => (
            <option key={hotkey.id} value={hotkey.id}>
              {hotkey.label}
            </option>
          ))}
        </select>
        <p id="push-to-talk-hotkey-hint" className="mt-1 text-xs leading-snug text-text-secondary">
          Hold these keys while you talk, and let go to send. Saved in this browser only.
        </p>
      </div>
    </section>
  );
}

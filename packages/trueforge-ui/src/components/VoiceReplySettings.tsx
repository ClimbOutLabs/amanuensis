'use client';

import { useState } from 'react';

import { Switch } from '../atoms/primitives/Switch.js';
import { isSpeechOutputSupported, useSpeechVoices } from '../utils/speechOutput.js';
import { readSpeechVoiceURI, useSpeakVoiceReplies, writeSpeechVoiceURI } from '../utils/speechReplyPreferences.js';

const selectClassName =
  'w-full rounded-md border border-border/70 bg-secondary-bg px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus-visible:border-focus-ring focus-visible:ring-2 focus-visible:ring-focus-ring/50';

/** Read-aloud settings for voice conversations. Hidden when this browser cannot read text aloud. */
export function VoiceReplySettings() {
  const { enabled, setEnabled } = useSpeakVoiceReplies();
  const voices = useSpeechVoices();
  const [voiceURI, setVoiceURI] = useState(() => readSpeechVoiceURI() ?? '');

  if (!isSpeechOutputSupported()) return null;

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
            Only replies to messages you spoke are read aloud. Stored on this computer.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
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

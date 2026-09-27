'use client';

import { useMemo, type ReactNode } from 'react';

import { PopoverSelect } from '@/atoms/primitives/PopoverSelect.js';
import { Switch } from '@/atoms/primitives/Switch.js';
import { useVoiceSettings } from '@/voice/VoiceSettingsContext.js';
import { useVoiceSpeech } from '@/voice/VoiceSpeechContext.js';

const PREVIEW_TEXT = 'Hello! This is how I will sound when reading messages aloud.';

function SettingCard({
  headingId,
  title,
  description,
  children,
}: {
  headingId: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border bg-card-bg p-4">
      <h4 id={headingId} className="text-sm font-medium text-text-primary">
        {title}
      </h4>
      <p className="mt-0.5 text-sm text-text-secondary">{description}</p>
      {children === undefined ? null : <div className="mt-4 flex flex-col gap-4">{children}</div>}
    </section>
  );
}

function SettingRow({
  label,
  description,
  control,
  labelId,
}: {
  label: string;
  description: string;
  control: ReactNode;
  labelId: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label id={labelId} className="text-sm font-medium text-text-primary">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-text-secondary">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function SliderRow({
  label,
  description,
  labelId,
  min,
  max,
  step,
  value,
  format,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  labelId: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <label id={labelId} htmlFor={`${labelId}-input`} className="text-sm font-medium text-text-primary">
            {label}
          </label>
          <p className="mt-0.5 text-xs text-text-secondary">{description}</p>
        </div>
        <span aria-hidden className="shrink-0 text-sm text-text-secondary">
          {format(value)}
        </span>
      </div>
      <input
        id={`${labelId}-input`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-labelledby={labelId}
        onChange={event => onChange(Number(event.target.value))}
        className="mt-2 w-full accent-[var(--primary-button-bg)] disabled:opacity-50"
      />
    </div>
  );
}

const VoiceSettings = () => {
  const { settings, updateSettings, speechRecognitionSupported, speechSynthesisSupported } = useVoiceSettings();
  const speech = useVoiceSpeech();

  const voiceOptions = useMemo(() => {
    const options = speech.voices.map(voice => ({
      value: voice.voiceURI,
      // Network voices synthesize on the vendor's servers; label them so the
      // choice is visible instead of silent.
      label: `${voice.name}${voice.lang ? ` (${voice.lang})` : ''}${voice.local ? '' : ' (network)'}`,
    }));
    options.sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: '', label: 'System default' }, ...options];
  }, [speech.voices]);

  const preview = () => {
    speech.speak({ id: 'voice-preview', text: PREVIEW_TEXT });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pb-1">
      <header>
        <h3 className="text-base font-semibold text-text-primary">Voice</h3>
        <p className="mt-1 text-sm text-text-secondary">
          Dictate messages and have replies read aloud. Dictation streams audio to your browser vendor&apos;s cloud
          speech service (Google&apos;s in Chrome and Edge, Apple&apos;s in Safari). Read-aloud stays on your device
          unless you pick a voice marked (network).
        </p>
      </header>

      <SettingCard
        headingId="voice-input-heading"
        title="Voice input"
        description="Dictate into the composer with the microphone button. Uses your browser's built-in speech recognition."
      >
        <SettingRow
          labelId="voice-input-toggle-label"
          label="Voice input"
          description="Show the microphone button in the composer."
          control={
            <Switch
              checked={settings.voiceInputEnabled}
              onCheckedChange={checked => updateSettings({ voiceInputEnabled: checked })}
              aria-labelledby="voice-input-toggle-label"
            />
          }
        />
        {!speechRecognitionSupported ? (
          <p className="text-xs text-text-secondary">
            Voice input is not supported in this browser. Dictation needs the Web Speech API, available in Chrome and
            Edge.
          </p>
        ) : null}
      </SettingCard>

      <SettingCard
        headingId="voice-tts-heading"
        title="Text to speech"
        description="Read assistant messages aloud with the speaker button on each message. Uses your browser's built-in voices."
      >
        <SettingRow
          labelId="voice-tts-toggle-label"
          label="Text to speech"
          description="Show the read-aloud button on assistant messages."
          control={
            <Switch
              checked={settings.ttsEnabled}
              onCheckedChange={checked => updateSettings({ ttsEnabled: checked })}
              aria-labelledby="voice-tts-toggle-label"
            />
          }
        />
        {!speechSynthesisSupported ? (
          <p className="text-xs text-text-secondary">
            Text to speech is not supported in this browser. Reading aloud needs the speechSynthesis API.
          </p>
        ) : (
          <>
            <div>
              <span id="voice-select-label" className="text-sm font-medium text-text-primary">
                Voice
              </span>
              <p className="mt-0.5 text-xs text-text-secondary">Which voice reads messages aloud.</p>
              <PopoverSelect
                aria-label="Voice"
                options={voiceOptions}
                value={settings.voiceURI ?? ''}
                onValueChange={value => updateSettings({ voiceURI: value === '' ? null : value })}
                disabled={!settings.ttsEnabled}
                className="mt-2 w-full max-w-sm"
                emptyContent="No voices found in this browser."
              />
            </div>
            <SliderRow
              labelId="voice-rate-label"
              label="Speech rate"
              description="How fast messages are read."
              min={0.5}
              max={2}
              step={0.1}
              value={settings.rate}
              format={value => `${value.toFixed(1)}x`}
              onChange={value => updateSettings({ rate: value })}
              disabled={!settings.ttsEnabled}
            />
            <SliderRow
              labelId="voice-pitch-label"
              label="Pitch"
              description="How high or low the voice sounds."
              min={0}
              max={2}
              step={0.1}
              value={settings.pitch}
              format={value => value.toFixed(1)}
              onChange={value => updateSettings({ pitch: value })}
              disabled={!settings.ttsEnabled}
            />
            <div>
              <button
                type="button"
                onClick={preview}
                disabled={!settings.ttsEnabled || !speech.supported}
                className="rounded-md border border-border bg-secondary-bg px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-ghost-button-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Preview voice
              </button>
            </div>
          </>
        )}
      </SettingCard>

      <SettingCard
        headingId="voice-handsfree-heading"
        title="Hands-free mode"
        description="A continuous conversation loop: replies are read aloud, then the mic reopens for your next turn. Toggle it in the header."
      >
        <SettingRow
          labelId="voice-autoread-toggle-label"
          label="Auto-read new messages"
          description="Automatically read new assistant messages aloud, even outside hands-free mode."
          control={
            <Switch
              checked={settings.autoRead}
              onCheckedChange={checked => updateSettings({ autoRead: checked })}
              aria-labelledby="voice-autoread-toggle-label"
              disabled={!settings.ttsEnabled}
            />
          }
        />
        <p className="text-xs text-text-secondary">
          Hands-free exits any time: click the microphone button or press Escape.
        </p>
      </SettingCard>
    </div>
  );
};

export default VoiceSettings;

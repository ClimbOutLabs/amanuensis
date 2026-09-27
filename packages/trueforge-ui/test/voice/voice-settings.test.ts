// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_VOICE_SETTINGS,
  readVoiceSettings,
  VOICE_SETTINGS_KEY,
  writeVoiceSettings,
  type VoiceSettings,
} from '@/voice/voiceSettings.js';

function setStored(value: string | null) {
  if (value === null) window.localStorage.removeItem(VOICE_SETTINGS_KEY);
  else window.localStorage.setItem(VOICE_SETTINGS_KEY, value);
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('readVoiceSettings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(readVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it('returns stored values merged over defaults', () => {
    setStored(JSON.stringify({ voiceInputEnabled: false, rate: 1.5 }));
    const settings = readVoiceSettings();
    expect(settings.voiceInputEnabled).toBe(false);
    expect(settings.rate).toBe(1.5);
    expect(settings.ttsEnabled).toBe(DEFAULT_VOICE_SETTINGS.ttsEnabled);
  });

  it('falls back to defaults when stored JSON is corrupt', () => {
    setStored('{not json');
    expect(readVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it('falls back to defaults for non-object payloads', () => {
    setStored(JSON.stringify([1, 2, 3]));
    expect(readVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it('sanitizes wrong-type values and drops unknown fields', () => {
    setStored(
      JSON.stringify({
        voiceInputEnabled: 'yes',
        autoRead: 1,
        voiceURI: 42,
        extraField: 'dropped',
      }),
    );
    const settings = readVoiceSettings();
    expect(settings.voiceInputEnabled).toBe(DEFAULT_VOICE_SETTINGS.voiceInputEnabled);
    expect(settings.autoRead).toBe(DEFAULT_VOICE_SETTINGS.autoRead);
    expect(settings.voiceURI).toBe(DEFAULT_VOICE_SETTINGS.voiceURI);
    expect('extraField' in settings).toBe(false);
  });

  it('clamps out-of-range rate/pitch into their bounds', () => {
    setStored(JSON.stringify({ rate: 99, pitch: -3 }));
    const settings = readVoiceSettings();
    expect(settings.rate).toBe(2);
    expect(settings.pitch).toBe(0);
  });

  it('accepts boundary rate/pitch values', () => {
    setStored(JSON.stringify({ rate: 0.5, pitch: 2 }));
    const settings = readVoiceSettings();
    expect(settings.rate).toBe(0.5);
    expect(settings.pitch).toBe(2);
  });
});

describe('writeVoiceSettings', () => {
  it('persists the full settings object and reads it back', () => {
    const next: VoiceSettings = {
      ...DEFAULT_VOICE_SETTINGS,
      voiceURI: 'test-voice',
      rate: 1.2,
    };
    expect(writeVoiceSettings(next)).toBe(true);
    expect(window.localStorage.getItem(VOICE_SETTINGS_KEY)).toBe(JSON.stringify(next));
    expect(readVoiceSettings()).toEqual(next);
  });

  it('returns false when the store throws', () => {
    vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(writeVoiceSettings(DEFAULT_VOICE_SETTINGS)).toBe(false);
  });
});

// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { HandsFreeProvider, useHandsFree } from '@/voice/HandsFreeContext.js';
import { VoiceSettingsProvider, useVoiceSettings } from '@/voice/VoiceSettingsContext.js';
import { DEFAULT_VOICE_SETTINGS, VOICE_SETTINGS_KEY } from '@/voice/voiceSettings.js';

describe('VoiceSettingsProvider', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts from defaults when nothing is stored', () => {
    const { result } = renderHook(() => useVoiceSettings(), { wrapper: VoiceSettingsProvider });
    expect(result.current.settings).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(result.current.speechRecognitionSupported).toBe(false);
    expect(result.current.speechSynthesisSupported).toBe(false);
  });

  it('persists updates to localStorage', () => {
    const { result } = renderHook(() => useVoiceSettings(), { wrapper: VoiceSettingsProvider });

    act(() => {
      result.current.updateSettings({ rate: 1.5, autoRead: true });
    });

    expect(result.current.settings.rate).toBe(1.5);
    expect(result.current.settings.autoRead).toBe(true);
    const stored = JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored.rate).toBe(1.5);
    expect(stored.autoRead).toBe(true);
  });

  it('restores stored settings across mounts', () => {
    localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify({ ttsEnabled: false, rate: 0.5 }));
    const { result } = renderHook(() => useVoiceSettings(), { wrapper: VoiceSettingsProvider });
    expect(result.current.settings.ttsEnabled).toBe(false);
    expect(result.current.settings.rate).toBe(0.5);
    // Unset fields fall back to defaults rather than undefined.
    expect(result.current.settings.pitch).toBe(DEFAULT_VOICE_SETTINGS.pitch);
  });
});

describe('HandsFreeProvider', () => {
  it('toggles active state', () => {
    const { result } = renderHook(() => useHandsFree(), { wrapper: HandsFreeProvider });
    expect(result.current.active).toBe(false);

    act(() => {
      result.current.setActive(true);
    });
    expect(result.current.active).toBe(true);

    act(() => {
      result.current.setActive(false);
    });
    expect(result.current.active).toBe(false);
  });
});

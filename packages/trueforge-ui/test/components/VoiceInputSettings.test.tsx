// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { captureSupported } = vi.hoisted(() => ({ captureSupported: { value: true } }));

vi.mock('@/atoms/lib/voiceRecorder.js', () => ({
  isVoiceCaptureSupported: () => captureSupported.value,
}));

import { VoiceInputProvider, type VoiceInputApi } from '@/components/VoiceInputContext.js';
import { VoiceInputSettings } from '@/components/VoiceReplySettings.js';
import { PUSH_TO_TALK_HOTKEY_STORAGE_KEY } from '@/utils/pushToTalkHotkey.js';

const api: VoiceInputApi = {
  subscribeAvailability: listener => {
    listener(true);
    return () => {};
  },
  transcribe: async () => ({ text: '', language: 'en', duration_ms: 0, model: 'm' }),
};

describe('VoiceInputSettings', () => {
  afterEach(() => {
    captureSupported.value = true;
    window.localStorage.clear();
  });

  it('defaults the hold-to-talk keys and stores the one the person picks', () => {
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputSettings />
      </VoiceInputProvider>,
    );

    const picker = screen.getByLabelText('Hold-to-talk keys');
    expect(picker).toHaveValue('ctrl-shift-space');

    fireEvent.change(picker, { target: { value: 'off' } });

    expect(picker).toHaveValue('off');
    expect(window.localStorage.getItem(PUSH_TO_TALK_HOTKEY_STORAGE_KEY)).toBe('off');
  });

  it('is hidden without voice input or a way to record', () => {
    const { container, rerender } = render(<VoiceInputSettings />);
    expect(container).toBeEmptyDOMElement();

    captureSupported.value = false;
    rerender(
      <VoiceInputProvider api={api}>
        <VoiceInputSettings />
      </VoiceInputProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

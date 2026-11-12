// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { captureSupported } = vi.hoisted(() => ({ captureSupported: { value: true } }));

vi.mock('@/atoms/lib/voiceRecorder.js', () => ({
  isVoiceCaptureSupported: () => captureSupported.value,
}));

import { SpokenReplyProvider } from '@/components/SpokenReplyContext.js';
import { VoiceInputProvider, type VoiceInputApi } from '@/components/VoiceInputContext.js';
import { VoiceInputSettings, VoiceReplySettings } from '@/components/VoiceReplySettings.js';
import { PUSH_TO_TALK_HOTKEY_STORAGE_KEY } from '@/utils/pushToTalkHotkey.js';
import {
  SERVER_VOICE_STORAGE_KEY,
  SPEAK_VOICE_REPLIES_STORAGE_KEY,
  SPEECH_VOICE_STORAGE_KEY,
} from '@/utils/speechReplyPreferences.js';
import type { ServerVoiceApi } from '@/utils/spokenReplyPlayer.js';
import { installSpeechSynthesis, makeVoice, removeSpeechSynthesis } from '../utils/speechSynthesisFake.js';

describe('VoiceReplySettings', () => {
  beforeEach(() => {
    installSpeechSynthesis({
      voices: [
        makeVoice({ voiceURI: 'voice-a', name: 'Alto', lang: 'en-US' }),
        makeVoice({ voiceURI: 'voice-b', name: 'Bass', lang: 'en-GB' }),
      ],
    });
  });

  afterEach(() => {
    removeSpeechSynthesis();
    window.localStorage.clear();
  });

  it('turns voice replies on by default and stores a switch-off in this browser', () => {
    render(<VoiceReplySettings />);

    const toggle = screen.getByRole('switch', { name: 'Speak replies when I use my voice' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(window.localStorage.getItem(SPEAK_VOICE_REPLIES_STORAGE_KEY)).toBe('false');
  });

  it('lists the browser voices and stores the one the person picks', () => {
    render(<VoiceReplySettings />);

    const picker = screen.getByLabelText('Voice');
    expect(screen.getByRole('option', { name: 'Browser default' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Bass (en-GB)' })).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: 'voice-b' } });

    expect(window.localStorage.getItem(SPEECH_VOICE_STORAGE_KEY)).toBe('voice-b');
  });

  it('shows nothing when the browser cannot read text aloud', () => {
    removeSpeechSynthesis();

    const { container } = render(<VoiceReplySettings />);

    expect(container).toBeEmptyDOMElement();
  });

  it('offers the computer voices when that voice is wired, and plays a sample of the one picked', () => {
    const speak = vi.fn<ServerVoiceApi['speak']>(() => new Promise<Blob>(() => {}));
    render(
      <SpokenReplyProvider serverVoice={{ speak }}>
        <VoiceReplySettings />
      </SpokenReplyProvider>,
    );

    const picker = screen.getByLabelText('Voice');
    expect(picker).toHaveValue('af_heart');
    expect(screen.getAllByRole('option', { name: /, a (woman|man)/ })).toHaveLength(6);
    expect(screen.getByLabelText('Backup voice')).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: 'am_fenrir' } });

    expect(window.localStorage.getItem(SERVER_VOICE_STORAGE_KEY)).toBe('am_fenrir');
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ voice: 'am_fenrir' }));
  });

  it('shows only the browser voices when no computer voice is wired', () => {
    render(<VoiceReplySettings />);

    expect(screen.queryByRole('option', { name: /, a (woman|man)/ })).toBeNull();
    expect(screen.queryByLabelText('Backup voice')).toBeNull();
  });
});

const api: VoiceInputApi = {
  subscribeAvailability: listener => {
    listener(true);
    return () => {};
  },
  transcribe: async () => ({ text: '', language: 'en', duration_ms: 0, model: 'm' }),
  connect: async () => ({ url: 'wss://aman.test/stream', protocols: [] }),
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

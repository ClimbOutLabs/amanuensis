// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VoiceReplySettings } from '@/components/VoiceReplySettings.js';
import { SPEAK_VOICE_REPLIES_STORAGE_KEY, SPEECH_VOICE_STORAGE_KEY } from '@/utils/speechReplyPreferences.js';
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
});

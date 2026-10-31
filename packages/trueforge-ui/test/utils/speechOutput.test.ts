// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSpeechOutputSupported, pickOnDeviceVoice } from '@/utils/speechOutput.js';
import { installSpeechSynthesis, makeVoice, removeSpeechSynthesis } from '../utils/speechSynthesisFake.js';

describe('speech output voices', () => {
  beforeEach(() => {
    installSpeechSynthesis();
  });

  afterEach(() => {
    removeSpeechSynthesis();
  });

  it('reports support only when the browser has speech synthesis', () => {
    expect(isSpeechOutputSupported()).toBe(true);
    removeSpeechSynthesis();
    expect(isSpeechOutputSupported()).toBe(false);
  });

  it('picks the voice the person chose, and the browser default when that voice is gone', () => {
    const chosen = makeVoice({ voiceURI: 'voice-b', name: 'Voice B', lang: 'en-GB' });
    const fallback = makeVoice({ voiceURI: 'voice-a', default: true });
    installSpeechSynthesis({ voices: [fallback, chosen] });

    expect(pickOnDeviceVoice('voice-b')).toBe(chosen);
    expect(pickOnDeviceVoice('removed-voice')).toBe(fallback);
    expect(pickOnDeviceVoice(null)).toBe(fallback);
  });

  it('never picks a voice that sends the text to a server', () => {
    const network = makeVoice({ voiceURI: 'network-voice', localService: false, default: true });
    installSpeechSynthesis({ voices: [network] });

    expect(pickOnDeviceVoice('network-voice')).toBeUndefined();
  });

  it('uses an on-device voice even when the picked voice is a network one', () => {
    const local = makeVoice({ voiceURI: 'local-voice' });
    installSpeechSynthesis({ voices: [makeVoice({ voiceURI: 'network-voice', localService: false }), local] });

    expect(pickOnDeviceVoice('network-voice')).toBe(local);
  });

  it('picks nothing without speech synthesis', () => {
    removeSpeechSynthesis();
    expect(pickOnDeviceVoice(null)).toBeUndefined();
  });
});

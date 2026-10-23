// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSpeechOutputSupported, speakText, stopSpeaking, useSpeakingKey } from '@/utils/speechOutput.js';
import {
  installSpeechSynthesis,
  makeVoice,
  removeSpeechSynthesis,
  type FakeSpeechSynthesis,
  type FakeUtterance,
} from '../utils/speechSynthesisFake.js';

describe('speech output', () => {
  let synthesis: FakeSpeechSynthesis;

  beforeEach(() => {
    synthesis = installSpeechSynthesis();
  });

  afterEach(() => {
    stopSpeaking();
    removeSpeechSynthesis();
  });

  it('reports support only when the browser has speech synthesis', () => {
    expect(isSpeechOutputSupported()).toBe(true);
    removeSpeechSynthesis();
    expect(isSpeechOutputSupported()).toBe(false);
  });

  it('speaks with the voice the person picked, and the browser default when that voice is gone', () => {
    const voice = makeVoice({ voiceURI: 'voice-b', name: 'Voice B', lang: 'en-GB' });
    const fallback = makeVoice({ voiceURI: 'voice-a', default: true });
    const voiced = installSpeechSynthesis({ voices: [fallback, voice] });

    speakText({ key: 'msg-1', text: '  Hello there.  ', voiceURI: 'voice-b' });
    const picked = voiced.speak.mock.lastCall?.[0];
    expect(picked?.text).toBe('Hello there.');
    expect(picked?.voice).toBe(voice);
    expect(picked?.lang).toBe('en-GB');

    speakText({ key: 'msg-2', text: 'Fallback.', voiceURI: 'removed-voice' });
    expect(voiced.speak.mock.lastCall?.[0].voice).toBe(fallback);
  });

  it('never speaks with a voice that sends the text to a server', () => {
    const network = makeVoice({ voiceURI: 'network-voice', localService: false, default: true });
    const voiced = installSpeechSynthesis({ voices: [network] });

    speakText({ key: 'msg-1', text: 'Private words.', voiceURI: 'network-voice' });

    expect(voiced.speak).not.toHaveBeenCalled();
  });

  it('uses an on-device voice even when the picked voice is a network one', () => {
    const local = makeVoice({ voiceURI: 'local-voice' });
    const voiced = installSpeechSynthesis({
      voices: [makeVoice({ voiceURI: 'network-voice', localService: false }), local],
    });

    speakText({ key: 'msg-1', text: 'Hello.', voiceURI: 'network-voice' });

    expect(voiced.speak.mock.lastCall?.[0].voice).toBe(local);
  });

  it('cancels the reply in progress before starting another', () => {
    speakText({ key: 'msg-1', text: 'First.' });
    speakText({ key: 'msg-2', text: 'Second.' });

    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
    expect(synthesis.speak).toHaveBeenCalledTimes(2);
  });

  it('stops speaking when asked and does nothing when nothing is spoken', () => {
    speakText({ key: 'msg-1', text: 'Long answer.' });
    stopSpeaking();

    expect(synthesis.cancel).toHaveBeenLastCalledWith();
    expect(() => {
      stopSpeaking();
    }).not.toThrow();
  });

  it('ignores an end event from a reply that was already replaced', () => {
    const { result } = renderHook(() => useSpeakingKey());
    act(() => {
      speakText({ key: 'msg-1', text: 'First.' });
    });
    const first: FakeUtterance | undefined = synthesis.speak.mock.calls[0]?.[0];
    act(() => {
      speakText({ key: 'msg-2', text: 'Second.' });
    });

    act(() => {
      first?.onend?.();
    });

    expect(result.current).toBe('msg-2');
  });

  it('does nothing for blank text or without speech synthesis', () => {
    speakText({ key: 'msg-1', text: '   ' });
    expect(synthesis.speak).not.toHaveBeenCalled();

    removeSpeechSynthesis();
    expect(() => {
      speakText({ key: 'msg-1', text: 'Hello.' });
    }).not.toThrow();
  });
});

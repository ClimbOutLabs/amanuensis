// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSpeechOutputSupported, speakText, stopSpeaking } from '@/utils/speechOutput.js';
import {
  armSpokenReply,
  clearDraftFromVoice,
  markDraftFromVoice,
  takeDraftFromVoice,
  takeSpokenReply,
} from '@/utils/voiceTurn.js';
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
    const voiced = installSpeechSynthesis({ voices: [makeVoice({ voiceURI: 'voice-a' }), voice] });

    speakText({ key: 'msg-1', text: '  Hello there.  ', voiceURI: 'voice-b' });
    const picked = voiced.speak.mock.lastCall?.[0];
    expect(picked?.text).toBe('Hello there.');
    expect(picked?.voice).toBe(voice);
    expect(picked?.lang).toBe('en-GB');

    speakText({ key: 'msg-2', text: 'Fallback.', voiceURI: 'removed-voice' });
    expect(voiced.speak.mock.lastCall?.[0].voice).toBe(null);
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
    speakText({ key: 'msg-1', text: 'First.' });
    const first: FakeUtterance | undefined = synthesis.speak.mock.calls[0]?.[0];
    speakText({ key: 'msg-2', text: 'Second.' });

    first?.onend?.();

    expect(synthesis.speak).toHaveBeenCalledTimes(2);
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

describe('voice turn tracking', () => {
  afterEach(() => {
    clearDraftFromVoice();
    armSpokenReply(false);
  });

  it('marks a draft from voice once, and taking it resets the mark', () => {
    markDraftFromVoice();

    expect(takeDraftFromVoice()).toBe(true);
    expect(takeDraftFromVoice()).toBe(false);
  });

  it('clears the voice mark when the composer is emptied', () => {
    markDraftFromVoice();
    clearDraftFromVoice();

    expect(takeDraftFromVoice()).toBe(false);
  });

  it('arms the reply for one finished turn, and a typed send disarms it', () => {
    armSpokenReply(true);
    expect(takeSpokenReply()).toBe(true);
    expect(takeSpokenReply()).toBe(false);

    armSpokenReply(true);
    armSpokenReply(false);
    expect(takeSpokenReply()).toBe(false);
  });
});

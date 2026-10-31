// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SPEECH_VOICE_STORAGE_KEY } from '@/utils/speechReplyPreferences.js';
import { createSpokenReplyPlayer } from '@/utils/spokenReplyPlayer.js';
import {
  installSpeechSynthesis,
  makeVoice,
  removeSpeechSynthesis,
  type FakeSpeechSynthesis,
} from './speechSynthesisFake.js';

function lastUtterance(synthesis: FakeSpeechSynthesis) {
  const utterance = synthesis.speak.mock.lastCall?.[0];
  if (utterance === undefined) throw new Error('nothing was spoken');
  return utterance;
}

describe('spoken reply player with the browser voice', () => {
  afterEach(() => {
    removeSpeechSynthesis();
    window.localStorage.clear();
  });

  it('reads with the voice the person picked, and the default when that voice is gone', async () => {
    const picked = makeVoice({ voiceURI: 'voice-b', lang: 'en-GB' });
    const fallback = makeVoice({ voiceURI: 'voice-a', default: true });
    const synthesis = installSpeechSynthesis({ voices: [fallback, picked] });
    const player = createSpokenReplyPlayer({ serverVoice: null });

    window.localStorage.setItem(SPEECH_VOICE_STORAGE_KEY, 'voice-b');
    const first = player.speak('Hello there.');
    expect(lastUtterance(synthesis).voice).toBe(picked);
    expect(lastUtterance(synthesis).lang).toBe('en-GB');
    lastUtterance(synthesis).finish();
    await expect(first).resolves.toBe('browser');

    window.localStorage.setItem(SPEECH_VOICE_STORAGE_KEY, 'removed-voice');
    const second = player.speak('Again.');
    expect(lastUtterance(synthesis).voice).toBe(fallback);
    lastUtterance(synthesis).finish();
    await second;
  });

  it('never reads with a voice that sends the text to a server', async () => {
    const synthesis = installSpeechSynthesis({
      voices: [makeVoice({ voiceURI: 'network-voice', localService: false, default: true })],
    });
    const player = createSpokenReplyPlayer({ serverVoice: null });

    await player.speak('Private words.');

    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it('checks for browser speech on every call', async () => {
    const player = createSpokenReplyPlayer({ serverVoice: null });
    expect(player.canSpeak()).toBe(false);
    await expect(player.speak('Nobody hears this.')).resolves.toBe('none');

    installSpeechSynthesis();
    expect(player.canSpeak()).toBe(true);
  });

  it('cancels the browser voice on stop and ignores blank text', async () => {
    const synthesis = installSpeechSynthesis();
    const player = createSpokenReplyPlayer({ serverVoice: null });

    const reading = player.speak('A long answer.');
    player.stop();
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    lastUtterance(synthesis).finish();
    await reading;

    synthesis.speak.mockClear();
    await expect(player.speak('   ')).resolves.toBe('none');
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it('tells listeners what is being read, and keeps a replaced reply from clearing it', async () => {
    const synthesis = installSpeechSynthesis();
    const player = createSpokenReplyPlayer({ serverVoice: null });
    const changes = vi.fn();
    player.subscribe(changes);

    const first = player.speak('First.', { key: 'msg-1' });
    expect(player.speakingKey()).toBe('msg-1');
    const firstUtterance = lastUtterance(synthesis);
    const second = player.speak('Second.', { key: 'msg-2' });
    expect(player.speakingKey()).toBe('msg-2');

    firstUtterance.finish();
    await first;
    expect(player.speakingKey()).toBe('msg-2');

    lastUtterance(synthesis).finish();
    await second;
    expect(player.speakingKey()).toBeNull();
    expect(changes).toHaveBeenCalled();
  });
});

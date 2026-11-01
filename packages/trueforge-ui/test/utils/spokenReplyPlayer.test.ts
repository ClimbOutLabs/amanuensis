import { afterEach, describe, expect, it, vi } from 'vitest';

import { SERVER_VOICE_STORAGE_KEY } from '../../src/utils/speechReplyPreferences';
import {
  SERVER_VOICE_RETRY_MS,
  createSpokenReplyPlayer,
  splitForSpeech,
  type ServerVoiceApi,
} from '../../src/utils/spokenReplyPlayer';

function serverVoice(
  behavior: (text: string) => Promise<Blob>,
): ServerVoiceApi & { texts: string[]; voices: string[] } {
  const texts: string[] = [];
  const voices: string[] = [];
  return {
    texts,
    voices,
    speak: ({ text, voice }) => {
      texts.push(text);
      voices.push(voice);
      return behavior(text);
    },
  };
}

// jsdom's Blob cannot be read back, so each clip remembers the text it stands for.
const clipText = new WeakMap<Blob, string>();
const wav = (text: string) => {
  const blob = new Blob([text], { type: 'audio/wav' });
  clipText.set(blob, text);
  return blob;
};

describe('createSpokenReplyPlayer', () => {
  afterEach(() => {
    window.localStorage.removeItem(SERVER_VOICE_STORAGE_KEY);
  });

  it('reads with the computer voice the person picked, the default until then', async () => {
    const server = serverVoice(text => Promise.resolve(wav(text)));
    const player = createSpokenReplyPlayer({ serverVoice: server, playAudio: () => Promise.resolve() });

    await player.speak('Hello.');
    window.localStorage.setItem(SERVER_VOICE_STORAGE_KEY, 'am_fenrir');
    await player.speak('Hello again.');
    window.localStorage.setItem(SERVER_VOICE_STORAGE_KEY, 'not_a_voice');
    await player.speak('And again.');

    expect(server.voices).toEqual(['af_heart', 'am_fenrir', 'af_heart']);
  });

  it('prefers the server voice when it answers', async () => {
    const server = serverVoice(text => Promise.resolve(wav(text)));
    const played: string[] = [];
    const browserSpeak = vi.fn(() => Promise.resolve());
    const player = createSpokenReplyPlayer({
      serverVoice: server,
      playAudio: audio => {
        played.push(clipText.get(audio) ?? '');
        return Promise.resolve();
      },
      browserSpeak,
    });

    await expect(player.speak('Hello there. How are you?')).resolves.toBe('server');

    expect(server.texts).toEqual(['Hello there. How are you?']);
    expect(played).toEqual(['Hello there. How are you?']);
    expect(browserSpeak).not.toHaveBeenCalled();
  });

  it('falls back to the browser voice when the server voice is down', async () => {
    const server = serverVoice(() => Promise.reject(new Error('503')));
    const browserSpeak = vi.fn((_text: string, _signal: AbortSignal) => Promise.resolve());
    const playAudio = vi.fn(() => Promise.resolve());
    const player = createSpokenReplyPlayer({ serverVoice: server, playAudio, browserSpeak });

    await expect(player.speak('Hello there.')).resolves.toBe('browser');

    expect(browserSpeak).toHaveBeenCalledWith('Hello there.', expect.any(AbortSignal));
    expect(playAudio).not.toHaveBeenCalled();
  });

  it('skips the server voice for a minute after it fails, then tries it again', async () => {
    let now = 0;
    const server = serverVoice(() => Promise.reject(new Error('503')));
    const browserSpeak = vi.fn(() => Promise.resolve());
    const player = createSpokenReplyPlayer({
      serverVoice: server,
      playAudio: () => Promise.resolve(),
      browserSpeak,
      now: () => now,
    });

    await player.speak('One.');
    await player.speak('Two.');
    expect(server.texts).toEqual(['One.']);

    now = SERVER_VOICE_RETRY_MS;
    await player.speak('Three.');
    expect(server.texts).toEqual(['One.', 'Three.']);
    expect(browserSpeak).toHaveBeenCalledTimes(3);
  });

  it('reads the rest with the browser when the server voice fails part way', async () => {
    const long = `${'a'.repeat(1000)}. ${'b'.repeat(1000)}. ${'c'.repeat(1000)}.`;
    const server = serverVoice(text =>
      text.startsWith('a') ? Promise.resolve(wav(text)) : Promise.reject(new Error('x')),
    );
    const played: string[] = [];
    const browserSpeak = vi.fn((_text: string, _signal: AbortSignal) => Promise.resolve());
    const player = createSpokenReplyPlayer({
      serverVoice: server,
      playAudio: audio => {
        played.push((clipText.get(audio) ?? '').slice(0, 1));
        return Promise.resolve();
      },
      browserSpeak,
    });

    await expect(player.speak(long)).resolves.toBe('server');

    expect(played).toEqual(['a']);
    expect(browserSpeak).toHaveBeenCalledWith(`${'b'.repeat(1000)}. ${'c'.repeat(1000)}.`, expect.any(AbortSignal));
  });

  it('falls back when the browser refuses to play the clip', async () => {
    const server = serverVoice(text => Promise.resolve(wav(text)));
    const browserSpeak = vi.fn((_text: string, _signal: AbortSignal) => Promise.resolve());
    const player = createSpokenReplyPlayer({
      serverVoice: server,
      playAudio: () => Promise.reject(new Error('autoplay blocked')),
      browserSpeak,
    });

    await expect(player.speak('Hi.')).resolves.toBe('browser');
    expect(browserSpeak).toHaveBeenCalledWith('Hi.', expect.any(AbortSignal));
  });

  it('uses only the browser voice without a server voice, and nothing when the browser has none', async () => {
    const browserSpeak = vi.fn(() => Promise.resolve());
    await expect(createSpokenReplyPlayer({ serverVoice: null, browserSpeak }).speak('Hi.')).resolves.toBe('browser');
    await expect(createSpokenReplyPlayer({ serverVoice: null, browserSpeak: null }).speak('Hi.')).resolves.toBe('none');
  });

  it('stops the current reply when asked, and when a new one starts', async () => {
    const signals: AbortSignal[] = [];
    const server = serverVoice(text => Promise.resolve(wav(text)));
    const player = createSpokenReplyPlayer({
      serverVoice: server,
      playAudio: (_audio, signal) => {
        signals.push(signal);
        return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      browserSpeak: null,
    });

    const first = player.speak('First.');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const second = player.speak('Second.');
    await expect(first).resolves.toBe('server');
    expect(signals[0]?.aborted).toBe(true);

    await vi.waitFor(() => expect(signals).toHaveLength(2));
    player.stop();
    await expect(second).resolves.toBe('server');
    expect(signals[1]?.aborted).toBe(true);
  });
});

describe('splitForSpeech', () => {
  it('packs sentences up to the limit', () => {
    expect(splitForSpeech('One. Two. Three.', 10)).toEqual(['One. Two.', 'Three.']);
  });

  it('splits an overlong sentence between words, and an overlong word by length', () => {
    expect(splitForSpeech('aaaa bbbb cccc', 9)).toEqual(['aaaa bbbb', 'cccc']);
    expect(splitForSpeech('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('returns nothing for blank text', () => {
    expect(splitForSpeech('   ')).toEqual([]);
  });
});

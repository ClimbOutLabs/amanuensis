import { pickOnDeviceVoice } from './speechOutput.js';
import { readSpeechVoiceURI } from './speechReplyPreferences.js';

/** Host port for the voice running on the person's own computer (`POST /api/v1/voice/speak`). */
export type ServerVoiceApi = {
  /** Resolves with WAV audio for the text; rejects when the voice is off, busy or the request fails. */
  speak: (input: { text: string; signal?: AbortSignal }) => Promise<Blob>;
};

/** Which voice read the reply: the computer's own, the browser's built-in one, or none at all. */
export type SpokenReplyVoice = 'server' | 'browser' | 'none';

export type SpokenReplyPlayer = {
  /** Reads the text aloud and resolves when it finishes or is stopped. The key names what is being read, such as a message id. */
  speak: (text: string, options?: { key?: string }) => Promise<SpokenReplyVoice>;
  /** Stops whatever is being read. */
  stop: () => void;
  /** False when neither the computer's voice nor the browser's voice can read aloud. */
  canSpeak: () => boolean;
  /** The key of what is being read right now, or null. */
  speakingKey: () => string | null;
  /** Calls the listener whenever `speakingKey` changes; returns a function that stops listening. */
  subscribe: (listener: () => void) => () => void;
};

export type SpokenReplyPlayerDeps = {
  serverVoice: ServerVoiceApi | null;
  /** Plays one audio clip; resolves when it ends or the signal aborts. */
  playAudio?: (audio: Blob, signal: AbortSignal) => Promise<void>;
  /** Reads text with the browser's voice; resolves when it ends or the signal aborts. Null when the browser has none. */
  browserSpeak?: ((text: string, signal: AbortSignal) => Promise<void>) | null;
  now?: () => number;
};

/** Kept well under the server's 4000 character cap, so the first clip arrives quickly. */
export const SERVER_VOICE_CHUNK_CHARS = 1200;
/** After the server voice fails, the browser voice is used for this long before trying it again. */
export const SERVER_VOICE_RETRY_MS = 60_000;

/** Splits text at sentence ends into pieces of at most `limit` characters; overlong sentences split between words. */
export function splitForSpeech(text: string, limit: number = SERVER_VOICE_CHUNK_CHARS): string[] {
  const pieces: string[] = [];
  let current = '';
  const push = (part: string) => {
    if (current !== '' && current.length + 1 + part.length > limit) {
      pieces.push(current);
      current = part;
    } else {
      current = current === '' ? part : `${current} ${part}`;
    }
  };
  for (const sentence of text.trim().split(/(?<=[.!?])\s+/)) {
    if (sentence.length <= limit) {
      push(sentence);
      continue;
    }
    for (let word of sentence.split(/\s+/)) {
      while (word.length > limit) {
        push(word.slice(0, limit));
        word = word.slice(limit);
      }
      push(word);
    }
  }
  if (current !== '') {
    pieces.push(current);
  }
  return pieces;
}

function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
    } else {
      signal.addEventListener('abort', () => resolve(), { once: true });
    }
  });
}

/** Plays a clip through an `<audio>` element. */
export async function playAudioElement(audio: Blob, signal: AbortSignal): Promise<void> {
  const url = URL.createObjectURL(audio);
  const element = new Audio(url);
  try {
    const ended = new Promise<void>((resolve, reject) => {
      element.addEventListener('ended', () => resolve(), { once: true });
      element.addEventListener('error', () => reject(new Error('The reply audio could not be played.')), {
        once: true,
      });
    });
    await element.play();
    await Promise.race([ended, abortPromise(signal)]);
  } finally {
    element.pause();
    URL.revokeObjectURL(url);
  }
}

/**
 * The browser's built-in voice, or null when this browser has none. Only voices that run on this device are used,
 * because some browsers offer voices that send the text to a server. With no such voice it stays silent.
 */
export function browserSpeechSynthesis(): ((text: string, signal: AbortSignal) => Promise<void>) | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return null;
  }
  const synth = window.speechSynthesis;
  return async (text, signal) => {
    const voice = pickOnDeviceVoice(readSpeechVoiceURI());
    if (voice === undefined) {
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    const done = new Promise<void>(resolve => {
      utterance.addEventListener('end', () => resolve(), { once: true });
      utterance.addEventListener('error', () => resolve(), { once: true });
    });
    const cancel = () => synth.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    synth.speak(utterance);
    try {
      await done;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };
}

/**
 * Reads replies with the computer's own voice when it answers, and with the browser's voice otherwise. The text is
 * sent in sentence-sized pieces, and the next piece is fetched while the current one plays. If the computer's voice
 * fails, the rest of the reply is read by the browser, which keeps reading replies for a minute before the computer's
 * voice is tried again. A new `speak` stops the one before it.
 */
export function createSpokenReplyPlayer(deps: SpokenReplyPlayerDeps): SpokenReplyPlayer {
  const playAudio = deps.playAudio ?? playAudioElement;
  // Checked on every use: a browser can gain or lose speech synthesis after the player is made.
  const currentBrowserSpeak = () => (deps.browserSpeak === undefined ? browserSpeechSynthesis() : deps.browserSpeak);
  const now = deps.now ?? Date.now;
  let serverDownUntil = 0;
  let active: AbortController | null = null;
  let currentKey: string | null = null;
  let runId = 0;
  const listeners = new Set<() => void>();
  const setKey = (next: string | null) => {
    if (currentKey === next) {
      return;
    }
    currentKey = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const readWithBrowser = async (text: string, signal: AbortSignal): Promise<SpokenReplyVoice> => {
    const browserSpeak = currentBrowserSpeak();
    if (browserSpeak === null || text.trim() === '') {
      return 'none';
    }
    await browserSpeak(text, signal);
    return 'browser';
  };

  const stop = () => {
    runId += 1;
    active?.abort();
    active = null;
    setKey(null);
  };

  const speakPieces = async (text: string, controller: AbortController): Promise<SpokenReplyVoice> => {
    const { signal } = controller;
    const pieces = splitForSpeech(text);
    const server = deps.serverVoice;
    if (server === null || now() < serverDownUntil || pieces.length === 0) {
      return readWithBrowser(text, signal);
    }
    const fetchPiece = (index: number): Promise<Blob> => {
      const piece = pieces[index];
      return piece === undefined ? Promise.reject(new Error('no such piece')) : server.speak({ text: piece, signal });
    };
    let next = fetchPiece(0);
    // Rejections of a prefetch are read when its turn comes; until then they must not surface as unhandled.
    next.catch(() => undefined);
    for (let index = 0; index < pieces.length; index += 1) {
      let audio: Blob;
      try {
        audio = await next;
      } catch {
        if (signal.aborted) {
          return index === 0 ? 'none' : 'server';
        }
        serverDownUntil = now() + SERVER_VOICE_RETRY_MS;
        const rest = pieces.slice(index).join(' ');
        const voice = await readWithBrowser(rest, signal);
        return index === 0 ? voice : 'server';
      }
      if (index + 1 < pieces.length) {
        next = fetchPiece(index + 1);
        next.catch(() => undefined);
      }
      try {
        await playAudio(audio, signal);
      } catch {
        // The browser refused to play the clip (for example autoplay rules); its own voice may still work.
        controller.abort();
        const fallback = new AbortController();
        active = fallback;
        const voice = await readWithBrowser(pieces.slice(index).join(' '), fallback.signal);
        return index === 0 ? voice : 'server';
      }
      if (signal.aborted) {
        return 'server';
      }
    }
    return 'server';
  };

  return {
    stop,
    canSpeak: () => deps.serverVoice !== null || currentBrowserSpeak() !== null,
    speakingKey: () => currentKey,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async speak(text: string, options?: { key?: string }): Promise<SpokenReplyVoice> {
      stop();
      const controller = new AbortController();
      active = controller;
      const myRun = runId;
      setKey(options?.key ?? null);
      try {
        return await speakPieces(text, controller);
      } finally {
        // A newer speak or a stop has already replaced this one; only the latest run clears the key.
        if (runId === myRun) {
          active = null;
          setKey(null);
        }
      }
    },
  };
}

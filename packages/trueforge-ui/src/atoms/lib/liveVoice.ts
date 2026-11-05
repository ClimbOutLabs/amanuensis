'use client';

/**
 * Browser side of voice mode: sends 16 kHz microphone samples over one WebSocket and plays the
 * 24 kHz samples that come back. The server decides when speech starts and ends, when to answer
 * and when to stop talking; this file only moves audio and reports what the server says.
 */
import type { VoiceConnection } from '../../components/VoiceInputContext.js';
import { audioContextCtor, resampleLinear, VOICE_SAMPLE_RATE } from './voiceRecorder.js';

/** Rate of the audio the server sends. */
export const LIVE_PLAYBACK_RATE = 24_000;
/** Samples per captured frame: 64 ms, so the server hears the end of a sentence promptly. */
const CAPTURE_FRAME_SAMPLES = 1024;

export type LiveVoiceState = 'listening' | 'thinking' | 'speaking';

export type LiveVoiceEvents = {
  onState: (state: LiveVoiceState) => void;
  /** A turn was saved in the chat, so the chat should refresh. */
  onTurnSaved: () => void;
  /** A plain-words message for the person. */
  onNotice: (text: string) => void;
  /** The line closed, or the mic was lost. Never called after `stop`. */
  onEnded: (reason: 'closed' | 'mic_lost') => void;
};

export type LiveVoice = {
  /** Ends the conversation: tells the server, releases the mic and stops playback. */
  stop: () => void;
};

/** Mono float samples as the 16-bit little-endian bytes the server reads. */
export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out.setInt16(i * 2, Math.round(clamped * 32767), true);
  }
  return out.buffer;
}

/** 16-bit little-endian bytes as float samples. A stray odd byte is dropped. */
export function pcm16ToFloat(bytes: ArrayBuffer): Float32Array {
  const view = new DataView(bytes);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export type ServerMessage =
  | { kind: 'ready' }
  | { kind: 'clear' }
  | { kind: 'state'; state: LiveVoiceState }
  | { kind: 'turn_saved' }
  | { kind: 'notice'; text: string };

function isLiveState(value: unknown): value is LiveVoiceState {
  return value === 'listening' || value === 'thinking' || value === 'speaking';
}

/** Reads one JSON message from the server; anything it does not recognise is dropped. */
export function readServerMessage(text: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return null;
  if (parsed.type === 'ready' || parsed.type === 'clear' || parsed.type === 'turn_saved') {
    return { kind: parsed.type };
  }
  if (parsed.type === 'state' && 'state' in parsed && isLiveState(parsed.state)) {
    return { kind: 'state', state: parsed.state };
  }
  if (parsed.type === 'notice' && 'text' in parsed && typeof parsed.text === 'string') {
    return { kind: 'notice', text: parsed.text };
  }
  return null;
}

/** Plays queued chunks back to back, and drops them all at once on `clear`. */
class Player {
  readonly #context: AudioContext;
  readonly #playing = new Set<AudioBufferSourceNode>();
  #nextStart = 0;

  constructor(context: AudioContext) {
    this.#context = context;
  }

  enqueue(samples: Float32Array): void {
    if (samples.length === 0) return;
    const buffer = this.#context.createBuffer(1, samples.length, LIVE_PLAYBACK_RATE);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#context.destination);
    const startAt = Math.max(this.#context.currentTime, this.#nextStart);
    this.#nextStart = startAt + buffer.duration;
    this.#playing.add(source);
    source.onended = () => this.#playing.delete(source);
    source.start(startAt);
  }

  clear(): void {
    for (const source of this.#playing) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    this.#playing.clear();
    this.#nextStart = 0;
  }

  close(): void {
    this.clear();
    void this.#context.close().catch(() => undefined);
  }
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('The voice line could not be opened.'));
    socket.onclose = () => reject(new Error('The voice line closed before it opened.'));
  });
}

/**
 * Opens the microphone and the voice line, and starts the conversation. Echo cancellation and
 * noise suppression are on, so the mic hears the person and not the speakers. Rejects when the mic
 * or the line cannot be opened; everything opened so far is released first.
 */
export async function startLiveVoice({
  connection,
  events,
}: {
  connection: VoiceConnection;
  events: LiveVoiceEvents;
}): Promise<LiveVoice> {
  const Ctor = audioContextCtor();
  if (Ctor === undefined || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new Error('Voice capture is not supported in this browser');
  }
  // Both audio contexts are made right away, while the tap that started voice mode still counts.
  const playbackContext = new Ctor({ sampleRate: LIVE_PLAYBACK_RATE });
  const player = new Player(playbackContext);
  let stream: MediaStream | undefined;
  let socket: WebSocket | undefined;
  let captureContext: AudioContext | undefined;
  let stopped = false;

  const teardown = () => {
    stopped = true;
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (captureContext !== undefined) void captureContext.close().catch(() => undefined);
    player.close();
    if (socket !== undefined && socket.readyState <= WebSocket.OPEN) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'end' }));
      socket.close(1000, 'done');
    }
  };

  try {
    void playbackContext.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    socket = new WebSocket(connection.url, connection.protocols);
    socket.binaryType = 'arraybuffer';
    await opened(socket);
  } catch (error) {
    teardown();
    throw error;
  }
  const line = socket;
  const mic = stream;

  const end = (reason: 'closed' | 'mic_lost') => {
    if (stopped) return;
    teardown();
    events.onEnded(reason);
  };
  line.onerror = null;
  line.onclose = () => end('closed');
  line.onmessage = message => {
    if (stopped) return;
    if (message.data instanceof ArrayBuffer) {
      player.enqueue(pcm16ToFloat(message.data));
      return;
    }
    if (typeof message.data !== 'string') return;
    const event = readServerMessage(message.data);
    if (event === null) return;
    switch (event.kind) {
      case 'clear':
        player.clear();
        break;
      case 'state':
        events.onState(event.state);
        break;
      case 'turn_saved':
        events.onTurnSaved();
        break;
      case 'notice':
        events.onNotice(event.text);
        break;
      case 'ready':
        break;
    }
  };

  for (const track of mic.getTracks()) track.onended = () => end('mic_lost');
  try {
    captureContext = new Ctor({ sampleRate: VOICE_SAMPLE_RATE });
    const capture = captureContext;
    const source = capture.createMediaStreamSource(mic);
    const processor = capture.createScriptProcessor(CAPTURE_FRAME_SAMPLES, 1, 1);
    const mute = capture.createGain();
    // A muted gain keeps the processor running without playing the mic back.
    mute.gain.value = 0;
    processor.onaudioprocess = frame => {
      if (stopped || line.readyState !== WebSocket.OPEN) return;
      const samples = resampleLinear(new Float32Array(frame.inputBuffer.getChannelData(0)), {
        fromRate: capture.sampleRate,
        toRate: VOICE_SAMPLE_RATE,
      });
      line.send(floatToPcm16(samples));
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(capture.destination);
  } catch (error) {
    teardown();
    throw error;
  }

  return {
    stop: () => {
      if (!stopped) teardown();
    },
  };
}

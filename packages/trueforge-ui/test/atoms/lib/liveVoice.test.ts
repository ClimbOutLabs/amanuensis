// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pcm16ToFloat, readServerEvent, startLiveVoice, type LiveVoiceEvents } from '@/atoms/lib/liveVoice.js';
import { floatToPcm16 } from '@/atoms/lib/voiceRecorder.js';

describe('voice line audio', () => {
  it('turns float samples into 16-bit little-endian bytes and back', () => {
    const bytes = floatToPcm16(new Float32Array([0, 0.5, -0.5, 1, -1, 2]));
    const view = new DataView(bytes);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(16384);
    expect(view.getInt16(4, true)).toBe(-16383);
    expect(view.getInt16(6, true)).toBe(32767);
    expect(view.getInt16(10, true)).toBe(32767);
    const back = pcm16ToFloat(bytes);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBeCloseTo(-0.5, 3);
  });

  it('drops a stray odd byte', () => {
    expect(pcm16ToFloat(new ArrayBuffer(5)).length).toBe(2);
  });
});

describe('readServerEvent', () => {
  it('reads the messages the server sends', () => {
    expect(readServerEvent('{"type":"ready","sample_rate":24000}')).toEqual({ type: 'ready', sample_rate: 24000 });
    expect(readServerEvent('{"type":"clear"}')).toEqual({ type: 'clear' });
    expect(readServerEvent('{"type":"turn_saved","turn_id":"t1"}')).toEqual({ type: 'turn_saved', turn_id: 't1' });
    expect(readServerEvent('{"type":"heard","text":"hello"}')).toEqual({ type: 'heard', text: 'hello' });
    expect(readServerEvent('{"type":"state","state":"thinking"}')).toEqual({ type: 'state', state: 'thinking' });
    expect(readServerEvent('{"type":"notice","text":"Hi"}')).toEqual({ type: 'notice', text: 'Hi' });
    expect(readServerEvent('{"type":"tts_failed"}')).toEqual({ type: 'tts_failed' });
  });

  it('drops what it does not know', () => {
    expect(readServerEvent('not json')).toBeNull();
    expect(readServerEvent('{"type":"state","state":"dancing"}')).toBeNull();
    expect(readServerEvent('{"type":"ready","sample_rate":0}')).toBeNull();
    expect(readServerEvent('{"type":"other"}')).toBeNull();
    expect(readServerEvent('[]')).toBeNull();
  });
});

class FakeSocket {
  static last: FakeSocket | undefined;
  static readonly OPEN = 1;
  readonly OPEN = 1;
  binaryType = '';
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.last = this;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

class FakeAudioContext {
  static all: FakeAudioContext[] = [];
  sampleRate: number;
  currentTime = 0;
  destination = {};
  closed = false;
  sources: { stopped: boolean; startedAt: number }[] = [];
  processor: { onaudioprocess: ((event: unknown) => void) | null } = { onaudioprocess: null };
  constructor(options: { sampleRate: number }) {
    this.sampleRate = options.sampleRate;
    FakeAudioContext.all.push(this);
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, copyToChannel: vi.fn() };
  }
  createBufferSource() {
    const entry = { stopped: false, startedAt: -1 };
    this.sources.push(entry);
    return {
      buffer: null,
      onended: null,
      connect: vi.fn(),
      start: (at: number) => {
        entry.startedAt = at;
      },
      stop: () => {
        entry.stopped = true;
      },
    };
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createScriptProcessor() {
    return Object.assign(this.processor, { connect: vi.fn(), disconnect: vi.fn() });
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  }
}

describe('startLiveVoice', () => {
  const stopTrack = vi.fn();
  let getUserMedia: ReturnType<typeof vi.fn>;
  let events: LiveVoiceEvents;

  beforeEach(() => {
    FakeSocket.last = undefined;
    FakeAudioContext.all = [];
    stopTrack.mockClear();
    getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack, onended: null }] }));
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    events = { onState: vi.fn(), onTurnSaved: vi.fn(), onNotice: vi.fn(), onEnded: vi.fn() };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function start() {
    const pending = startLiveVoice({
      connection: { url: 'wss://aman.test/stream', protocols: ['aman-voice.v1', 'ticket.t1'] },
      events,
    });
    await vi.waitFor(() => expect(FakeSocket.last).toBeDefined());
    FakeSocket.last?.open();
    return pending;
  }

  it('asks the mic for echo cancellation and noise suppression and passes the ticket as a protocol', async () => {
    await start();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(FakeSocket.last?.protocols).toEqual(['aman-voice.v1', 'ticket.t1']);
    expect(FakeSocket.last?.url).not.toContain('t1');
  });

  it('sends microphone frames as 16 kHz 16-bit samples', async () => {
    await start();
    const capture = FakeAudioContext.all.find(context => context.sampleRate === 16_000);
    capture?.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array([0.5, -0.5]) } });
    const frame = FakeSocket.last?.sent[0];
    expect(frame).toBeInstanceOf(ArrayBuffer);
    if (!(frame instanceof ArrayBuffer)) throw new Error('the frame is not binary');
    expect(new DataView(frame).getInt16(0, true)).toBe(16384);
  });

  it('plays what the server sends back to back, and a clear drops it all at once', async () => {
    await start();
    const playback = FakeAudioContext.all.find(context => context.sampleRate === 24_000);
    const half = new Int16Array(12_000).buffer;
    FakeSocket.last?.onmessage?.({ data: half });
    FakeSocket.last?.onmessage?.({ data: half });
    expect(playback?.sources.map(source => source.startedAt)).toEqual([0, 0.5]);
    FakeSocket.last?.onmessage?.({ data: '{"type":"clear"}' });
    expect(playback?.sources.every(source => source.stopped)).toBe(true);
  });

  it('plays at the rate the server says in its ready message', async () => {
    await start();
    const playback = FakeAudioContext.all.find(context => context.sampleRate === 24_000);
    const rates: number[] = [];
    const create = playback?.createBuffer.bind(playback);
    if (playback !== undefined && create !== undefined) {
      playback.createBuffer = (channels, length, rate) => {
        rates.push(rate);
        return create(channels, length, rate);
      };
    }
    FakeSocket.last?.onmessage?.({ data: '{"type":"ready","sample_rate":8000}' });
    FakeSocket.last?.onmessage?.({ data: new Int16Array(800).buffer });
    expect(rates).toEqual([8000]);
  });

  it('reports states, saved turns and notices', async () => {
    await start();
    FakeSocket.last?.onmessage?.({ data: '{"type":"state","state":"speaking"}' });
    FakeSocket.last?.onmessage?.({ data: '{"type":"turn_saved","turn_id":"t"}' });
    FakeSocket.last?.onmessage?.({ data: '{"type":"notice","text":"Hello"}' });
    expect(events.onState).toHaveBeenCalledWith('speaking');
    expect(events.onTurnSaved).toHaveBeenCalled();
    expect(events.onNotice).toHaveBeenCalledWith('Hello');
  });

  it('tells the person in plain words when a reply could not be spoken, and where to read it', async () => {
    await start();
    FakeSocket.last?.onmessage?.({ data: '{"type":"tts_failed"}' });
    expect(events.onNotice).toHaveBeenCalledWith(
      'I could not say that out loud. Check that the voice is running. The reply is in the chat.',
    );
  });

  it('stop tells the server, releases the mic and every audio context, and reports nothing', async () => {
    const live = await start();
    live.stop();
    expect(FakeSocket.last?.sent).toContain('{"type":"end"}');
    expect(FakeSocket.last?.closed).toBe(true);
    expect(stopTrack).toHaveBeenCalled();
    expect(FakeAudioContext.all.every(context => context.closed)).toBe(true);
    FakeSocket.last?.onclose?.();
    expect(events.onEnded).not.toHaveBeenCalled();
  });

  it('a close from the server ends everything and says so', async () => {
    await start();
    FakeSocket.last?.onclose?.();
    expect(events.onEnded).toHaveBeenCalledWith('closed');
    expect(stopTrack).toHaveBeenCalled();
  });

  it('releases the mic when the line cannot be opened', async () => {
    const pending = startLiveVoice({ connection: { url: 'wss://aman.test/stream', protocols: [] }, events });
    await vi.waitFor(() => expect(FakeSocket.last).toBeDefined());
    FakeSocket.last?.onerror?.();
    await expect(pending).rejects.toThrow(/could not be opened. Check your connection/);
    expect(stopTrack).toHaveBeenCalled();
    expect(FakeAudioContext.all.every(context => context.closed)).toBe(true);
  });
});

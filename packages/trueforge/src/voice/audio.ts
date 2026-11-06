/** Sample-format helpers for the voice engine. Speech is analysed as 16 kHz mono 16-bit, whatever the wire carries. */
export const INPUT_SAMPLE_RATE = 16_000;

/** What a transport sends in: the browser sends 16 kHz samples, a phone line sends 8 kHz mu-law. */
export type InputFormat = 'pcm16_16k' | 'mulaw8k';
/** What the voice container is asked for, matching the transport's playback: 24 kHz samples or 8 kHz mu-law. */
export type OutputFormat = 'pcm16' | 'mulaw8k';

export const OUTPUT_SAMPLE_RATE: Record<OutputFormat, number> = { pcm16: 24_000, mulaw8k: 8_000 };

const MULAW_BIAS = 0x84;

function mulawSample(byte: number): number {
  const inverted = ~byte & 0xff;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return inverted & 0x80 ? -magnitude : magnitude;
}

const MULAW_TABLE = Int16Array.from({ length: 256 }, (_, byte) => mulawSample(byte));

export function decodeMulaw(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[i] = MULAW_TABLE[bytes[i] ?? 0] ?? 0;
  }
  return out;
}

/** Linear 8 kHz to 16 kHz; `previous` is the last sample of the piece before, so pieces join smoothly. */
export function upsampleTo16k({ samples, previous }: { samples: Int16Array; previous: number }): Int16Array {
  const out = new Int16Array(samples.length * 2);
  let before = previous;
  for (let i = 0; i < samples.length; i += 1) {
    const current = samples[i] ?? 0;
    out[i * 2] = Math.round((before + current) / 2);
    out[i * 2 + 1] = current;
    before = current;
  }
  return out;
}

/** Turns wire bytes into 16 kHz samples, keeping what it needs between pieces (an odd byte, the last sample). */
export class InputDecoder {
  readonly #format: InputFormat;
  #oddByte: number | undefined;
  #lastSample = 0;

  constructor(format: InputFormat) {
    this.#format = format;
  }

  push(bytes: Uint8Array): Int16Array {
    if (this.#format === 'mulaw8k') {
      const samples = decodeMulaw(bytes);
      const up = upsampleTo16k({ samples, previous: this.#lastSample });
      this.#lastSample = samples[samples.length - 1] ?? this.#lastSample;
      return up;
    }
    let data = bytes;
    if (this.#oddByte !== undefined) {
      data = new Uint8Array(bytes.length + 1);
      data[0] = this.#oddByte;
      data.set(bytes, 1);
      this.#oddByte = undefined;
    }
    if (data.length % 2 === 1) {
      this.#oddByte = data[data.length - 1];
      data = data.subarray(0, data.length - 1);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out = new Int16Array(data.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = view.getInt16(i * 2, true);
    }
    return out;
  }
}

/** Plays back as samples at the format's own rate, so the engine can measure what it sent. */
export function outputToSamples({ bytes, format }: { bytes: Uint8Array; format: OutputFormat }): Int16Array {
  if (format === 'mulaw8k') {
    return decodeMulaw(bytes);
  }
  const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
  const view = new DataView(even.buffer, even.byteOffset, even.byteLength);
  const out = new Int16Array(even.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

export function rms(samples: Int16Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    const value = sample / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/** A 16 kHz mono 16-bit WAV file, the one body the speech-to-text container accepts. */
export function wavFromSamples(samples: Int16Array): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      out[offset + i] = text.charCodeAt(i);
    }
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, INPUT_SAMPLE_RATE, true);
  view.setUint32(28, INPUT_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, samples[i] ?? 0, true);
  }
  return out;
}

/** 16-bit little-endian bytes for samples, the way a browser sends them. */
export function pcmBytesOf(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i] ?? 0, true);
  }
  return out;
}

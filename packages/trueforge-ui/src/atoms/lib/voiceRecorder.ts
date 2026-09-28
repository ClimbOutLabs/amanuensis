'use client';

/**
 * 16 kHz mono voice capture for the chat composer. Records via getUserMedia,
 * accumulates raw PCM through a ScriptProcessorNode, and encodes a 16-bit PCM
 * mono WAV blob client-side. The browser posts that blob to the agent backend,
 * which forwards it to the local STT sidecar; audio never goes anywhere else.
 */

/** Sample rate the STT sidecar expects. */
export const VOICE_SAMPLE_RATE = 16000;
/** Client-side recording cap; the sidecar additionally enforces its 30 MB body limit. */
export const VOICE_MAX_RECORD_SECONDS = 180;

export type VoiceRecorder = {
  /** Stops capture and resolves with the recorded WAV. */
  stop: () => Promise<Blob>;
  /** Releases the mic without producing audio (e.g. on unmount). */
  cancel: () => void;
};

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return typeof window.AudioContext === 'function' ? window.AudioContext : undefined;
}

export function isVoiceCaptureSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    audioContextCtor() !== undefined
  );
}

/** Linear resample; used only when the browser ignores the requested 16 kHz rate. */
export function resampleLinear(
  samples: Float32Array,
  { fromRate, toRate }: { fromRate: number; toRate: number },
): Float32Array {
  if (fromRate === toRate) {
    return samples;
  }
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = src - lo;
    out[i] = (samples[lo] ?? 0) * (1 - frac) + (samples[hi] ?? 0) * frac;
  }
  return out;
}

/** Encodes mono float32 samples as a 16-bit PCM WAV blob. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function concatChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export type StartVoiceRecordingOptions = {
  /** Called when the max-duration timer fires; the caller should stop the recorder. */
  onAutoStop?: () => void;
};

export async function startVoiceRecording(options: StartVoiceRecordingOptions = {}): Promise<VoiceRecorder> {
  const Ctor = audioContextCtor();
  if (Ctor === undefined || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new Error('Voice capture is not supported in this browser');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // If anything below throws, release the mic before propagating; otherwise the
  // stream stays live with no handle to stop it.
  try {
    const context = new Ctor({ sampleRate: VOICE_SAMPLE_RATE });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    // ScriptProcessorNode only fires while connected; route through a muted gain
    // node so the mic is never played back through the speakers.
    const mute = context.createGain();
    mute.gain.value = 0;
    const chunks: Float32Array[] = [];
    let settled = false;
    processor.onaudioprocess = event => {
      if (settled) {
        return;
      }
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);

    const timer = window.setTimeout(() => {
      options.onAutoStop?.();
    }, VOICE_MAX_RECORD_SECONDS * 1000);

    const teardown = () => {
      settled = true;
      window.clearTimeout(timer);
      processor.onaudioprocess = null;
      try {
        source.disconnect();
        processor.disconnect();
        mute.disconnect();
      } catch {
        // Nodes may already be disconnected; teardown is idempotent.
      }
      for (const track of stream.getTracks()) {
        track.stop();
      }
      void context.close().catch(() => undefined);
    };

    let stopImpl: () => Promise<Blob> = async () => {
      teardown();
      const mono = concatChunks(chunks);
      const resampled = resampleLinear(mono, { fromRate: context.sampleRate, toRate: VOICE_SAMPLE_RATE });
      return encodeWav(resampled, VOICE_SAMPLE_RATE);
    };

    return {
      stop: () => {
        const run = stopImpl;
        stopImpl = async () => {
          throw new Error('Recorder already stopped');
        };
        return run();
      },
      cancel: () => {
        stopImpl = async () => {
          throw new Error('Recorder already stopped');
        };
        teardown();
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    throw error;
  }
}

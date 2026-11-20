// How the setup program and its window talk: every message is one
// frame, a kind, a length and that many bytes. Text messages and the
// password travel as different kinds, so a password can never be read
// as a message and a message can never be read as a password.

export const FRAME_MESSAGE = 0x01;
export const FRAME_PASSWORD = 0x02;
// Kept for a secret the program shows the person once. Nothing sends
// it yet; the number is fixed so no other frame ever takes it.
export const FRAME_SHOW_ONCE = 0x03;

// The largest frame of each kind. A longer one is refused from its
// header alone, before any room is made for it.
export const MESSAGE_FRAME_CAP = 64 * 1024;
export const PASSWORD_FRAME_CAP = 1024;

const HEADER_LENGTH = 5;

export type FrameKind = typeof FRAME_MESSAGE | typeof FRAME_PASSWORD;

export interface Frame {
  kind: FrameKind;
  payload: Uint8Array;
}

export class FrameError extends Error {}

function capFor(kind: number): number | null {
  if (kind === FRAME_MESSAGE) {
    return MESSAGE_FRAME_CAP;
  }
  if (kind === FRAME_PASSWORD) {
    return PASSWORD_FRAME_CAP;
  }
  return null;
}

function kindOf(byte: number): FrameKind | null {
  if (byte === FRAME_MESSAGE || byte === FRAME_PASSWORD) {
    return byte;
  }
  return null;
}

export function encodeFrame(frame: Frame): Uint8Array {
  const cap = capFor(frame.kind);
  if (cap === null || frame.payload.length > cap) {
    throw new FrameError('the frame is too long to send');
  }
  const bytes = new Uint8Array(HEADER_LENGTH + frame.payload.length);
  bytes[0] = frame.kind;
  new DataView(bytes.buffer).setUint32(1, frame.payload.length, false);
  bytes.set(frame.payload, HEADER_LENGTH);
  return bytes;
}

// Turns the bytes the window writes into frames, however they are cut
// into chunks on the way. A password frame's bytes are copied into a
// buffer of their own, and the reader's copy is wiped as soon as the
// frame is handed over.
export class FrameReader {
  private held = new Uint8Array(0);
  private failed = false;

  push(chunk: Uint8Array): Frame[] {
    if (this.failed) {
      throw new FrameError('the frames stopped making sense earlier');
    }
    const joined = new Uint8Array(this.held.length + chunk.length);
    joined.set(this.held);
    joined.set(chunk, this.held.length);
    this.held.fill(0);
    this.held = joined;
    const frames: Frame[] = [];
    let offset = 0;
    try {
      for (;;) {
        if (this.held.length - offset < HEADER_LENGTH) {
          break;
        }
        const kind = kindOf(this.held[offset] ?? 0);
        const cap = kind === null ? null : capFor(kind);
        if (kind === null || cap === null) {
          throw new FrameError('a frame of an unknown kind arrived');
        }
        const length = new DataView(this.held.buffer, this.held.byteOffset + offset + 1, 4).getUint32(0, false);
        if (length > cap) {
          throw new FrameError('a frame longer than its kind allows arrived');
        }
        if (this.held.length - offset < HEADER_LENGTH + length) {
          break;
        }
        const start = offset + HEADER_LENGTH;
        frames.push({ kind, payload: this.held.slice(start, start + length) });
        offset = start + length;
      }
    } catch (error) {
      this.failed = true;
      for (const frame of frames) {
        frame.payload.fill(0);
      }
      this.held.fill(0);
      this.held = new Uint8Array(0);
      throw error;
    }
    const rest = this.held.slice(offset);
    this.held.fill(0);
    this.held = rest;
    return frames;
  }

  // Wipes whatever is still held, for when the window is gone.
  clear(): void {
    this.held.fill(0);
    this.held = new Uint8Array(0);
  }
}

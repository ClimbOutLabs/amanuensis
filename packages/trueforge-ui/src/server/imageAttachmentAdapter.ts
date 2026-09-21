import type { AttachmentAdapter, PendingAttachment } from '@assistant-ui/core';

/** Longest edge, in pixels, an attached image keeps. Enough for a photo to be read; far below a camera original. */
export const IMAGE_MAX_EDGE = 1600;
/** Images at or under this size are sent as they are, whatever their dimensions. */
export const IMAGE_PASSTHROUGH_BYTES = 600 * 1024;
const JPEG_QUALITY = 0.85;
/** Bytes read from the front of a file to sniff for an animation marker. Comfortably covers the
 * PNG signature plus IHDR and acTL chunks, and a WebP RIFF header with VP8X or ANIM chunks. */
const SNIFF_BYTES = 64 * 1024;

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

function bytesEqual(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset + expected.length > bytes.length) {
    return false;
  }
  return expected.every((value, index) => bytes[offset + index] === value);
}

function asciiEqual(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when a PNG's chunk stream carries an 'acTL' chunk before its first 'IDAT', which marks it as APNG. */
function isAnimatedPng(bytes: Uint8Array): boolean {
  if (!bytesEqual(bytes, 0, PNG_SIGNATURE)) {
    return false;
  }
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length =
      ((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0);
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    if (type === 'acTL') {
      return true;
    }
    if (type === 'IDAT') {
      return false;
    }
    // A huge or negative length means a truncated or corrupt sniff window; bail rather than loop forever.
    if (length < 0 || !Number.isFinite(length)) {
      return false;
    }
    offset += 8 + length + 4; // chunk data plus the trailing CRC
  }
  return false;
}

/** True when a WebP's RIFF chunks mark it as animated: a VP8X chunk with the animation bit set, or an ANIM chunk. */
function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (!asciiEqual(bytes, 0, 'RIFF') || !asciiEqual(bytes, 8, 'WEBP')) {
    return false;
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const length =
      (bytes[offset + 4] ?? 0) |
      ((bytes[offset + 5] ?? 0) << 8) |
      ((bytes[offset + 6] ?? 0) << 16) |
      ((bytes[offset + 7] ?? 0) << 24);
    const dataOffset = offset + 8;
    if (type === 'ANIM') {
      return true;
    }
    if (type === 'VP8X') {
      const flags = bytes[dataOffset] ?? 0;
      // Bit 1 (0x02) of the VP8X flags byte is the animation flag.
      if ((flags & 0x02) !== 0) {
        return true;
      }
    }
    if (length < 0 || !Number.isFinite(length)) {
      return false;
    }
    offset = dataOffset + length + (length % 2); // chunks are padded to an even length
  }
  return false;
}

/** True when the file's own bytes mark it as an animated PNG (APNG) or animated WebP. */
async function isAnimatedImage(file: File): Promise<boolean> {
  if (file.type !== 'image/png' && file.type !== 'image/webp') {
    return false;
  }
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  return file.type === 'image/png' ? isAnimatedPng(head) : isAnimatedWebp(head);
}

/** True when the image is worth re-encoding: large in bytes, and not an animated or vector format. */
export async function shouldDownscaleImage(file: File): Promise<boolean> {
  if (
    !isImageFile(file) ||
    file.size <= IMAGE_PASSTHROUGH_BYTES ||
    file.type === 'image/gif' ||
    file.type === 'image/svg+xml'
  ) {
    return false;
  }
  return !(await isAnimatedImage(file));
}

function fitWithin(options: { width: number; height: number; maxEdge: number }): {
  width: number;
  height: number;
} {
  const { width, height, maxEdge } = options;
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function withExtension(options: { name: string; extension: string }): string {
  const { name, extension } = options;
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

/**
 * Re-encodes an image to fit the longest-edge limit, as JPEG. Returns the original file when
 * the browser cannot decode or draw it, or when re-encoding does not make it smaller: the
 * server still caps what it forwards, so a fallback here never sends more than before.
 */
export async function downscaleImageFile(file: File): Promise<File> {
  if (
    !(await shouldDownscaleImage(file)) ||
    typeof createImageBitmap !== 'function' ||
    typeof document === 'undefined'
  ) {
    return file;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const { width, height } = fitWithin({ width: bitmap.width, height: bitmap.height, maxEdge: IMAGE_MAX_EDGE });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) {
      return file;
    }
    // A transparent PNG lands on white, which is what a JPEG of it would show anyway.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
    });
    if (blob === null || blob.size >= file.size) {
      return file;
    }
    return new File([blob], withExtension({ name: file.name, extension: 'jpg' }), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

/**
 * Wraps an attachment adapter so large images are downscaled once, at attach time, before the
 * adapter reads them. The model receives the image inside every request of a turn, so a
 * camera original costs its full size on every step; a 1600 px JPEG costs a fraction of it.
 */
export function withImageDownscaling(base: AttachmentAdapter): AttachmentAdapter {
  return {
    ...base,
    async add(state) {
      const file = await downscaleImageFile(state.file);
      const result = base.add({ ...state, file });
      const asyncIterator = (result as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
      if (typeof asyncIterator !== 'function') {
        // A promise or thenable, whether or not it is a native Promise instance.
        return await (result as PromiseLike<PendingAttachment>);
      }
      // An adapter may stream progress; the last item is the attachment it settled on.
      let settled: PendingAttachment | undefined;
      for await (const item of result as AsyncIterable<PendingAttachment>) {
        settled = item;
      }
      if (settled === undefined) {
        throw new Error('The attachment adapter produced no attachment.');
      }
      return settled;
    },
  };
}

/** The most pixels one image may have before it is not sent to OCR: a decompression bomb would exhaust the sandbox. */
export const MAX_OCR_PIXELS = 50_000_000;

type SniffedImageFormat = 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp' | 'tiff';

interface SniffedImage {
  format: SniffedImageFormat;
  width: number;
  height: number;
}

const IMAGE_EXTENSIONS: Record<SniffedImageFormat, readonly string[]> = {
  png: ['.png'],
  jpeg: ['.jpg', '.jpeg'],
  gif: ['.gif'],
  bmp: ['.bmp'],
  webp: ['.webp'],
  tiff: ['.tif', '.tiff'],
};

/** True when the bytes begin like a PDF (the header may follow a few bytes of junk, as readers allow). */
export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).includes('%PDF-');
}

/** True when the bytes begin like a zip, the container of .docx and .odt files. */
export function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** True when a file name's extension is one the sniffed format uses. */
export function extensionMatchesImage({
  extension,
  format,
}: {
  extension: string;
  format: SniffedImageFormat;
}): boolean {
  return IMAGE_EXTENSIONS[format].includes(extension.toLowerCase());
}

function pngSize(b: Buffer): SniffedImage | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 24 || !b.subarray(0, 8).equals(signature) || b.toString('latin1', 12, 16) !== 'IHDR') {
    return null;
  }
  return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifSize(b: Buffer): SniffedImage | null {
  const head = b.toString('latin1', 0, 6);
  if (b.length < 10 || (head !== 'GIF87a' && head !== 'GIF89a')) {
    return null;
  }
  return { format: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function bmpSize(b: Buffer): SniffedImage | null {
  if (b.length < 26 || b.toString('latin1', 0, 2) !== 'BM') {
    return null;
  }
  return { format: 'bmp', width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
}

const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(b: Buffer): SniffedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      return null;
    }
    const marker = b[offset + 1];
    if (marker === undefined) {
      return null;
    }
    if (JPEG_FRAME_MARKERS.has(marker)) {
      return { format: 'jpeg', height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
    }
    offset += 2 + b.readUInt16BE(offset + 2);
  }
  return null;
}

function webpSize(b: Buffer): SniffedImage | null {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') {
    return { format: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    return { format: 'webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function tiffSize(b: Buffer): SniffedImage | null {
  const little = b.toString('latin1', 0, 4) === 'II*\0';
  if (b.length < 8 || (!little && b.toString('latin1', 0, 4) !== 'MM\0*')) {
    return null;
  }
  const u16 = (at: number): number => (little ? b.readUInt16LE(at) : b.readUInt16BE(at));
  const u32 = (at: number): number => (little ? b.readUInt32LE(at) : b.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > b.length) {
    return null;
  }
  let width: number | undefined;
  let height: number | undefined;
  const entries = Math.min(u16(ifd), 64);
  for (let index = 0; index < entries; index += 1) {
    const at = ifd + 2 + index * 12;
    if (at + 12 > b.length) {
      return null;
    }
    const tag = u16(at);
    const value = u16(at + 2) === 3 ? u16(at + 8) : u32(at + 8);
    if (tag === 256) {
      width = value;
    } else if (tag === 257) {
      height = value;
    }
  }
  return width === undefined || height === undefined ? null : { format: 'tiff', width, height };
}

/**
 * Reads the format and pixel size from the file header alone, by magic bytes, never by extension.
 * Null when the bytes are not a supported image or the header is cut short.
 */
export function inspectImageHeader(bytes: Buffer): SniffedImage | null {
  return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes) ?? bmpSize(bytes) ?? webpSize(bytes) ?? tiffSize(bytes);
}

import { CHAT_IMAGE_INPUT_MIME_TYPES, type ChatImageInputType } from '@truefoundry/trueforge-core/core/chatImages';

/** Types the sandbox writes. */
export type ChatImageOutputType = 'png' | 'webp';

export const CHAT_IMAGE_OUTPUT_MIME: Record<ChatImageOutputType, string> = {
  png: 'image/png',
  webp: 'image/webp',
};

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + prefix.length) {
    return false;
  }
  return prefix.every((value, index) => bytes[offset + index] === value);
}

const ascii = (text: string): number[] => Array.from(Buffer.from(text, 'latin1'));

/**
 * The allow-listed type the bytes start with, or null for anything else (SVG, HTML, PDF, AVIF, an
 * empty file). Only the signature is read; the sandbox decoder must agree before anything is shown.
 */
export function sniffImageType(bytes: Uint8Array): ChatImageInputType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png';
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'jpeg';
  }
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) {
    return 'gif';
  }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) {
    return 'webp';
  }
  return null;
}

/** The type the sandbox wrote, checked again on the host before the bytes are stored. */
export function sniffOutputType(bytes: Uint8Array): ChatImageOutputType | null {
  const type = sniffImageType(bytes);
  return type === 'png' || type === 'webp' ? type : null;
}

/**
 * The allow-listed type a Content-Type header names, compared exactly after trimming and lowercasing.
 * Parameters, lists and every other type (SVG included) are refused.
 */
export function imageTypeFromContentType(header: string | null): ChatImageInputType | null {
  if (header === null) {
    return null;
  }
  return CHAT_IMAGE_INPUT_MIME_TYPES.get(header.trim().toLowerCase()) ?? null;
}

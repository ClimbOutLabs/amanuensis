import {
  extensionMatchesImage,
  inspectImageHeader,
  looksLikePdf,
  MAX_OCR_PIXELS,
} from '../../../src/documents/fileSniff';
import { syntheticPdf, syntheticPng } from './syntheticFiles';

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write('GIF89a', 0, 'latin1');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function bmp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('BM', 0, 'latin1');
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(-height, 22);
  return bytes;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment to skip, then SOF0 with the size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]);
  const sof = Buffer.alloc(11);
  sof.set([0xff, 0xc0, 0x00, 0x0b, 0x08], 0);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Buffer {
  const bytes = Buffer.alloc(40);
  bytes.write('RIFF', 0, 'latin1');
  bytes.write('WEBP', 8, 'latin1');
  bytes.write(kind, 12, 'latin1');
  if (kind === 'VP8 ') {
    bytes.writeUInt16LE(width, 26);
    bytes.writeUInt16LE(height, 28);
  } else if (kind === 'VP8L') {
    bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  } else {
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  }
  return bytes;
}

function tiff(littleEndian: boolean, width: number, height: number): Buffer {
  const bytes = Buffer.alloc(40);
  bytes.write(littleEndian ? 'II*\0' : 'MM\0*', 0, 'latin1');
  const u16 = (value: number, at: number): void => {
    if (littleEndian) bytes.writeUInt16LE(value, at);
    else bytes.writeUInt16BE(value, at);
  };
  const u32 = (value: number, at: number): void => {
    if (littleEndian) bytes.writeUInt32LE(value, at);
    else bytes.writeUInt32BE(value, at);
  };
  u32(8, 4);
  u16(2, 8);
  for (const [index, [tag, value]] of [
    [256, width],
    [257, height],
  ].entries()) {
    const at = 10 + index * 12;
    u16(tag ?? 0, at);
    u16(4, at + 2);
    u32(1, at + 4);
    u32(value ?? 0, at + 8);
  }
  return bytes;
}

describe('file type and size from the first bytes', () => {
  it.each([
    ['png', syntheticPng({ width: 640, height: 480 })],
    ['gif', gif(640, 480)],
    ['bmp', bmp(640, 480)],
    ['jpeg', jpeg(640, 480)],
    ['webp', webp('VP8 ', 640, 480)],
    ['webp', webp('VP8L', 640, 480)],
    ['webp', webp('VP8X', 640, 480)],
    ['tiff', tiff(true, 640, 480)],
    ['tiff', tiff(false, 640, 480)],
  ])('reads a %s header', (format, bytes) => {
    expect(inspectImageHeader(bytes)).toEqual({ format, width: 640, height: 480 });
  });

  it('rejects bytes that are not an image, whatever the file is called', () => {
    expect(inspectImageHeader(Buffer.from('plain text, not an image at all'))).toBeNull();
    expect(inspectImageHeader(syntheticPdf())).toBeNull();
    expect(inspectImageHeader(Buffer.alloc(0))).toBeNull();
  });

  it('rejects a header that is cut short instead of throwing', () => {
    expect(inspectImageHeader(syntheticPng().subarray(0, 12))).toBeNull();
    expect(inspectImageHeader(jpeg(10, 10).subarray(0, 6))).toBeNull();
    expect(inspectImageHeader(tiff(true, 10, 10).subarray(0, 9))).toBeNull();
  });

  it('matches the extension to the format', () => {
    expect(extensionMatchesImage({ extension: '.JPG', format: 'jpeg' })).toBe(true);
    expect(extensionMatchesImage({ extension: '.tif', format: 'tiff' })).toBe(true);
    expect(extensionMatchesImage({ extension: '.png', format: 'jpeg' })).toBe(false);
  });

  it('recognises a PDF by its header and nothing else', () => {
    expect(looksLikePdf(syntheticPdf())).toBe(true);
    expect(looksLikePdf(Buffer.concat([Buffer.from('junk\n'), syntheticPdf()]))).toBe(true);
    expect(looksLikePdf(Buffer.from('PK\u0003\u0004 not a pdf'))).toBe(false);
  });

  it('keeps the pixel limit well above a phone photo', () => {
    expect(MAX_OCR_PIXELS).toBeGreaterThan(12_000_000);
  });
});

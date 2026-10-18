import {
  imageTypeFromContentType,
  sniffImageType,
  sniffOutputType,
} from '../../../../src/runtime/chatImages/imageSniff';
import { SVG_IMAGE } from './pythonImages';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe('sniffImageType', () => {
  it('identifies each allow-listed type by its leading bytes', () => {
    expect(sniffImageType(PNG_SIGNATURE)).toBe('png');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImageType(Buffer.from('GIF89a....'))).toBe('gif');
    expect(sniffImageType(Buffer.from('GIF87a....'))).toBe('gif');
    expect(sniffImageType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('webp');
  });

  it('refuses SVG, HTML, empty and look-alike files', () => {
    expect(sniffImageType(SVG_IMAGE)).toBeNull();
    expect(sniffImageType(Buffer.from('  <svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<html><img src=x></html>'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt '))).toBeNull();
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('accepts only PNG and WebP as sandbox output', () => {
    expect(sniffOutputType(PNG_SIGNATURE)).toBe('png');
    expect(sniffOutputType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
  });
});

describe('imageTypeFromContentType', () => {
  it('maps exact allow-listed types after trimming and lowercasing', () => {
    expect(imageTypeFromContentType(' Image/PNG ')).toBe('png');
    expect(imageTypeFromContentType('image/jpeg')).toBe('jpeg');
  });

  it('refuses SVG, parameters, lists and missing headers', () => {
    expect(imageTypeFromContentType('image/svg+xml')).toBeNull();
    expect(imageTypeFromContentType('image/png; charset=binary')).toBeNull();
    expect(imageTypeFromContentType('image/png, image/svg+xml')).toBeNull();
    expect(imageTypeFromContentType('text/html')).toBeNull();
    expect(imageTypeFromContentType(null)).toBeNull();
  });
});

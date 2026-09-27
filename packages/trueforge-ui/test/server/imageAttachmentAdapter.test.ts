// @vitest-environment jsdom
import type { Attachment, AttachmentAdapter, PendingAttachment } from '@assistant-ui/core';
import { describe, expect, it, vi } from 'vitest';

import {
  downscaleImageFile,
  IMAGE_PASSTHROUGH_BYTES,
  shouldDownscaleImage,
  withImageDownscaling,
} from '@/server/imageAttachmentAdapter.js';

function fileOf(options: { type: string; name?: string }, size: number): File {
  const { type, name = 'photo.png' } = options;
  return new File([new Uint8Array(size)], name, { type });
}

/** A minimal but well-formed APNG: PNG signature, IHDR, an acTL chunk, then IDAT. Chunk lengths
 * are real but CRCs are not checked by the sniffer, so they are left as zero. */
function apngFileOf(size: number, name = 'anim.png'): File {
  const chunks: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const pushChunk = (type: string, data: number[]) => {
    const length = data.length;
    chunks.push((length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
    for (const c of type) chunks.push(c.charCodeAt(0));
    chunks.push(...data);
    chunks.push(0, 0, 0, 0); // CRC placeholder, unchecked by the sniffer
  };
  // IHDR: width, height, bit depth, color type, compression, filter, interlace
  pushChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  // acTL: num_frames, num_plays
  pushChunk('acTL', [0, 0, 0, 1, 0, 0, 0, 0]);
  pushChunk('IDAT', [0, 0, 0, 0]);
  const bytes = new Uint8Array(Math.max(size, chunks.length));
  bytes.set(chunks, 0);
  return new File([bytes], name, { type: 'image/png' });
}

/** A minimal animated WebP: RIFF/WEBP header with a VP8X chunk whose animation bit is set. */
function animatedWebpFileOf(size: number, name = 'anim.webp'): File {
  const bytes: number[] = [];
  const pushAscii = (text: string) => {
    for (const c of text) bytes.push(c.charCodeAt(0));
  };
  const pushChunk = (type: string, data: number[]) => {
    pushAscii(type);
    const length = data.length;
    bytes.push(length & 0xff, (length >>> 8) & 0xff, (length >>> 16) & 0xff, (length >>> 24) & 0xff);
    bytes.push(...data);
    if (length % 2 !== 0) bytes.push(0);
  };
  pushAscii('RIFF');
  bytes.push(0, 0, 0, 0); // file size placeholder, unchecked by the sniffer
  pushAscii('WEBP');
  // VP8X flags byte: bit 0x02 is the animation flag; rest is reserved/canvas size, left zero.
  pushChunk('VP8X', [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const bytesArray = new Uint8Array(Math.max(size, bytes.length));
  bytesArray.set(bytes, 0);
  return new File([bytesArray], name, { type: 'image/webp' });
}

describe('image attachment downscaling', () => {
  it('leaves small images, non-images, and vector formats alone', async () => {
    await expect(shouldDownscaleImage(fileOf({ type: 'image/png' }, IMAGE_PASSTHROUGH_BYTES))).resolves.toBe(false);
    await expect(
      shouldDownscaleImage(fileOf({ type: 'application/pdf', name: 'doc.pdf' }, IMAGE_PASSTHROUGH_BYTES + 1)),
    ).resolves.toBe(false);
    await expect(
      shouldDownscaleImage(fileOf({ type: 'image/gif', name: 'a.gif' }, IMAGE_PASSTHROUGH_BYTES + 1)),
    ).resolves.toBe(false);
    await expect(
      shouldDownscaleImage(fileOf({ type: 'image/svg+xml', name: 'a.svg' }, IMAGE_PASSTHROUGH_BYTES + 1)),
    ).resolves.toBe(false);
    await expect(shouldDownscaleImage(fileOf({ type: 'image/png' }, IMAGE_PASSTHROUGH_BYTES + 1))).resolves.toBe(true);
  });

  it('leaves an animated PNG (APNG) alone', async () => {
    const file = apngFileOf(IMAGE_PASSTHROUGH_BYTES + 1);
    await expect(shouldDownscaleImage(file)).resolves.toBe(false);
  });

  it('leaves an animated WebP alone', async () => {
    const file = animatedWebpFileOf(IMAGE_PASSTHROUGH_BYTES + 1);
    await expect(shouldDownscaleImage(file)).resolves.toBe(false);
  });

  it('still downscales a static (non-animated) PNG or WebP', async () => {
    await expect(shouldDownscaleImage(fileOf({ type: 'image/png' }, IMAGE_PASSTHROUGH_BYTES + 1))).resolves.toBe(true);
    await expect(shouldDownscaleImage(fileOf({ type: 'image/webp' }, IMAGE_PASSTHROUGH_BYTES + 1))).resolves.toBe(true);
  });

  it('returns the original file when the browser cannot decode images', async () => {
    // jsdom has no createImageBitmap or canvas drawing; the server cap still applies.
    const large = fileOf({ type: 'image/png' }, IMAGE_PASSTHROUGH_BYTES + 1);
    await expect(downscaleImageFile(large)).resolves.toBe(large);
  });

  it('returns an animated PNG unchanged even when it is large', async () => {
    const large = apngFileOf(IMAGE_PASSTHROUGH_BYTES + 1);
    await expect(downscaleImageFile(large)).resolves.toBe(large);
  });

  it('hands the adapter the downscaled file and passes everything else through', async () => {
    const add = vi.fn(async ({ file }: { file: File }): Promise<PendingAttachment> => ({
      id: 'a1',
      type: 'file' as const,
      name: file.name,
      file,
      contentType: file.type,
      content: [],
      status: { type: 'requires-action' as const, reason: 'composer-send' as const },
    }));
    const base: AttachmentAdapter = {
      accept: '*',
      add,
      send: vi.fn(async (attachment: PendingAttachment) => ({
        ...attachment,
        content: attachment.content ?? [],
        status: { type: 'complete' as const },
      })),
      remove: vi.fn(async (_attachment: Attachment) => {
        return;
      }),
    };
    const wrapped = withImageDownscaling(base);
    const original = fileOf({ type: 'image/png', name: 'tiny.png' }, 10);
    await wrapped.add({ file: original });
    expect(add).toHaveBeenCalledWith({ file: original });
    expect(wrapped.accept).toBe('*');
  });

  it('accepts a thenable that is not a native Promise from the base adapter', async () => {
    const attachment: PendingAttachment = {
      id: 'a2',
      type: 'file',
      name: 'tiny.png',
      file: fileOf({ type: 'image/png', name: 'tiny.png' }, 10),
      contentType: 'image/png',
      content: [],
      status: { type: 'requires-action', reason: 'composer-send' },
    };
    const base: AttachmentAdapter = {
      accept: '*',
      add: vi.fn(() => ({
        then(resolve: (value: PendingAttachment) => void) {
          resolve(attachment);
        },
      })) as unknown as AttachmentAdapter['add'],
      send: vi.fn(async (a: PendingAttachment) => ({
        ...a,
        content: a.content ?? [],
        status: { type: 'complete' as const },
      })),
      remove: vi.fn(async (_attachment: Attachment) => {
        return;
      }),
    };
    const wrapped = withImageDownscaling(base);
    const result = await wrapped.add({ file: attachment.file });
    expect(result).toBe(attachment);
  });
});

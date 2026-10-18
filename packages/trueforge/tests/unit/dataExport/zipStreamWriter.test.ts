import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

import {
  normalizeZipEntryName,
  ZIP_MAX_ARCHIVE_BYTES,
  ZIP_MAX_ENTRIES,
  ZipEntryLimitExceededError,
  ZipEntrySizeCapExceededError,
  ZipOutputClosedError,
  ZipSizeCapExceededError,
  ZipStreamWriter,
} from '../../../src/dataExport/zipStreamWriter';
import { readZipEntries } from '../../fixtures/zipReader';

class CollectingWritable extends Writable {
  readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk);
    callback();
  }
}

/** Accepts one chunk, then holds every write until released, so the writer must wait for 'drain'. */
class SlowWritable extends Writable {
  readonly held: (() => void)[] = [];
  constructor() {
    super({ highWaterMark: 1 });
  }
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.held.push(() => {
      callback();
    });
  }
  releaseAll(): void {
    for (const release of this.held.splice(0)) {
      release();
    }
  }
}

describe('ZipStreamWriter', () => {
  it('writes entries a standard reader can open, byte-exact', async () => {
    const sink = new CollectingWritable();
    const zip = new ZipStreamWriter(sink, { maxBytes: 1_000_000 });
    await zip.addTextEntry('a/first.txt', 'hello world');
    await zip.addEntry('second.json', async entry => {
      await entry.writeText('{"part":');
      await entry.writeText('1}');
    });
    await zip.addBufferedEntry('empty.bin', new Uint8Array(0));
    await zip.finish();

    const entries = readZipEntries(Buffer.concat(sink.chunks));
    expect(entries.map(entry => entry.name)).toEqual(['a/first.txt', 'second.json', 'empty.bin']);
    expect(entries[0]?.data.toString('utf8')).toBe('hello world');
    expect(entries[1]?.data.toString('utf8')).toBe('{"part":1}');
    expect(entries[2]?.data.byteLength).toBe(0);
    expect(zip.bytesWritten).toBe(Buffer.concat(sink.chunks).byteLength);
  });

  it('throws ZipSizeCapExceededError past the cap', async () => {
    const zip = new ZipStreamWriter(new CollectingWritable(), { maxBytes: 64 });
    await expect(zip.addTextEntry('big.txt', 'x'.repeat(256))).rejects.toBeInstanceOf(ZipSizeCapExceededError);
  });

  it('clamps a cap above 4 GiB to what a classic zip can address', async () => {
    const discard = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const zip = new ZipStreamWriter(discard, { maxBytes: 2 ** 40, maxEntryBytes: 2 ** 40 });
    const block = new Uint8Array(64 * 1024 * 1024);
    const failure = await zip
      .addEntry('huge.bin', async sink => {
        for (let written = 0; written <= ZIP_MAX_ARCHIVE_BYTES; written += block.byteLength) {
          await sink.write(block);
        }
      })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ZipSizeCapExceededError);
    expect(failure).toMatchObject({ capBytes: ZIP_MAX_ARCHIVE_BYTES });
    expect(ZIP_MAX_ARCHIVE_BYTES).toBeLessThan(2 ** 32);
  }, 120_000);

  it('refuses an entry over the per-file cap, naming it, before its bytes are written', async () => {
    const sink = new CollectingWritable();
    const zip = new ZipStreamWriter(sink, { maxBytes: 1024 * 1024, maxEntryBytes: 64 * 1024 });
    await zip.addTextEntry('small.json', 'x'.repeat(64 * 1024));
    const failure = await zip
      .addTextEntry('chats.json', 'x'.repeat(64 * 1024 + 1))
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ZipEntrySizeCapExceededError);
    expect(failure instanceof Error && failure.message).toBe(
      'chats.json is over the 64 KB limit for one file in an export. Delete some long chats you no longer need, then export again.',
    );
    expect(Buffer.concat(sink.chunks).includes(Buffer.from('x'.repeat(64 * 1024 + 1)))).toBe(false);
  });

  it('refuses the entry that would not fit the 16-bit entry count', async () => {
    const zip = new ZipStreamWriter(new CollectingWritable(), { maxBytes: 1024 * 1024 * 1024 });
    for (let index = 0; index < ZIP_MAX_ENTRIES; index += 1) {
      await zip.addBufferedEntry(`f${String(index)}`, new Uint8Array(0));
    }
    expect(zip.entryCount).toBe(ZIP_MAX_ENTRIES);
    await expect(zip.addBufferedEntry('one-too-many', new Uint8Array(0))).rejects.toBeInstanceOf(
      ZipEntryLimitExceededError,
    );
  }, 60_000);

  it('normalizes entry names and de-duplicates collisions with a suffix', async () => {
    const sink = new CollectingWritable();
    const zip = new ZipStreamWriter(sink, { maxBytes: 1_000_000 });
    const stored = [
      await zip.addTextEntry('notes.txt', '1'),
      await zip.addTextEntry('notes.txt', '2'),
      await zip.addTextEntry('Notes.TXT', '3'),
      await zip.addTextEntry('dir\\sub\\..\\file.md', '4'),
      await zip.addTextEntry('C:\\Windows\\system.ini', '5'),
      await zip.addTextEntry('/etc/passwd', '6'),
      await zip.addTextEntry('../../up.txt', '7'),
      await zip.addTextEntry('', '8'),
      await zip.addTextEntry('noext', '9'),
      await zip.addTextEntry('noext', '10'),
    ];
    expect(stored).toEqual([
      'notes.txt',
      'notes (2).txt',
      'Notes (3).TXT',
      'dir/sub/file.md',
      'Windows/system.ini',
      'etc/passwd',
      'up.txt',
      'file',
      'noext',
      'noext (2)',
    ]);
    await zip.finish();
    expect(readZipEntries(Buffer.concat(sink.chunks)).map(entry => entry.name)).toEqual(stored);
  });

  it('normalizeZipEntryName drops control characters and drive designators', () => {
    expect(normalizeZipEntryName('a\u0000b/c\nd')).toBe('ab/cd');
    expect(normalizeZipEntryName('C:relative.txt')).toBe('relative.txt');
    expect(normalizeZipEntryName('a/C:/b')).toBe('a/b');
  });

  it('fails instead of hanging when the destination closes while the writer waits for drain', async () => {
    const out = new SlowWritable();
    out.on('error', () => undefined);
    const zip = new ZipStreamWriter(out, { maxBytes: 1_000_000 });
    const pending = zip.addTextEntry('a.txt', 'x'.repeat(100));
    await new Promise(resolve => setImmediate(resolve));
    out.destroy();
    await expect(pending).rejects.toBeInstanceOf(ZipOutputClosedError);
    await expect(zip.addTextEntry('b.txt', 'later')).rejects.toBeInstanceOf(ZipOutputClosedError);
  });

  it('does not leave listeners behind after waiting for drain many times', async () => {
    const out = new SlowWritable();
    const zip = new ZipStreamWriter(out, { maxBytes: 1_000_000_000 });
    const work = (async () => {
      for (let index = 0; index < 50; index += 1) {
        await zip.addTextEntry(`f${String(index)}`, 'data');
      }
      await zip.finish();
    })();
    // Release the held writes until the writer is done.
    const timer = setInterval(() => {
      out.releaseAll();
    }, 1);
    await work;
    clearInterval(timer);
    out.releaseAll();
    const emitter: EventEmitter = out;
    expect(emitter.listenerCount('error')).toBe(0);
    expect(emitter.listenerCount('drain')).toBe(0);
    expect(emitter.listenerCount('close')).toBe(0);
  });
});

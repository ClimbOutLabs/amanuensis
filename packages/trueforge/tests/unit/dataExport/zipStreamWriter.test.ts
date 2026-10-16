import { Writable } from 'node:stream';

import { ZipSizeCapExceededError, ZipStreamWriter } from '../../../src/dataExport/zipStreamWriter';
import { readZipEntries } from '../../fixtures/zipReader';

class CollectingWritable extends Writable {
  readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk);
    callback();
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
});

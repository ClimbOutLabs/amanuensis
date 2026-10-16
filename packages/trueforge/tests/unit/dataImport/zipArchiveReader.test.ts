import { Writable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';

import { IncrementalCrc32, ZipStreamWriter } from '../../../src/dataExport/zipStreamWriter';
import { readZipArchive, ZipArchiveError } from '../../../src/dataImport/zipArchiveReader';

class CollectingWritable extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface TestEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  flags?: number;
  crcOverride?: number;
  declaredSizeOverride?: number;
}

/** Assembles a zip with full control over methods, flags, and CRCs, for the refusal cases. */
function buildZip(entries: TestEntry[], options?: { endRecord?: { totalEntries?: number } }): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const crc = new IncrementalCrc32();
    crc.update(entry.data);
    const crcValue = entry.crcOverride ?? crc.digest();
    const declaredSize = entry.declaredSizeOverride ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crcValue, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(entry.flags ?? 0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(crcValue, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(declaredSize, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options?.endRecord?.totalEntries ?? entries.length, 8);
  end.writeUInt16LE(options?.endRecord?.totalEntries ?? entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBytes, end]);
}

const LIMITS = { maxEntryBytes: 1024, maxTotalBytes: 4096, maxEntries: 10 };

describe('readZipArchive', () => {
  it('reads stored entries written by the export zip writer', async () => {
    const sink = new CollectingWritable();
    const writer = new ZipStreamWriter(sink, { maxBytes: 1024 * 1024 });
    await writer.addEntry('manifest.json', async entrySink => {
      await entrySink.writeText('{"a":1}');
    });
    await writer.addEntry('memory/default/MEMORY.md', async entrySink => {
      await entrySink.writeText('# Notes');
    });
    await writer.finish();
    const entries = readZipArchive(sink.buffer(), LIMITS);
    expect(entries.map(entry => entry.name)).toEqual(['manifest.json', 'memory/default/MEMORY.md']);
    expect(entries[0]?.data.toString('utf8')).toBe('{"a":1}');
    expect(entries[1]?.data.toString('utf8')).toBe('# Notes');
  });

  it('reads deflated entries', () => {
    const zip = buildZip([{ name: 'big.json', data: Buffer.from('x'.repeat(500)), method: 8 }]);
    const entries = readZipArchive(zip, LIMITS);
    expect(entries[0]?.data.toString('utf8')).toBe('x'.repeat(500));
  });

  it('skips directory entries', () => {
    const zip = buildZip([
      { name: 'memory/', data: Buffer.alloc(0) },
      { name: 'memory/a.md', data: Buffer.from('hi') },
    ]);
    const entries = readZipArchive(zip, LIMITS);
    expect(entries.map(entry => entry.name)).toEqual(['memory/a.md']);
  });

  it('refuses a file over the per-file cap before inflating', () => {
    const zip = buildZip([{ name: 'big.json', data: Buffer.from('x'.repeat(64)), declaredSizeOverride: 2048 }]);
    expect(() => readZipArchive(zip, LIMITS)).toThrow(/One file in the archive is larger than the import limit/);
  });

  it('refuses a total over the total cap', () => {
    const zip = buildZip([
      { name: 'a.json', data: Buffer.from('x'.repeat(900)) },
      { name: 'b.json', data: Buffer.from('x'.repeat(900)) },
      { name: 'c.json', data: Buffer.from('x'.repeat(900)) },
      { name: 'd.json', data: Buffer.from('x'.repeat(900)) },
      { name: 'e.json', data: Buffer.from('x'.repeat(900)) },
    ]);
    expect(() => readZipArchive(zip, LIMITS)).toThrow(/The archive is larger than the import limit/);
  });

  it('refuses more entries than the entry cap', () => {
    const entries = Array.from({ length: 11 }, (_, index) => ({
      name: `f${String(index)}.json`,
      data: Buffer.from('{}'),
    }));
    expect(() => readZipArchive(buildZip(entries), LIMITS)).toThrow(/too many files/);
  });

  it('refuses a zip64 entry count', () => {
    const zip = buildZip([{ name: 'a.json', data: Buffer.from('{}') }], { endRecord: { totalEntries: 0xffff } });
    expect(() => readZipArchive(zip, LIMITS)).toThrow(/not a valid export archive/);
  });

  it.each(['../evil.json', 'memory/../../evil.json', '/abs.json', 'memory\\evil.json', 'C:/evil.json'])(
    'refuses the unsafe path %s',
    name => {
      const zip = buildZip([{ name, data: Buffer.from('{}') }]);
      expect(() => readZipArchive(zip, LIMITS)).toThrow(/file path that is not allowed/);
    },
  );

  it('refuses duplicate entry names', () => {
    const zip = buildZip([
      { name: 'a.json', data: Buffer.from('1') },
      { name: 'a.json', data: Buffer.from('2') },
    ]);
    expect(() => readZipArchive(zip, LIMITS)).toThrow(/same file twice/);
  });

  it('refuses an entry whose CRC does not match its contents', () => {
    const zip = buildZip([{ name: 'a.json', data: Buffer.from('hello'), crcOverride: 12345 }]);
    expect(() => readZipArchive(zip, LIMITS)).toThrow(/checksum does not match/);
  });

  it('refuses encrypted entries', () => {
    const zip = buildZip([{ name: 'a.json', data: Buffer.from('hello'), flags: 0x1 }]);
    expect(() => readZipArchive(zip, LIMITS)).toThrow(/password-protected/);
  });

  it('refuses a file that is not a zip', () => {
    expect(() => readZipArchive(Buffer.from('definitely not a zip archive'), LIMITS)).toThrow(ZipArchiveError);
    expect(() => readZipArchive(Buffer.from('definitely not a zip archive'), LIMITS)).toThrow(
      /not a valid export archive/,
    );
  });

  it('refuses an empty file', () => {
    expect(() => readZipArchive(Buffer.alloc(0), LIMITS)).toThrow(/not a valid export archive/);
  });
});

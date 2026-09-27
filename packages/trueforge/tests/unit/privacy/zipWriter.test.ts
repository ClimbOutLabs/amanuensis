import { createZip, crc32 } from '../../../src/privacy/zipWriter';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface ParsedEntry {
  name: string;
  data: Uint8Array;
}

/** Minimal reader: walks local file headers and the central directory. */
function parseZip(zip: Uint8Array): { entries: ParsedEntry[]; centralCount: number } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries: ParsedEntry[] = [];
  let offset = 0;
  // An empty archive has no local headers and no central directory: just the EOCD.
  if (view.getUint32(0, true) === 0x06054b50) {
    return { entries, centralCount: 0 };
  }
  for (;;) {
    const signature = view.getUint32(offset, true);
    if (signature !== 0x04034b50) break;
    const nameLength = view.getUint16(offset + 26, true);
    const dataLength = view.getUint32(offset + 22, true);
    const storedCrc = view.getUint32(offset + 14, true);
    const name = decoder.decode(zip.subarray(offset + 30, offset + 30 + nameLength));
    const data = zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + dataLength);
    expect(storedCrc).toBe(crc32(data));
    entries.push({ name, data });
    offset += 30 + nameLength + dataLength;
  }
  expect(view.getUint32(offset, true)).toBe(0x02014b50);
  // End of central directory is the last 22 bytes (no archive comment is written).
  const eocd = zip.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  return { entries, centralCount: view.getUint16(eocd + 8, true) };
}

describe('createZip', () => {
  it('round-trips entries with names, data, and crc intact', () => {
    const zip = createZip([
      { name: 'chats.json', data: encoder.encode('{"a":1}') },
      { name: 'memory/n/MEMORY.md', data: encoder.encode('# memory') },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ]);
    const { entries, centralCount } = parseZip(zip);
    expect(centralCount).toBe(3);
    expect(entries.map(entry => entry.name)).toEqual(['chats.json', 'memory/n/MEMORY.md', 'empty.txt']);
    expect(decoder.decode(entries[0].data)).toBe('{"a":1}');
    expect(entries[2].data).toHaveLength(0);
  });

  it('produces an empty archive for no entries', () => {
    const { entries, centralCount } = parseZip(createZip([]));
    expect(entries).toHaveLength(0);
    expect(centralCount).toBe(0);
  });
});

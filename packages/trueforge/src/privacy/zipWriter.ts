/**
 * Minimal ZIP writer (stored method, no compression) for the privacy export.
 * Dependency-free on purpose: the export must work with zero new packages.
 * Output is a valid ZIP readable by any unzip tool.
 */

export interface ZipEntry {
  /** Archive path, e.g. `memory/default/MEMORY.md`. Forward slashes only. */
  name: string;
  data: Uint8Array;
  /** File modification time; defaults to now. */
  mtime?: Date;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
  return {
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  };
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/**
 * Builds a ZIP archive from in-memory entries. Duplicate names are kept as
 * given; callers own name uniqueness.
 */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map(entry => {
    const nameBytes = encoder.encode(entry.name);
    const { date, time } = dosDateTime(entry.mtime ?? new Date());
    return { entry, nameBytes, date, time, crc: crc32(entry.data) };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const p of prepared) {
    localSize += 30 + p.nameBytes.length + p.entry.data.length;
    centralSize += 46 + p.nameBytes.length;
  }
  const totalSize = localSize + centralSize + 22;
  const buffer = new ArrayBuffer(totalSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  let offset = 0;
  const centralOffsets: number[] = [];
  for (const p of prepared) {
    centralOffsets.push(offset);
    writeU32(view, offset, 0x04034b50); // local file header signature
    writeU16(view, offset + 4, 20); // version needed
    writeU16(view, offset + 6, 0x0800); // UTF-8 filename flag
    writeU16(view, offset + 8, 0); // stored method
    writeU16(view, offset + 10, p.time);
    writeU16(view, offset + 12, p.date);
    writeU32(view, offset + 14, p.crc);
    writeU32(view, offset + 18, p.entry.data.length);
    writeU32(view, offset + 22, p.entry.data.length);
    writeU16(view, offset + 26, p.nameBytes.length);
    writeU16(view, offset + 28, 0); // extra field length
    offset += 30;
    bytes.set(p.nameBytes, offset);
    offset += p.nameBytes.length;
    bytes.set(p.entry.data, offset);
    offset += p.entry.data.length;
  }

  const centralStart = offset;
  prepared.forEach((p, index) => {
    writeU32(view, offset, 0x02014b50); // central directory signature
    writeU16(view, offset + 4, 20); // version made by
    writeU16(view, offset + 6, 20); // version needed
    writeU16(view, offset + 8, 0x0800); // UTF-8 flag
    writeU16(view, offset + 10, 0); // stored
    writeU16(view, offset + 12, p.time);
    writeU16(view, offset + 14, p.date);
    writeU32(view, offset + 16, p.crc);
    writeU32(view, offset + 20, p.entry.data.length);
    writeU32(view, offset + 24, p.entry.data.length);
    writeU16(view, offset + 28, p.nameBytes.length);
    writeU16(view, offset + 30, 0); // extra
    writeU16(view, offset + 32, 0); // comment
    writeU16(view, offset + 34, 0); // disk number
    writeU16(view, offset + 36, 0); // internal attrs
    writeU32(view, offset + 38, 0); // external attrs
    writeU32(view, offset + 42, centralOffsets[index]); // local header offset
    offset += 46;
    bytes.set(p.nameBytes, offset);
    offset += p.nameBytes.length;
  });

  writeU32(view, offset, 0x06054b50); // end of central directory
  writeU16(view, offset + 4, 0);
  writeU16(view, offset + 6, 0);
  writeU16(view, offset + 8, prepared.length);
  writeU16(view, offset + 10, prepared.length);
  writeU32(view, offset + 12, centralSize);
  writeU32(view, offset + 16, centralStart);
  writeU16(view, offset + 18, 0); // comment length

  return bytes;
}

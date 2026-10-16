/**
 * Streaming ZIP writer (stored method, no compression) for the data export.
 *
 * Same on-disk format as the privacy export's in-memory writer
 * (`../privacy/zipWriter`), but entries are written incrementally: a local
 * header with the data-descriptor flag, the entry bytes as they are
 * produced, then a descriptor carrying the CRC and sizes. The central
 * directory is emitted at the end from the recorded offsets. Peak memory is
 * one producer chunk, so a multi-gigabyte archive never sits in RAM.
 *
 * A hard cap on total archive bytes is enforced on every write; exceeding
 * it aborts the archive (the caller destroys the response stream, so the
 * download fails visibly instead of truncating silently).
 */
import type { Writable } from 'node:stream';

export class ZipSizeCapExceededError extends Error {
  readonly capBytes: number;
  constructor(capBytes: number) {
    super(`Export archive exceeded the size cap of ${String(capBytes)} bytes`);
    this.name = 'ZipSizeCapExceededError';
    this.capBytes = capBytes;
  }
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

/** Incremental CRC-32 (same polynomial as `../privacy/zipWriter`). */
export class IncrementalCrc32 {
  #crc = 0xffffffff;

  update(data: Uint8Array): void {
    let crc = this.#crc;
    for (const byte of data) {
      const tableEntry = CRC_TABLE[(crc ^ byte) & 0xff];
      if (tableEntry === undefined) {
        throw new Error('IncrementalCrc32: CRC table lookup failed');
      }
      crc = tableEntry ^ (crc >>> 8);
    }
    this.#crc = crc;
  }

  digest(): number {
    return (this.#crc ^ 0xffffffff) >>> 0;
  }
}

interface CentralEntry {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  localHeaderOffset: number;
  dosDate: number;
  dosTime: number;
}

function dosDateTime(date: Date): { date: number; time: number } {
  return {
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  };
}

/** Sink for one entry's bytes; the writer owns CRC, sizes, and the cap. */
export interface ZipEntrySink {
  write(chunk: Uint8Array): Promise<void>;
  writeText(text: string): Promise<void>;
}

export class ZipStreamWriter {
  readonly #out: Writable;
  readonly #capBytes: number;
  readonly #encoder = new TextEncoder();
  #bytesWritten = 0;
  #offset = 0;
  #central: CentralEntry[] = [];
  #openEntry: { crc: IncrementalCrc32; size: number; name: string } | undefined;
  #finished = false;

  constructor(out: Writable, options: { maxBytes: number }) {
    this.#out = out;
    this.#capBytes = options.maxBytes;
  }

  get bytesWritten(): number {
    return this.#bytesWritten;
  }

  async #writeRaw(data: Uint8Array): Promise<void> {
    this.#bytesWritten += data.byteLength;
    if (this.#bytesWritten > this.#capBytes) {
      throw new ZipSizeCapExceededError(this.#capBytes);
    }
    this.#offset += data.byteLength;
    if (!this.#out.write(data)) {
      await new Promise<void>((resolve, reject) => {
        this.#out.once('drain', resolve);
        this.#out.once('error', reject);
      });
    }
  }

  /**
   * Opens an entry and streams its content from `produce`. The producer
   * writes through the sink; returning closes the entry and writes its data
   * descriptor.
   */
  async addEntry(name: string, produce: (sink: ZipEntrySink) => Promise<void>): Promise<void> {
    if (this.#finished) {
      throw new Error('ZipStreamWriter: archive already finished');
    }
    if (this.#openEntry !== undefined) {
      throw new Error('ZipStreamWriter: entries cannot nest');
    }
    const nameBytes = this.#encoder.encode(name);
    const { date, time } = dosDateTime(new Date());
    const localHeaderOffset = this.#offset;
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); // local file header signature
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0x0808, true); // UTF-8 filename + data descriptor flags
    header.setUint16(8, 0, true); // stored method
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    // CRC and sizes are zero here; the data descriptor after the entry data carries them.
    header.setUint16(26, nameBytes.length, true);
    await this.#writeRaw(new Uint8Array(header.buffer));
    await this.#writeRaw(nameBytes);

    const state = { crc: new IncrementalCrc32(), size: 0, name };
    this.#openEntry = state;
    const sink: ZipEntrySink = {
      write: async (chunk: Uint8Array) => {
        state.crc.update(chunk);
        state.size += chunk.byteLength;
        await this.#writeRaw(chunk);
      },
      writeText: async (text: string) => {
        await sink.write(this.#encoder.encode(text));
      },
    };
    try {
      await produce(sink);
    } finally {
      this.#openEntry = undefined;
    }
    const crc = state.crc.digest();
    const descriptor = new DataView(new ArrayBuffer(16));
    descriptor.setUint32(0, 0x08074b50, true); // data descriptor signature
    descriptor.setUint32(4, crc, true);
    descriptor.setUint32(8, state.size, true);
    descriptor.setUint32(12, state.size, true);
    await this.#writeRaw(new Uint8Array(descriptor.buffer));
    this.#central.push({ nameBytes, crc, size: state.size, localHeaderOffset, dosDate: date, dosTime: time });
  }

  /** Convenience for small entries held in memory (manifest, settings). */
  async addBufferedEntry(name: string, data: Uint8Array): Promise<void> {
    await this.addEntry(name, async sink => {
      await sink.write(data);
    });
  }

  async addTextEntry(name: string, text: string): Promise<void> {
    await this.addBufferedEntry(name, this.#encoder.encode(text));
  }

  /** Writes the central directory and end record. Call exactly once. */
  async finish(): Promise<void> {
    if (this.#finished) {
      throw new Error('ZipStreamWriter: archive already finished');
    }
    this.#finished = true;
    const centralStart = this.#offset;
    for (const entry of this.#central) {
      const record = new DataView(new ArrayBuffer(46));
      record.setUint32(0, 0x02014b50, true); // central directory signature
      record.setUint16(4, 20, true); // version made by
      record.setUint16(6, 20, true); // version needed
      record.setUint16(8, 0x0808, true); // UTF-8 + data descriptor flags
      record.setUint16(10, 0, true); // stored
      record.setUint16(12, entry.dosTime, true);
      record.setUint16(14, entry.dosDate, true);
      record.setUint32(16, entry.crc, true);
      record.setUint32(20, entry.size, true);
      record.setUint32(24, entry.size, true);
      record.setUint16(28, entry.nameBytes.length, true);
      record.setUint32(42, entry.localHeaderOffset, true);
      await this.#writeRaw(new Uint8Array(record.buffer));
      await this.#writeRaw(entry.nameBytes);
    }
    const centralSize = this.#offset - centralStart;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); // end of central directory
    end.setUint16(8, this.#central.length, true);
    end.setUint16(10, this.#central.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralStart, true);
    await this.#writeRaw(new Uint8Array(end.buffer));
  }
}

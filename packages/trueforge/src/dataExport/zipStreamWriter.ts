/**
 * Streaming ZIP writer (stored method, no compression) for the data export.
 *
 * Each entry is a local header with the data-descriptor flag, the entry bytes
 * as they are produced, then a descriptor carrying the CRC and sizes; the
 * central directory is emitted at the end from the recorded offsets. Peak
 * memory is one producer chunk, so a multi-gigabyte archive never sits in RAM.
 *
 * Classic ZIP only (no ZIP64), so the archive is capped below 4 GiB and holds
 * fewer than 65535 entries; both limits fail with a plain error instead of
 * writing an archive that readers would misparse. Each entry is also held to
 * the per-file limit import reads with. Exceeding a cap aborts the archive
 * and the caller fails the response.
 */
import type { Writable } from 'node:stream';
import { crc32 } from 'node:zlib';

import { ARCHIVE_MAX_ENTRY_BYTES, formatArchiveBytes } from './archiveLimits';

/** 0xFFFFFFFF marks ZIP64 in offset and size fields, so classic ZIP stops one short of 4 GiB. */
export const ZIP_MAX_ARCHIVE_BYTES = 0xffff_fffe;

/** The 16-bit entry count reserves 0xFFFF as the ZIP64 marker. */
export const ZIP_MAX_ENTRIES = 0xfffe;

export class ZipSizeCapExceededError extends Error {
  readonly capBytes: number;
  constructor(capBytes: number) {
    super(
      `The export is over its ${formatArchiveBytes(capBytes)} limit (DATA_EXPORT_MAX_BYTES). An import takes the same size by default. Leave uploaded files out, then export again.`,
    );
    this.name = 'ZipSizeCapExceededError';
    this.capBytes = capBytes;
  }
}

export class ZipEntryLimitExceededError extends Error {
  constructor() {
    super(
      `The export has more than ${String(ZIP_MAX_ENTRIES)} files, which a zip archive cannot hold. Leave uploaded files out.`,
    );
    this.name = 'ZipEntryLimitExceededError';
  }
}

/** One file would be over the per-file cap, which import would refuse. */
export class ZipEntrySizeCapExceededError extends Error {
  constructor({ subject, capBytes, bytes }: { subject: string; capBytes: number; bytes?: number }) {
    const size = bytes === undefined ? 'over' : `${formatArchiveBytes(bytes)}, over`;
    super(
      `${subject} is ${size} the ${formatArchiveBytes(capBytes)} limit for one file in an export. Delete some long chats you no longer need, then export again.`,
    );
    this.name = 'ZipEntrySizeCapExceededError';
  }
}

/** The destination closed (for example the client went away) before the archive was complete. */
export class ZipOutputClosedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The export destination closed before the archive was complete.', options);
    this.name = 'ZipOutputClosedError';
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

/**
 * A safe relative archive path: forward slashes only, no drive letter, no
 * leading slash, no empty, `.` or `..` segments, no control characters.
 */
export function normalizeZipEntryName(rawName: string): string {
  let printable = '';
  for (const char of rawName) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) {
      printable += char;
    }
  }
  const segments = printable
    .replace(/\\/g, '/')
    .split('/')
    // A drive designator (`C:`) only ever means something to the extracting machine.
    .map(segment => segment.replace(/^[A-Za-z]:/, ''))
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..');
  return segments.length > 0 ? segments.join('/') : 'file';
}

/** `notes.txt` becomes `notes (2).txt`; the suffix goes before the last extension of the last segment. */
function withCollisionSuffix({ name, ordinal }: { name: string; ordinal: number }): string {
  const slash = name.lastIndexOf('/');
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > slash + 1;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : '';
  return `${stem} (${String(ordinal)})${extension}`;
}

/** Sink for one entry's bytes; the writer owns CRC, sizes, and the cap. */
export interface ZipEntrySink {
  write(chunk: Uint8Array): Promise<void>;
  writeText(text: string): Promise<void>;
}

/** Resolves on drain; rejects if the stream errors or closes first. Always removes its listeners. */
function waitForDrain(out: Writable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      out.off('drain', onDrain);
      out.off('error', onError);
      out.off('close', onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new ZipOutputClosedError({ cause: error }));
    };
    const onClose = (): void => {
      cleanup();
      reject(new ZipOutputClosedError());
    };
    out.on('drain', onDrain);
    out.on('error', onError);
    out.on('close', onClose);
  });
}

export class ZipStreamWriter {
  readonly #out: Writable;
  readonly #capBytes: number;
  readonly #entryCapBytes: number;
  readonly #encoder = new TextEncoder();
  readonly #usedNames = new Set<string>();
  #bytesWritten = 0;
  #offset = 0;
  #central: CentralEntry[] = [];
  #openEntry = false;
  #finished = false;

  constructor(out: Writable, options: { maxBytes: number; maxEntryBytes?: number | undefined }) {
    this.#out = out;
    this.#capBytes = Math.min(options.maxBytes, ZIP_MAX_ARCHIVE_BYTES);
    this.#entryCapBytes = options.maxEntryBytes ?? ARCHIVE_MAX_ENTRY_BYTES;
  }

  /** Largest single entry this archive may hold. */
  get maxEntryBytes(): number {
    return this.#entryCapBytes;
  }

  get bytesWritten(): number {
    return this.#bytesWritten;
  }

  /** Entries written so far. */
  get entryCount(): number {
    return this.#central.length;
  }

  async #writeRaw(data: Uint8Array): Promise<void> {
    if (this.#out.destroyed) {
      throw new ZipOutputClosedError();
    }
    this.#bytesWritten += data.byteLength;
    if (this.#bytesWritten > this.#capBytes) {
      throw new ZipSizeCapExceededError(this.#capBytes);
    }
    this.#offset += data.byteLength;
    if (!this.#out.write(data)) {
      await waitForDrain(this.#out);
    }
  }

  /** Normalized and unique ignoring case, so extraction onto a case-insensitive disk cannot overwrite an entry. */
  #claimName(rawName: string): string {
    const normalized = normalizeZipEntryName(rawName);
    let candidate = normalized;
    let ordinal = 1;
    while (this.#usedNames.has(candidate.toLowerCase())) {
      ordinal += 1;
      candidate = withCollisionSuffix({ name: normalized, ordinal });
    }
    this.#usedNames.add(candidate.toLowerCase());
    return candidate;
  }

  /**
   * Opens an entry and streams its content from `produce`. The producer
   * writes through the sink; returning closes the entry and writes its data
   * descriptor. Returns the name the entry was stored under.
   */
  async addEntry(name: string, produce: (sink: ZipEntrySink) => Promise<void>): Promise<string> {
    if (this.#finished) {
      throw new Error('ZipStreamWriter: archive already finished');
    }
    if (this.#openEntry) {
      throw new Error('ZipStreamWriter: entries cannot nest');
    }
    if (this.#central.length >= ZIP_MAX_ENTRIES) {
      throw new ZipEntryLimitExceededError();
    }
    const storedName = this.#claimName(name);
    const nameBytes = this.#encoder.encode(storedName);
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

    const state = { crc: 0, size: 0 };
    this.#openEntry = true;
    const sink: ZipEntrySink = {
      write: async (chunk: Uint8Array) => {
        if (state.size + chunk.byteLength > this.#entryCapBytes) {
          throw new ZipEntrySizeCapExceededError({ subject: storedName, capBytes: this.#entryCapBytes });
        }
        state.crc = crc32(chunk, state.crc);
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
      this.#openEntry = false;
    }
    const descriptor = new DataView(new ArrayBuffer(16));
    descriptor.setUint32(0, 0x08074b50, true); // data descriptor signature
    descriptor.setUint32(4, state.crc, true);
    descriptor.setUint32(8, state.size, true);
    descriptor.setUint32(12, state.size, true);
    await this.#writeRaw(new Uint8Array(descriptor.buffer));
    this.#central.push({
      nameBytes,
      crc: state.crc,
      size: state.size,
      localHeaderOffset,
      dosDate: date,
      dosTime: time,
    });
    return storedName;
  }

  /** Convenience for small entries held in memory (manifest, settings). */
  async addBufferedEntry(name: string, data: Uint8Array): Promise<string> {
    return this.addEntry(name, async sink => {
      await sink.write(data);
    });
  }

  async addTextEntry(name: string, text: string): Promise<string> {
    return this.addBufferedEntry(name, this.#encoder.encode(text));
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

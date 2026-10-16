/**
 * Strict ZIP reader for data import archives.
 *
 * Reads the central directory first and checks every entry against the size
 * caps and the path rules before a single byte is extracted, so a hostile
 * archive (traversal paths, zip bombs, encrypted or zip64 entries) is
 * refused up front rather than mid-write. Only stored and deflated entries
 * are supported, which covers both Aman's own export writer and any standard
 * re-zip of an export.
 */
import { inflateRawSync } from 'node:zlib';

import { IncrementalCrc32 } from '../dataExport/zipStreamWriter';

export class ZipArchiveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ZipArchiveError';
  }
}

export interface ZipArchiveLimits {
  /** Max uncompressed bytes for any single entry. */
  maxEntryBytes: number;
  /** Max uncompressed bytes across all entries. */
  maxTotalBytes: number;
  /** Max number of file entries. */
  maxEntries: number;
}

export interface ZipArchiveEntry {
  name: string;
  data: Buffer;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_RECORD_SIGNATURE = 0x02014b50;
const END_RECORD_SIGNATURE = 0x06054b50;
const ZIP64_SENTINEL = 0xffffffff;

function invalidArchive(): ZipArchiveError {
  return new ZipArchiveError('The file is not a valid export archive.');
}

/** A safe archive path: relative, forward slashes only, no traversal or empty segments. */
function assertSafeEntryName(name: string): void {
  const unsafe =
    name.length === 0 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    /^[a-zA-Z]:/.test(name) ||
    name.split('/').some(segment => segment === '' || segment === '.' || segment === '..');
  if (unsafe) {
    throw new ZipArchiveError('The archive contains a file path that is not allowed.');
  }
}

interface CentralEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

function findEndRecord(bytes: Buffer): number {
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_RECORD_SIGNATURE) {
      const commentLength = bytes.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === bytes.length) {
        return offset;
      }
    }
  }
  throw invalidArchive();
}

function readCentralDirectory(bytes: Buffer, limits: ZipArchiveLimits): CentralEntry[] {
  const endOffset = findEndRecord(bytes);
  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entryCount === 0xffff ||
    centralSize === ZIP64_SENTINEL ||
    centralOffset === ZIP64_SENTINEL
  ) {
    throw invalidArchive();
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipArchiveError('The archive contains too many files.');
  }
  if (centralOffset + centralSize > bytes.length) {
    throw invalidArchive();
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: CentralEntry[] = [];
  const seenNames = new Set<string>();
  let totalBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_RECORD_SIGNATURE) {
      throw invalidArchive();
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const startDisk = bytes.readUInt16LE(offset + 34);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    if (
      startDisk !== 0 ||
      compressedSize === ZIP64_SENTINEL ||
      size === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      throw invalidArchive();
    }
    if (flags & 0x1) {
      throw new ZipArchiveError('The archive is password-protected, so it cannot be imported.');
    }
    if (method !== 0 && method !== 8) {
      throw invalidArchive();
    }
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) {
      throw invalidArchive();
    }
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(nameStart, nameEnd));
    } catch (cause) {
      throw new ZipArchiveError('The archive contains a file name that cannot be read.', { cause });
    }
    offset = nameEnd + extraLength + commentLength;

    if (name.endsWith('/')) {
      continue; // Directory entry: no content to import.
    }
    assertSafeEntryName(name);
    if (seenNames.has(name)) {
      throw new ZipArchiveError('The archive contains the same file twice.');
    }
    seenNames.add(name);
    if (size > limits.maxEntryBytes) {
      throw new ZipArchiveError('One file in the archive is larger than the import limit.');
    }
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ZipArchiveError('The archive is larger than the import limit.');
    }
    entries.push({ name, method, crc, compressedSize, size, localHeaderOffset });
  }
  return entries;
}

function extractEntry(bytes: Buffer, entry: CentralEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== LOCAL_HEADER_SIGNATURE) {
    throw invalidArchive();
  }
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) {
    throw invalidArchive();
  }
  const compressed = bytes.subarray(dataStart, dataEnd);
  let data: Buffer;
  if (entry.method === 0) {
    data = Buffer.from(compressed);
  } else {
    try {
      data = inflateRawSync(compressed, { maxOutputLength: entry.size });
    } catch (cause) {
      throw new ZipArchiveError('One file in the archive could not be unpacked.', { cause });
    }
  }
  if (data.byteLength !== entry.size) {
    throw invalidArchive();
  }
  const crc = new IncrementalCrc32();
  crc.update(data);
  if (crc.digest() !== entry.crc) {
    throw new ZipArchiveError('One file in the archive is damaged (its checksum does not match).');
  }
  return data;
}

/**
 * Reads a whole archive into memory, enforcing the limits from the central
 * directory before extraction and again as bytes land. Callers cap the
 * upload itself first, so the archive bytes are already bounded.
 */
export function readZipArchive(bytes: Buffer, limits: ZipArchiveLimits): ZipArchiveEntry[] {
  const central = readCentralDirectory(bytes, limits);
  return central.map(entry => ({ name: entry.name, data: extractEntry(bytes, entry) }));
}

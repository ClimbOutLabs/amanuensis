/**
 * Minimal stored-method ZIP reader for export tests: walks the central
 * directory (the streaming writer's entries carry data descriptors, so
 * local headers alone do not know the sizes) and verifies each entry's CRC.
 */
import { crc32 } from '../../src/privacy/zipWriter';

export interface ZipEntryData {
  name: string;
  data: Buffer;
}

export function readZipEntries(bytes: Buffer): ZipEntryData[] {
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Not a complete zip archive: no end of central directory record.');
  }
  const count = bytes.readUInt16LE(eocdOffset + 10);
  let offset = bytes.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntryData[] = [];
  for (let n = 0; n < count; n += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Malformed central directory.');
    }
    const crc = bytes.readUInt32LE(offset + 16);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = Buffer.from(bytes.subarray(dataStart, dataStart + size));
    if (crc32(data) !== crc) {
      throw new Error(`CRC mismatch for zip entry ${name}.`);
    }
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function zipEntryText(entries: readonly ZipEntryData[], name: string): string {
  const entry = entries.find(candidate => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`Zip entry ${name} not found (have: ${entries.map(candidate => candidate.name).join(', ')}).`);
  }
  return entry.data.toString('utf8');
}

export function zipEntryJson(entries: readonly ZipEntryData[], name: string): unknown {
  return JSON.parse(zipEntryText(entries, name));
}

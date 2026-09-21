import { createHash } from 'node:crypto';

/**
 * RFC 4122 version-5 UUID (namespace + name, SHA-1 based). The `uuid` package
 * is not a dependency of this workspace, so this implements the algorithm
 * directly on top of node:crypto rather than adding a dependency for one call
 * site. Named parameters rather than positional ones: `name` and `namespace`
 * are both plain strings, so positional arguments are easy to swap by mistake
 * at a call site without either the compiler or a reviewer catching it.
 */
export function uuidv5(params: { name: string; namespace: string }): string {
  const namespaceBytes = parseUuid(params.namespace);
  const nameBytes = Buffer.from(params.name, 'utf8');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, nameBytes]))
    .digest();
  const bytes = hash.subarray(0, 16);
  // Version 5 (top nibble of byte 6).
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  // RFC 4122 variant (top two bits of byte 8).
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function parseUuid(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID namespace: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

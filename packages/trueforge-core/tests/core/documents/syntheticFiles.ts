/** Invented file bytes with real headers, so the extractor's magic-byte checks pass without any checked-in binaries. */

/** A PNG header of the given size; the body is not a decodable image. */
export function syntheticPng({ width = 64, height = 32 }: { width?: number; height?: number } = {}): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

export function syntheticPdf(): Buffer {
  return Buffer.from('%PDF-1.4\n% synthetic\n', 'latin1');
}

/** Bytes that match the type a path's extension names. */
export function syntheticBytesFor(path: string): Buffer {
  return path.toLowerCase().endsWith('.pdf') ? syntheticPdf() : syntheticPng();
}

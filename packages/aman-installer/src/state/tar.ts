// The smallest tar (ustar) reader and writer that covers the state home:
// small text files and the folders above them, with names well under the
// 100-byte header field. The volume backend reads the state as one tar
// stream and writes changed files back as one, the same shape the shell's
// backup code already uses for volumes.

export interface TarFile {
  path: string;
  mode: number;
  text: string;
}

const BLOCK = 512;

function octalField(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function headerBlock(options: { name: string; mode: number; size: number; type: string }): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const encoder = new TextEncoder();
  const put = (offset: number, text: string) => {
    block.set(encoder.encode(text).subarray(0, BLOCK), offset);
  };
  put(0, options.name);
  put(100, octalField(options.mode, 8));
  put(108, octalField(0, 8));
  put(116, octalField(0, 8));
  put(124, octalField(options.size, 12));
  put(136, octalField(0, 12));
  block.fill(0x20, 148, 156);
  put(156, options.type);
  put(257, 'ustar\0');
  put(263, '00');
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function paddedLength(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

// Folders above each file are added once, at mode 700, the way the shell
// makes state folders; files carry the mode they are given.
export function buildTar(files: readonly TarFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const folders = new Set<string>();
  const addFolder = (path: string) => {
    if (folders.has(path)) {
      return;
    }
    folders.add(path);
    parts.push(headerBlock({ name: `${path}/`, mode: 0o700, size: 0, type: '5' }));
  };
  for (const file of files) {
    if (file.path.length > 100) {
      throw new Error(`state file name is too long for the volume stream: ${file.path}`);
    }
    const segments = file.path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      addFolder(segments.slice(0, depth).join('/'));
    }
    const data = encoder.encode(file.text);
    parts.push(headerBlock({ name: file.path, mode: file.mode, size: data.length, type: '0' }));
    parts.push(data);
    const pad = paddedLength(data.length) - data.length;
    if (pad > 0) {
      parts.push(new Uint8Array(pad));
    }
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function fieldText(block: Uint8Array, offset: number, width: number): string {
  let end = offset;
  while (end < offset + width && block[end] !== 0) {
    end += 1;
  }
  return new TextDecoder().decode(block.subarray(offset, end));
}

// Reads file entries into a path-to-text map. Folder entries and archive
// metadata (long names, pax headers) are handled or stepped over; a stream
// that ends early (a read that named a folder the state does not have yet)
// still gives back the files that did arrive.
export function parseTar(bytes: Uint8Array): Map<string, string> {
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  let longName: string | null = null;
  while (offset + BLOCK <= bytes.length) {
    const block = bytes.subarray(offset, offset + BLOCK);
    if (block.every(byte => byte === 0)) {
      break;
    }
    const name = fieldText(block, 0, 100);
    const prefix = fieldText(block, 345, 155);
    const sizeText = fieldText(block, 124, 12).trim();
    const size = Number.parseInt(sizeText, 8);
    if (Number.isNaN(size)) {
      break;
    }
    const type = String.fromCharCode(block[156] ?? 0);
    const dataStart = offset + BLOCK;
    const data = bytes.subarray(dataStart, dataStart + size);
    offset = dataStart + paddedLength(size);
    if (type === 'L') {
      longName = decoder.decode(data).replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'x' || type === 'g' || type === '5') {
      continue;
    }
    if (type === '0' || type === '\0' || type === '') {
      const fullName = longName ?? (prefix !== '' ? `${prefix}/${name}` : name);
      longName = null;
      files.set(fullName, decoder.decode(data));
    }
  }
  return files;
}

/** What a git bundle claims to contain, read from its text header before any object is unpacked. */
export interface BundleHeader {
  /** Object ids the receiver must already have. */
  prerequisites: string[];
  /** Ref names and the commits they point at. */
  refs: { name: string; oid: string }[];
}

const HEADER_LINE_LIMIT = 64 * 1024;
const OID = /^[0-9a-f]{40}$/u;

/** ASCII control characters, built from code points so the pattern itself holds none. */
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'u',
);

function hasControlCharacter(text: string): boolean {
  return CONTROL_CHARACTERS.test(text);
}

export type BundleHeaderResult = { ok: true; header: BundleHeader } | { ok: false; reason: string };

/**
 * Parses the header of a v2 or v3 bundle (sha1 only). Anything unexpected, including capabilities other than
 * the sha1 object format, is refused: the host unpacks only what it has understood completely.
 */
export function parseBundleHeader(bytes: Buffer): BundleHeaderResult {
  const head = bytes.subarray(0, HEADER_LINE_LIMIT).toString('latin1');
  const end = head.indexOf('\n\n');
  if (end === -1) {
    return { ok: false, reason: 'the bundle header is missing or too long' };
  }
  const lines = head.slice(0, end).split('\n');
  const signature = lines.shift();
  if (signature !== '# v2 git bundle' && signature !== '# v3 git bundle') {
    return { ok: false, reason: 'the file is not a git bundle' };
  }
  const header: BundleHeader = { prerequisites: [], refs: [] };
  for (const line of lines) {
    if (line.startsWith('@')) {
      if (line !== '@object-format=sha1') {
        return { ok: false, reason: `the bundle uses an unsupported capability (${line.slice(0, 40)})` };
      }
      continue;
    }
    if (line.startsWith('-')) {
      const oid = line.slice(1, 41);
      if (!OID.test(oid)) {
        return { ok: false, reason: 'the bundle has a malformed prerequisite' };
      }
      header.prerequisites.push(oid);
      continue;
    }
    const oid = line.slice(0, 40);
    const name = line.slice(41);
    if (!OID.test(oid) || line[40] !== ' ' || name === '' || hasControlCharacter(name)) {
      return { ok: false, reason: 'the bundle has a malformed ref line' };
    }
    header.refs.push({ name, oid });
  }
  return { ok: true, header };
}

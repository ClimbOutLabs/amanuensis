import { createHash } from 'node:crypto';

// The release manifest: one JSON record a release carries beside its
// downloads. It holds the SHA-256 of every download and the image tags
// the shell computes from the checkout, so an install from a source
// archive with no git gets the same tags as a clone.

export interface SourceIds {
  'aman-app': string;
  'aman-stt': string;
  'aman-calendar-caldav': string;
}

export interface ReleaseManifest {
  schema: 1;
  release: string;
  files: Record<string, string>;
  sourceIds: SourceIds;
}

const SOURCE_ID_KEYS: readonly (keyof SourceIds)[] = ['aman-app', 'aman-stt', 'aman-calendar-caldav'];
const SHA256_HEX = /^[a-f0-9]{64}$/;

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function buildManifest({
  release,
  files,
  sourceIds,
}: {
  release: string;
  files: readonly { name: string; data: Uint8Array }[];
  sourceIds: SourceIds;
}): ReleaseManifest {
  const hashed: Record<string, string> = {};
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const file of sorted) {
    hashed[file.name] = sha256Hex(file.data);
  }
  return { schema: 1, release, files: hashed, sourceIds };
}

// The signed bytes are exactly this text: fixed field order, file names
// sorted, two space indent, one trailing newline. Anything that builds
// or checks a manifest goes through here so the bytes cannot drift.
export function manifestToBytes(manifest: ReleaseManifest): Uint8Array {
  const files: Record<string, string> = {};
  for (const name of Object.keys(manifest.files).sort()) {
    const hash = manifest.files[name];
    if (hash !== undefined) {
      files[name] = hash;
    }
  }
  const ordered: ReleaseManifest = {
    schema: 1,
    release: manifest.release,
    files,
    sourceIds: {
      'aman-app': manifest.sourceIds['aman-app'],
      'aman-stt': manifest.sourceIds['aman-stt'],
      'aman-calendar-caldav': manifest.sourceIds['aman-calendar-caldav'],
    },
  };
  return new TextEncoder().encode(`${JSON.stringify(ordered, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

export function parseManifest(bytes: Uint8Array): ReleaseManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed['schema'] !== 1) {
    return null;
  }
  const release = stringField(parsed, 'release');
  if (release === null || release.length === 0) {
    return null;
  }
  const rawFiles = parsed['files'];
  if (!isRecord(rawFiles)) {
    return null;
  }
  const files: Record<string, string> = {};
  for (const [name, hash] of Object.entries(rawFiles)) {
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
      return null;
    }
    files[name] = hash;
  }
  const rawIds = parsed['sourceIds'];
  if (!isRecord(rawIds)) {
    return null;
  }
  const ids: Partial<Record<keyof SourceIds, string>> = {};
  for (const key of SOURCE_ID_KEYS) {
    const value = stringField(rawIds, key);
    if (value === null || value.length === 0) {
      return null;
    }
    ids[key] = value;
  }
  const app = ids['aman-app'];
  const stt = ids['aman-stt'];
  const calendar = ids['aman-calendar-caldav'];
  if (app === undefined || stt === undefined || calendar === undefined) {
    return null;
  }
  return {
    schema: 1,
    release,
    files,
    sourceIds: { 'aman-app': app, 'aman-stt': stt, 'aman-calendar-caldav': calendar },
  };
}

export function sourceIdKeys(): readonly (keyof SourceIds)[] {
  return SOURCE_ID_KEYS;
}

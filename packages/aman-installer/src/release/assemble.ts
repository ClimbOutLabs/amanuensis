import { sourceIdKeys, type ReleaseManifest, type SourceIds } from './manifest.ts';

// The assembly of one release record from the per-system partial
// records. The release build runs once per system and each run records
// only the files it made; this step joins the partial records into the
// one record a release is checked against as a whole. It refuses, with
// the reason as a plain line for the release tool to print, whenever a
// system's build is missing, two records disagree about a file, or a
// record's image names are not this checkout's.

const SYSTEMS: readonly { name: string; prefix: string }[] = [
  { name: 'Windows', prefix: 'aman-windows-' },
  { name: 'Mac', prefix: 'aman-darwin-' },
  { name: 'Linux', prefix: 'aman-linux-' },
];

export function assembleManifests({
  parts,
  expectedSourceIds,
}: {
  parts: readonly ReleaseManifest[];
  expectedSourceIds: SourceIds;
}): { manifest: ReleaseManifest } | { problem: string } {
  const first = parts[0];
  if (first === undefined) {
    return { problem: 'No partial release records were given, so there is nothing to assemble.' };
  }
  for (const part of parts) {
    if (part.release !== first.release) {
      return {
        problem: `The partial records are for different releases: ${first.release} and ${part.release}.`,
      };
    }
    for (const key of sourceIdKeys()) {
      if (part.sourceIds[key] !== expectedSourceIds[key]) {
        return { problem: 'A partial record names different images than this checkout does.' };
      }
    }
  }
  const files: Record<string, string> = {};
  for (const part of parts) {
    for (const [name, hash] of Object.entries(part.files)) {
      const existing = files[name];
      if (existing !== undefined && existing !== hash) {
        return { problem: `Two partial records disagree about the file ${name}.` };
      }
      files[name] = hash;
    }
  }
  for (const system of SYSTEMS) {
    if (!Object.keys(files).some(name => name.startsWith(system.prefix))) {
      return { problem: `The ${system.name} build is missing from the partial records.` };
    }
  }
  const archives = Object.keys(files).filter(name => name.endsWith('.tar.gz'));
  if (archives.length === 0) {
    return { problem: 'The source archive is missing from the partial records.' };
  }
  if (archives.length > 1) {
    return { problem: 'The partial records carry more than one source archive.' };
  }
  return { manifest: { schema: 1, release: first.release, files, sourceIds: expectedSourceIds } };
}

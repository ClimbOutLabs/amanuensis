import type { Problem } from '../messages.ts';
import type { ReleaseManifest } from './manifest.ts';
import { checkDownloadedFile, checkSignedManifest } from './verify.ts';

// Where releases are published. The newest release record is fetched
// first and checked against the release key before anything in it is
// trusted; the files themselves are then fetched from that record's own
// release, so a record can never point the update at another release.
const RELEASE_BASE = 'https://github.com/ClimbOutLabs/amanuensis/releases';

// What one fetch can come back with: the bytes themselves; an answer
// from the page that is not the file, which is what a release that is
// not there yet looks like; or nothing at all, when no answer arrived.
// The two failures are kept apart because they are different news for
// the person: one says the page answered, the other says it did not,
// and only the second can be the person's connection.
export type FetchBytesResult = { data: Uint8Array } | { missing: true } | { unreachable: true };

// Fetches one address and answers with what came back. A test answers
// from its own table; the shipped fetcher below follows the release
// page's redirects.
export type FetchBytes = (url: string) => Promise<FetchBytesResult>;

export async function fetchBytesFromNetwork(url: string): Promise<FetchBytesResult> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch {
    return { unreachable: true };
  }
  if (!response.ok) {
    return { missing: true };
  }
  try {
    return { data: new Uint8Array(await response.arrayBuffer()) };
  } catch {
    return { unreachable: true };
  }
}

export type LatestManifestResult =
  { manifest: ReleaseManifest } | { problem: Problem } | { missing: true } | { unreachable: true };

// The newest release record: manifest.json and its signature, both from
// the latest release, checked by the one signature check the verify
// command uses. A record that fails is refused with its Problem; there
// is no fallback to an older record.
export async function fetchLatestManifest({
  fetchBytes,
  publicKeyBase64,
}: {
  fetchBytes: FetchBytes;
  publicKeyBase64?: string;
}): Promise<LatestManifestResult> {
  const manifestResult = await fetchBytes(`${RELEASE_BASE}/latest/download/manifest.json`);
  const signatureResult = await fetchBytes(`${RELEASE_BASE}/latest/download/manifest.json.minisig`);
  if ('unreachable' in manifestResult || 'unreachable' in signatureResult) {
    return { unreachable: true };
  }
  if ('missing' in manifestResult || 'missing' in signatureResult) {
    return { missing: true };
  }
  const checked = checkSignedManifest({
    manifestBytes: manifestResult.data,
    signatureText: new TextDecoder().decode(signatureResult.data),
    ...(publicKeyBase64 === undefined ? {} : { publicKeyBase64 }),
  });
  if ('problem' in checked) {
    return { problem: checked.problem };
  }
  return { manifest: checked.manifest };
}

export type ReleaseFileResult = { data: Uint8Array } | { problem: Problem } | { missing: true } | { unreachable: true };

// One file of the release the record names, checked against the record
// before it is used for anything.
export async function fetchReleaseFile({
  fetchBytes,
  manifest,
  name,
}: {
  fetchBytes: FetchBytes;
  manifest: ReleaseManifest;
  name: string;
}): Promise<ReleaseFileResult> {
  const result = await fetchBytes(`${RELEASE_BASE}/download/${manifest.release}/${name}`);
  if ('unreachable' in result) {
    return { unreachable: true };
  }
  if ('missing' in result) {
    return { missing: true };
  }
  const problem = checkDownloadedFile({ manifest, fileName: name, data: result.data });
  if (problem !== null) {
    return { problem };
  }
  return { data: result.data };
}

// The one source archive a release carries: the file the update unpacks
// and installs from. A record with none, or more than one, is not a
// record an update can run from.
export function sourceArchiveName(manifest: ReleaseManifest): string | null {
  const names = Object.keys(manifest.files).filter(name => name.endsWith('.tar.gz'));
  if (names.length !== 1) {
    return null;
  }
  return names[0] ?? null;
}

export function windowsAssetName(arch: string): string {
  return `aman-windows-${arch}.exe`;
}

import type { Problem } from '../messages.ts';
import type { ReleaseManifest } from './manifest.ts';
import { checkDownloadedFile, checkSignedManifest } from './verify.ts';

// Where releases are published. The newest release record is fetched
// first and checked against the release key before anything in it is
// trusted; the files themselves are then fetched from that record's own
// release, so a record can never point the update at another release.
const RELEASE_BASE = 'https://github.com/ClimbOutLabs/amanuensis/releases';

// Fetches one address and answers its bytes, or null when the bytes do
// not arrive whole. A test answers from its own table; the shipped
// fetcher below follows the release page's redirects.
export type FetchBytes = (url: string) => Promise<Uint8Array | null>;

export async function fetchBytesFromNetwork(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

export type LatestManifestResult = { manifest: ReleaseManifest } | { problem: Problem } | { unreachable: true };

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
  const manifestBytes = await fetchBytes(`${RELEASE_BASE}/latest/download/manifest.json`);
  const signatureBytes = await fetchBytes(`${RELEASE_BASE}/latest/download/manifest.json.minisig`);
  if (manifestBytes === null || signatureBytes === null) {
    return { unreachable: true };
  }
  const checked = checkSignedManifest({
    manifestBytes,
    signatureText: new TextDecoder().decode(signatureBytes),
    ...(publicKeyBase64 === undefined ? {} : { publicKeyBase64 }),
  });
  if ('problem' in checked) {
    return { problem: checked.problem };
  }
  return { manifest: checked.manifest };
}

export type ReleaseFileResult = { data: Uint8Array } | { problem: Problem } | { unreachable: true };

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
  const data = await fetchBytes(`${RELEASE_BASE}/download/${manifest.release}/${name}`);
  if (data === null) {
    return { unreachable: true };
  }
  const problem = checkDownloadedFile({ manifest, fileName: name, data });
  if (problem !== null) {
    return { problem };
  }
  return { data };
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

import {
  VERIFY_MANIFEST_UNREADABLE,
  VERIFY_SIGNATURE_BAD,
  VERIFY_SOURCE_IDS_MISMATCH,
  verifyChangedProblem,
  verifyNotListedProblem,
  type Problem,
} from '../messages.ts';
import { parseManifest, sha256Hex, sourceIdKeys, type ReleaseManifest, type SourceIds } from './manifest.ts';
import { parseMinisignPublicKey, verifyMinisign } from './minisign.ts';
import { RELEASE_PUBLIC_KEY_MINISIGN } from './releasePublicKey.ts';

// The checks a download and its release record must pass, each refused
// with the one Problem that names what to do. The signature is checked
// before anything in the record is trusted.

// Returns the manifest when the signature checks out against the
// release public key, or the Problem that refuses it.
export function checkSignedManifest({
  manifestBytes,
  signatureText,
  publicKeyBase64 = RELEASE_PUBLIC_KEY_MINISIGN,
}: {
  manifestBytes: Uint8Array;
  signatureText: string;
  publicKeyBase64?: string;
}): { manifest: ReleaseManifest } | { problem: Problem } {
  const publicKey = parseMinisignPublicKey(publicKeyBase64);
  if (publicKey === null) {
    return { problem: VERIFY_SIGNATURE_BAD };
  }
  if (!verifyMinisign({ data: manifestBytes, signatureText, publicKey })) {
    return { problem: VERIFY_SIGNATURE_BAD };
  }
  const manifest = parseManifest(manifestBytes);
  if (manifest === null) {
    return { problem: VERIFY_MANIFEST_UNREADABLE };
  }
  return { manifest };
}

export function checkDownloadedFile({
  manifest,
  fileName,
  data,
}: {
  manifest: ReleaseManifest;
  fileName: string;
  data: Uint8Array;
}): Problem | null {
  const expected = manifest.files[fileName];
  if (expected === undefined) {
    return verifyNotListedProblem(fileName);
  }
  if (sha256Hex(data) !== expected) {
    return verifyChangedProblem(fileName);
  }
  return null;
}

// The image tags a release record carries must equal the ones the shell
// computes from the same checkout, or an install from the source
// archive would build different images than a clone.
export function checkSourceIds({
  manifest,
  expected,
}: {
  manifest: ReleaseManifest;
  expected: SourceIds;
}): Problem | null {
  for (const key of sourceIdKeys()) {
    if (manifest.sourceIds[key] !== expected[key]) {
      return VERIFY_SOURCE_IDS_MISMATCH;
    }
  }
  return null;
}

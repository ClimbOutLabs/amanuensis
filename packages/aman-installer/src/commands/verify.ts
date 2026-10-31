import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  VERIFY_DOWNLOAD_UNREADABLE,
  VERIFY_MANIFEST_MISSING,
  VERIFY_SIGNATURE_MISSING,
  VERIFY_USAGE,
  problemText,
  verifyOkLine,
  type Problem,
} from '../messages.ts';
import { checkDownloadedFile, checkSignedManifest } from '../release/verify.ts';

export interface VerifyDeps {
  print: (line: string) => void;
  // A test stands in for the compiled-in release key; the shipped
  // command leaves this out and the key compiled into the executable
  // is the one that counts.
  releasePublicKey?: string;
}

async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

// aman verify <downloaded file>: the manifest and its signature sit
// beside the download, the files the release page offers together.
export async function runVerify(deps: VerifyDeps, options: { file: string | undefined }): Promise<number> {
  const fail = (problem: Problem): number => {
    deps.print(problemText(problem));
    return 1;
  };
  if (options.file === undefined) {
    return fail(VERIFY_USAGE);
  }
  const file = options.file;
  const dir = dirname(file);
  const manifestBytes = await readOrNull(join(dir, 'manifest.json'));
  if (manifestBytes === null) {
    return fail(VERIFY_MANIFEST_MISSING);
  }
  const signatureBytes = await readOrNull(join(dir, 'manifest.json.minisig'));
  if (signatureBytes === null) {
    return fail(VERIFY_SIGNATURE_MISSING);
  }
  const checked = checkSignedManifest({
    manifestBytes,
    signatureText: new TextDecoder().decode(signatureBytes),
    ...(deps.releasePublicKey === undefined ? {} : { publicKeyBase64: deps.releasePublicKey }),
  });
  if ('problem' in checked) {
    return fail(checked.problem);
  }
  const data = await readOrNull(file);
  if (data === null) {
    return fail(VERIFY_DOWNLOAD_UNREADABLE);
  }
  const problem = checkDownloadedFile({ manifest: checked.manifest, fileName: basename(file), data });
  if (problem !== null) {
    return fail(problem);
  }
  deps.print(verifyOkLine(basename(file)));
  return 0;
}

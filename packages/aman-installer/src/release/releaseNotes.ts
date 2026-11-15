import {
  CHECKSUMS_ASSET_NAME,
  MANIFEST_ASSET_NAME,
  MANIFEST_SIGNATURE_ASSET_NAME,
  SETUP_ASSET_NAME,
} from './assetNames.ts';
import { RELEASE_PUBLIC_KEY_MINISIGN } from './releasePublicKey.ts';

// The text of a published release page. The Windows download is not
// signed with a Windows publisher certificate, so the page says how
// to check any file against the signed record by hand, with the same
// key the aman command has built in.
export function releaseNotesText({
  release,
  publicKey = RELEASE_PUBLIC_KEY_MINISIGN,
}: {
  release: string;
  publicKey?: string;
}): string {
  return [
    `## Aman ${release}`,
    '',
    `**Windows:** download ${SETUP_ASSET_NAME} and open it. Windows may show a blue "Windows protected your PC" box, because Aman Setup is not signed with a Windows publisher certificate. Choose **More info**, then **Run anyway**. Check the file first, as below, if you want to be sure it is ours.`,
    '',
    '### Check your download',
    '',
    `${MANIFEST_ASSET_NAME} lists every file on this page with its SHA-256 hash, and ${MANIFEST_SIGNATURE_ASSET_NAME} is its signature, made with the Aman release key.`,
    '',
    `1. Download ${MANIFEST_ASSET_NAME} and ${MANIFEST_SIGNATURE_ASSET_NAME} into the same folder as your file.`,
    '2. Check the signature with [minisign](https://github.com/jedisct1/minisign). It must say the signature is verified:',
    '',
    '   ```',
    `   minisign -Vm ${MANIFEST_ASSET_NAME} -P ${publicKey}`,
    '   ```',
    '',
    `3. Work out your file's hash and find the same hash next to its name in ${MANIFEST_ASSET_NAME}:`,
    `   - Windows PowerShell: \`Get-FileHash .\\${SETUP_ASSET_NAME}\``,
    '   - Mac: `shasum -a 256 <file>`',
    '   - Linux: `sha256sum <file>`',
    '',
    `If you already have Aman, \`aman verify <file>\` does steps 2 and 3 with the key built into it. ${CHECKSUMS_ASSET_NAME} holds the same hashes in the usual plain format, and only shows the file was not damaged on the way, not who made it.`,
    '',
    `The release key is \`${publicKey}\`. It is also in [SECURITY.md](https://github.com/ClimbOutLabs/amanuensis/blob/main/SECURITY.md).`,
    '',
  ].join('\n');
}

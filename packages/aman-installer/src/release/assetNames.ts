// The names a release gives its downloads. Every step that makes,
// checks or fetches a release file takes its name from here, so the
// file a person downloads and the file the update looks for cannot
// drift apart.

// The name a person downloads on Windows. It is the same program as
// the Windows build; this name is what makes it run the setup when it
// is opened with no command. It never changes between releases.
export const SETUP_ASSET_NAME = 'Aman-Setup.exe';

// The record a release is checked against, and its signature.
export const MANIFEST_ASSET_NAME = 'manifest.json';
export const MANIFEST_SIGNATURE_ASSET_NAME = 'manifest.json.minisig';

// The plain list of SHA-256 hashes for people who check a download by
// hand with sha256sum or Get-FileHash.
export const CHECKSUMS_ASSET_NAME = 'SHA256SUMS';

export const WINDOWS_ASSET_PREFIX = 'aman-windows-';

export function windowsAssetName(arch: string): string {
  return `${WINDOWS_ASSET_PREFIX}${arch}.exe`;
}

// The systems a release must carry a build for, by the start of the
// build's file name.
export const RELEASE_SYSTEMS: readonly { name: string; prefix: string }[] = [
  { name: 'Windows', prefix: WINDOWS_ASSET_PREFIX },
  { name: 'Mac', prefix: 'aman-darwin-' },
  { name: 'Linux', prefix: 'aman-linux-' },
];

// The names one system's build is published under. Windows publishes
// the build twice: under its system name, which the update fetches,
// and as the setup download. Returns null for a system Aman has no
// build for.
export function buildAssetNames({ platform, arch }: { platform: string; arch: string }): string[] | null {
  if (platform === 'win32') {
    return [windowsAssetName(arch), SETUP_ASSET_NAME];
  }
  if (platform === 'darwin') {
    return [`aman-darwin-${arch}`];
  }
  if (platform === 'linux') {
    return [`aman-linux-${arch}`];
  }
  return null;
}

// Whether the program was started as the setup download. A browser
// that already has a file of that name saves the next one as
// "Aman-Setup (1).exe", and that copy must still run the setup.
export function isSetupProgramName(fileName: string): boolean {
  return /^aman-setup( ?\(\d+\))?(\.exe)?$/i.test(fileName);
}

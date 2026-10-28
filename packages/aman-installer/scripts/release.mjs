import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The release steps for one system, the same steps the installer
// release workflow runs: build the executable with the one build
// script, name it for its system, make the release record, and sign
// it when a key file is given. With no key file the record is left
// unsigned and the owner signs it locally; a private key never
// travels with this script or through a runner.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(packageRoot, '..', '..');

function flagValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = process.argv[index + 1];
  return value === undefined ? null : value;
}

const release = flagValue('--release');
if (release === null) {
  console.error('The release steps need --release with the release tag.');
  process.exit(1);
}
const assetsDir = flagValue('--assets') ?? join(packageRoot, 'dist', 'release-assets');
const sourceArchive = flagValue('--source-archive');
const keyPath = flagValue('--key');
const keyNum = flagValue('--key-num');
if ((keyPath === null) !== (keyNum === null)) {
  console.error('Signing needs both --key and --key-num, or neither.');
  process.exit(1);
}

function run(file, args) {
  execFileSync(file, args, { stdio: 'inherit' });
}

run(process.execPath, [join(packageRoot, 'scripts', 'build-exe.mjs')]);

const arch = process.arch;
const builtExe = join(packageRoot, 'dist', process.platform === 'win32' ? 'aman.exe' : 'aman');
const assetName =
  process.platform === 'win32'
    ? `aman-windows-${arch}.exe`
    : process.platform === 'darwin'
      ? `aman-darwin-${arch}`
      : `aman-linux-${arch}`;
mkdirSync(assetsDir, { recursive: true });
copyFileSync(builtExe, join(assetsDir, assetName));
console.log(`Staged ${assetName}`);
if (sourceArchive !== null) {
  const archiveName = sourceArchive.split(/[\\/]/).pop();
  copyFileSync(sourceArchive, join(assetsDir, archiveName));
  console.log(`Staged ${archiveName}`);
}

const toolPath = join(packageRoot, 'src', 'release', 'tool.ts');
const manifestPath = join(assetsDir, 'manifest.json');
run(process.execPath, [
  toolPath,
  'build-manifest',
  '--release',
  release,
  '--assets',
  assetsDir,
  '--checkout',
  repoRoot,
  '--out',
  manifestPath,
]);

if (keyPath !== null && keyNum !== null) {
  run(process.execPath, [
    toolPath,
    'sign',
    '--manifest',
    manifestPath,
    '--key',
    keyPath,
    '--key-num',
    keyNum,
    '--out',
    `${manifestPath}.minisig`,
  ]);
  console.log('The release record is signed.');
} else {
  console.log('The release record is not signed. The owner signs manifest.json locally before the release is shared.');
}

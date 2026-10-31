import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The release steps, in two shapes. For one system, the same steps the
// installer release workflow runs: build the executable with the one
// build script, name it for its system, and make that system's partial
// release record. With --parts naming the folder the three systems'
// partial records were gathered into, instead assemble the one release
// record from them, refusing unless every system's build is there.
// Signing is the same either way: with a key file the record is signed
// here, and with none it is left unsigned and the owner signs it
// locally; a private key never travels with this script or through a
// runner.

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
const partsDir = flagValue('--parts');
const keyPath = flagValue('--key');
const keyNum = flagValue('--key-num');
if ((keyPath === null) !== (keyNum === null)) {
  console.error('Signing needs both --key and --key-num, or neither.');
  process.exit(1);
}

function run(file, args) {
  try {
    execFileSync(file, args, { stdio: 'inherit' });
  } catch (error) {
    // The step has already said why it failed; leave with its code
    // instead of adding a stack trace to its words.
    const status = error !== null && typeof error === 'object' ? Reflect.get(error, 'status') : null;
    process.exit(typeof status === 'number' ? status : 1);
  }
}

const toolPath = join(packageRoot, 'src', 'release', 'tool.ts');
const manifestPath = join(assetsDir, 'manifest.json');

if (partsDir !== null) {
  // The assembly: no build on this machine, just the join of the three
  // systems' partial records into the one record, in the assets folder.
  mkdirSync(assetsDir, { recursive: true });
  const partNames = readdirSync(partsDir)
    .filter(name => /^manifest.*\.json$/.test(name) && !name.endsWith('.minisig'))
    .sort();
  if (partNames.length === 0) {
    console.error(`No partial release records were found in ${partsDir}.`);
    process.exit(1);
  }
  const assembleArgs = [
    toolPath,
    'assemble-manifest',
    '--release',
    release,
    '--checkout',
    repoRoot,
    '--out',
    manifestPath,
  ];
  for (const name of partNames) {
    assembleArgs.push('--part', join(partsDir, name));
  }
  run(process.execPath, assembleArgs);
} else {
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
}

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

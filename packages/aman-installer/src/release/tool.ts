import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { runVerify } from '../commands/verify.ts';
import { SystemProcessRunner } from '../runner/processRunner.ts';
import { assembleManifests } from './assemble.ts';
import { CHECKSUMS_ASSET_NAME, buildAssetNames } from './assetNames.ts';
import { checksumsText } from './checksums.ts';
import { buildManifest, manifestToBytes, parseManifest, type ReleaseManifest } from './manifest.ts';
import { minisignPublicKeyBase64, signMinisign } from './minisign.ts';
import { releaseNotesText } from './releaseNotes.ts';
import { installerLibDir, sourceIdsFromCheckout } from './sourceIds.ts';

// The release steps' tool, run by the release workflow and by hand on
// the machine that cuts a release, through the package's release
// script. It is not part of the shipped executable; main.ts never
// imports it. A private release key never travels through it to a
// runner: the record is signed on the owner's own machine.

function flagValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  return value ?? null;
}

function flagValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (value !== undefined) {
        values.push(value);
      }
    }
  }
  return values;
}

function fail(line: string): number {
  console.error(line);
  return 1;
}

// Puts one system's built program into the assets folder under the
// names the release publishes it as, and the source archive beside it
// when one is given.
async function stageCommand(args: readonly string[]): Promise<number> {
  const exe = flagValue(args, '--exe');
  const assetsDir = flagValue(args, '--assets');
  const sourceArchive = flagValue(args, '--source-archive');
  if (exe === null || assetsDir === null) {
    return fail('stage needs --exe and --assets.');
  }
  const names = buildAssetNames({ platform: process.platform, arch: process.arch });
  if (names === null) {
    return fail(`Aman has no build for ${process.platform}.`);
  }
  await mkdir(assetsDir, { recursive: true });
  for (const name of names) {
    await copyFile(exe, join(assetsDir, name));
    console.log(`Staged ${name}`);
  }
  if (sourceArchive !== null) {
    const archiveName = basename(sourceArchive);
    await copyFile(sourceArchive, join(assetsDir, archiveName));
    console.log(`Staged ${archiveName}`);
  }
  return 0;
}

// Writes SHA256SUMS for every file in the folder but the list itself.
async function checksumsCommand(args: readonly string[]): Promise<number> {
  const dir = flagValue(args, '--dir');
  if (dir === null) {
    return fail('checksums needs --dir.');
  }
  const names = (await readdir(dir)).filter(name => name !== CHECKSUMS_ASSET_NAME);
  if (names.length === 0) {
    return fail('The folder is empty, so there is nothing to list.');
  }
  const files: { name: string; data: Uint8Array }[] = [];
  for (const name of names) {
    files.push({ name, data: new Uint8Array(await readFile(join(dir, name))) });
  }
  await writeFile(join(dir, CHECKSUMS_ASSET_NAME), checksumsText(files));
  console.log(`Wrote ${CHECKSUMS_ASSET_NAME} for ${String(files.length)} files.`);
  return 0;
}

// A key made for one dry run and thrown away with it, so a dry run can
// sign its record and check every file the way a real release is
// checked, without the owner's key. It prints the key number and the
// public key as name=value lines a workflow can read.
async function throwawayKeyCommand(args: readonly string[]): Promise<number> {
  const out = flagValue(args, '--out');
  if (out === null) {
    return fail('throwaway-key needs --out.');
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyNum = new Uint8Array(randomBytes(8));
  const spki = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));
  await writeFile(out, privateKey.export({ format: 'der', type: 'pkcs8' }));
  console.log(`key-num=${Buffer.from(keyNum).toString('hex')}`);
  console.log(`public-key=${minisignPublicKeyBase64({ keyNum, key: spki.subarray(spki.length - 32) })}`);
  return 0;
}

async function buildManifestCommand(args: readonly string[]): Promise<number> {
  const release = flagValue(args, '--release');
  const assetsDir = flagValue(args, '--assets');
  const checkoutDir = flagValue(args, '--checkout');
  const out = flagValue(args, '--out');
  if (release === null || assetsDir === null || checkoutDir === null || out === null) {
    return fail('build-manifest needs --release, --assets, --checkout and --out.');
  }
  const names = (await readdir(assetsDir)).sort();
  const files: { name: string; data: Uint8Array }[] = [];
  for (const name of names) {
    files.push({ name, data: new Uint8Array(await readFile(join(assetsDir, name))) });
  }
  if (files.length === 0) {
    return fail('The assets folder is empty, so there is nothing to make a release record for.');
  }
  const sourceIds = await sourceIdsFromCheckout({
    runner: new SystemProcessRunner(),
    checkoutDir,
    libDir: installerLibDir(checkoutDir),
  });
  if (sourceIds === null) {
    return fail('The shell could not work out the image names for this checkout.');
  }
  const manifest = buildManifest({ release, files, sourceIds });
  await writeFile(out, manifestToBytes(manifest));
  console.log(`Wrote ${out} for release ${release} with ${String(files.length)} files.`);
  return 0;
}

// Joins the per-system partial records into the one release record.
// Every partial record must be a real record, they must all name the
// same release and this checkout's images, and the joined record must
// carry every system's build and the source archive, or the step
// refuses and no record is written.
async function assembleManifestCommand(args: readonly string[]): Promise<number> {
  const partPaths = flagValues(args, '--part');
  const release = flagValue(args, '--release');
  const checkoutDir = flagValue(args, '--checkout');
  const out = flagValue(args, '--out');
  if (partPaths.length === 0 || checkoutDir === null || out === null) {
    return fail('assemble-manifest needs --part once per partial record, --checkout and --out.');
  }
  const parts: ReleaseManifest[] = [];
  for (const partPath of partPaths) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(partPath));
    } catch {
      return fail(`A partial release record could not be read: ${partPath}`);
    }
    const part = parseManifest(bytes);
    if (part === null) {
      return fail(`A partial release record is not a release record: ${partPath}`);
    }
    parts.push(part);
  }
  const sourceIds = await sourceIdsFromCheckout({
    runner: new SystemProcessRunner(),
    checkoutDir,
    libDir: installerLibDir(checkoutDir),
  });
  if (sourceIds === null) {
    return fail('The shell could not work out the image names for this checkout.');
  }
  const assembled = assembleManifests({ parts, expectedSourceIds: sourceIds });
  if ('problem' in assembled) {
    return fail(assembled.problem);
  }
  if (release !== null && assembled.manifest.release !== release) {
    return fail(`The partial records are for ${assembled.manifest.release}, not ${release}.`);
  }
  await writeFile(out, manifestToBytes(assembled.manifest));
  console.log(
    `Wrote ${out} for release ${assembled.manifest.release} with ${String(Object.keys(assembled.manifest.files).length)} files.`,
  );
  return 0;
}

async function signCommand(args: readonly string[]): Promise<number> {
  const manifestPath = flagValue(args, '--manifest');
  const keyPath = flagValue(args, '--key');
  const keyNumHex = flagValue(args, '--key-num');
  const out = flagValue(args, '--out');
  if (manifestPath === null || keyPath === null || keyNumHex === null || out === null) {
    return fail('sign needs --manifest, --key, --key-num and --out.');
  }
  if (!/^[a-f0-9]{16}$/.test(keyNumHex)) {
    return fail('The key number must be 16 lowercase hex characters.');
  }
  const keyNum = new Uint8Array(Buffer.from(keyNumHex, 'hex'));
  const data = new Uint8Array(await readFile(manifestPath));
  const privateKeyDer = new Uint8Array(await readFile(keyPath));
  const text = signMinisign({ data, privateKeyDer, keyNum });
  await writeFile(out, text);
  console.log(`Wrote ${out} for ${basename(manifestPath)}.`);
  return 0;
}

async function verifyCommand(args: readonly string[]): Promise<number> {
  const file = flagValue(args, '--file');
  if (file === null) {
    return fail('verify needs --file.');
  }
  const key = flagValue(args, '--key');
  return runVerify(
    {
      print: (line: string) => {
        console.log(line);
      },
      ...(key === null ? {} : { releasePublicKey: key }),
    },
    { file },
  );
}

// Prints the published release page's text, for gh release edit.
function notesCommand(args: readonly string[]): number {
  const release = flagValue(args, '--release');
  if (release === null) {
    return fail('notes needs --release.');
  }
  process.stdout.write(releaseNotesText({ release }));
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
let exitCode: number;
if (command === 'stage') {
  exitCode = await stageCommand(rest);
} else if (command === 'checksums') {
  exitCode = await checksumsCommand(rest);
} else if (command === 'throwaway-key') {
  exitCode = await throwawayKeyCommand(rest);
} else if (command === 'build-manifest') {
  exitCode = await buildManifestCommand(rest);
} else if (command === 'assemble-manifest') {
  exitCode = await assembleManifestCommand(rest);
} else if (command === 'sign') {
  exitCode = await signCommand(rest);
} else if (command === 'verify') {
  exitCode = await verifyCommand(rest);
} else if (command === 'notes') {
  exitCode = notesCommand(rest);
} else {
  exitCode = fail(
    'The release tool knows stage, build-manifest, assemble-manifest, sign, verify, notes, checksums and throwaway-key.',
  );
}
process.exitCode = exitCode;

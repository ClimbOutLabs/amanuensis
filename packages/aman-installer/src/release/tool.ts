import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { runVerify } from '../commands/verify.ts';
import { SystemProcessRunner } from '../runner/processRunner.ts';
import { assembleManifests } from './assemble.ts';
import { buildManifest, manifestToBytes, parseManifest, type ReleaseManifest } from './manifest.ts';
import { signMinisign } from './minisign.ts';
import { installerLibDir, sourceIdsFromCheckout } from './sourceIds.ts';

// The release steps' tool, run by scripts/release.mjs and by hand on
// the machine that cuts a release. It is not part of the shipped
// executable; main.ts never imports it.

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

const [command, ...rest] = process.argv.slice(2);
let exitCode: number;
if (command === 'build-manifest') {
  exitCode = await buildManifestCommand(rest);
} else if (command === 'assemble-manifest') {
  exitCode = await assembleManifestCommand(rest);
} else if (command === 'sign') {
  exitCode = await signCommand(rest);
} else if (command === 'verify') {
  exitCode = await verifyCommand(rest);
} else {
  exitCode = fail('The release tool knows build-manifest, assemble-manifest, sign and verify.');
}
process.exitCode = exitCode;

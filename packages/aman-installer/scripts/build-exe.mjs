import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { build } from 'esbuild';

// Builds the single executable: one esbuild bundle, then Node's single
// executable support with the blob injected by postject. The file is named
// aman.exe on Windows and aman everywhere else.
const requireHere = createRequire(import.meta.url);
const packageRoot = join(dirname(requireHere.resolve('../package.json')), '.');
const distDir = join(packageRoot, 'dist');
const bundlePath = join(distDir, 'aman.cjs');
const blobPath = join(distDir, 'sea-prep.blob');
const seaConfigPath = join(distDir, 'sea-config.json');
const isWindows = process.platform === 'win32';
const exePath = join(distDir, isWindows ? 'aman.exe' : 'aman');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

await build({
  entryPoints: [join(packageRoot, 'src', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundlePath,
});

writeFileSync(
  seaConfigPath,
  `${JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2)}\n`,
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });

copyFileSync(process.execPath, exePath);
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', exePath], { stdio: 'inherit' });
}

const postjectPackagePath = requireHere.resolve('postject/package.json');
const postjectPackage = requireHere('postject/package.json');
const postjectBin = typeof postjectPackage.bin === 'string' ? postjectPackage.bin : postjectPackage.bin.postject;
// On macOS, Node reads the blob from the NODE_SEA Mach-O segment, so postject must put it
// there; its default segment leaves the fuse flipped with no blob Node can find, and the
// executable crashes at startup (https://nodejs.org/api/single-executable-applications.html).
const machoArgs = process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [];
execFileSync(
  process.execPath,
  [
    join(dirname(postjectPackagePath), postjectBin),
    exePath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    SEA_FUSE,
    ...machoArgs,
  ],
  { stdio: 'inherit' },
);

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', exePath], { stdio: 'inherit' });
}
if (!isWindows) {
  chmodSync(exePath, 0o755);
}
console.log(`Built ${exePath}`);

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INSTALL_NOT_WINDOWS, UNEXPECTED_FAILURE, allMessageLines, problemText } from '../src/messages.ts';

// Starts the built program the way a person does: as Aman-Setup, with no
// command. Nobody is at the keyboard, so nothing waits for Enter. The run
// passes when it ends on its own, prints something, and stops on a line
// the program means to say. A crash, a silent exit or the "did not expect"
// line fails it. On Windows the first install goes as far as this
// computer allows (a CI machine has no Docker Desktop to use, so it stops
// at a Docker or setup step); everywhere else Aman Setup says it is for
// Windows.
const isWindows = process.platform === 'win32';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const builtExe = join(packageRoot, 'dist', isWindows ? 'aman.exe' : 'aman');
const TIMEOUT_MS = 10 * 60 * 1000;

const workDir = mkdtempSync(join(tmpdir(), 'aman-setup-launch-'));
const setupExe = join(workDir, isWindows ? 'Aman-Setup.exe' : 'Aman-Setup');
copyFileSync(builtExe, setupExe);

// Docker Desktop is never installed on a CI machine: without a docker
// command the setup would download and run Docker Desktop's installer.
if (isWindows) {
  const docker = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (docker.status !== 0) {
    console.error('This machine has no docker command, so Aman Setup would install Docker Desktop. Stopping.');
    process.exit(1);
  }
}

const run = spawnSync(setupExe, [], {
  cwd: workDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
  timeout: TIMEOUT_MS,
  env: { ...process.env, LOCALAPPDATA: join(workDir, 'AppData', 'Local') },
});
rmSync(workDir, { recursive: true, force: true });

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
console.log(output);
console.log(`Exit code: ${String(run.status)}${run.signal === null ? '' : `, stopped by ${run.signal}`}`);

const problems = [];
if (run.error !== undefined) {
  problems.push(`The program did not finish: ${run.error.message}`);
}
const lines = output
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line !== '');
if (lines.length === 0) {
  problems.push('The program printed nothing.');
}
const unexpected = problemText(UNEXPECTED_FAILURE).split('\n')[0];
if (output.includes(unexpected)) {
  problems.push('The program stopped on the "did not expect" line.');
}
if (isWindows) {
  const known = new Set(
    allMessageLines()
      .flatMap(line => line.split('\n'))
      .map(line => line.trim()),
  );
  if (!lines.some(line => known.has(line))) {
    problems.push('Nothing the program printed is one of its own sentences, so it did not stop where it meant to.');
  }
} else {
  if (!output.includes(INSTALL_NOT_WINDOWS.happened)) {
    problems.push('Aman Setup did not say it is for Windows.');
  }
  if (run.status !== 1) {
    problems.push(`Aman Setup ended with ${String(run.status)}, not 1.`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(1);
}
console.log('Aman Setup started, and stopped where it meant to.');

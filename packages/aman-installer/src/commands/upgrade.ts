import { existsSync, renameSync, rmSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { doctorStoreProblem, runDoctorChecks, type DoctorChecks, type DoctorDeps } from '../doctor/doctor.ts';
import type { Host } from '../host/host.ts';
import type { WindowsJobs } from '../host/windowsJobs.ts';
import {
  NOT_INSTALLED,
  STATE_UNREADABLE,
  UPGRADE_BUSY,
  UPGRADE_CONTAINER_FAILED,
  UPGRADE_DECLINED_LINE,
  UPGRADE_DOCKER_NOT_ANSWERING,
  UPGRADE_DOWNLOAD_FAILED,
  UPGRADE_EXE_IN_PLACE_LINE,
  UPGRADE_NEW_PROGRAM_WAITING,
  UPGRADE_NOT_PUT_BACK,
  UPGRADE_NOT_WINDOWS,
  UPGRADE_OLD_PROGRAM_NOT_BACK,
  UPGRADE_PROGRAM_MISSING,
  UPGRADE_RELEASE_NOT_THERE,
  UPGRADE_REPLACE_FAILED,
  UPGRADE_ROLLED_BACK,
  UPGRADE_SMOKE_FAILED,
  UPGRADE_SOURCE_FAILED,
  UPGRADE_SOURCE_MISSING,
  UPGRADE_UP_TO_DATE_LINE,
  problemText,
  upgradeDoneLine,
  upgradeNotReadyProblem,
  upgradeQuestionLine,
  verifyNotListedProblem,
} from '../messages.ts';
import type { FetchBytes } from '../release/download.ts';
import { fetchLatestManifest, fetchReleaseFile, sourceArchiveName, windowsAssetName } from '../release/download.ts';
import { sha256Hex, type ReleaseManifest } from '../release/manifest.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';
import type { StateStore, StateSummary } from '../state/state.ts';
import { SETUP_IMAGE, SOURCE_DIR, SOURCE_VOLUME, STATE_VOLUME, VOLUME_HOME } from '../state/volumeBackend.ts';

export interface UpgradeDeps extends DoctorDeps {
  host: Host;
  runner: ProcessRunner;
  store: StateStore;
  print: (line: string) => void;
  // Asks the one question, before anything is downloaded, and answers
  // whether the person said yes. There is no silent mode.
  confirm: (question: string) => Promise<boolean>;
  fetchBytes: FetchBytes;
  // The folder the adopt step put the installed program in; null when
  // this computer has none.
  programsDir: string | null;
  // The Windows host jobs: the Start menu entries are theirs to make,
  // the same owner the adopt and open steps use.
  jobs: WindowsJobs;
  // This computer's processor kind, as the release names its files.
  arch: string;
  // Only a test sets this; the shipped command checks downloads
  // against the release key compiled into the executable.
  releasePublicKey?: string;
}

// The unpack: clear the source volume, pour the archive in from stdin,
// drop its one top folder, and prove the installer is there before the
// upgrade is allowed to start. The bytes are never re-packed on this
// side; they stream through unchanged.
const UNPACK_SCRIPT =
  'cd /src || exit 1; rm -rf -- * .[!.]*; tar -xzf - --strip-components=1 && test -f installer/install.sh';

// The file names of the swap, in the installed folder. The convention is
// the whole record of a pending swap: no state file names it.
const EXE_NAME = 'aman.exe';
const NEW_NAME = 'aman.exe.new';
const OLD_NAME = 'aman.exe.old';

// Settles a swap the last upgrade staged, at the start of every run.
// When the new program and the kept old one are both there, this start
// is the new program running, so the old one has done its job and goes.
// When the program itself is missing and the old one is there, a swap
// stopped halfway and the old one is put back. It never prints and
// never fails the start.
export function resolvePendingSwap(programsDir: string): void {
  const exePath = join(programsDir, EXE_NAME);
  const oldPath = join(programsDir, OLD_NAME);
  try {
    if (!existsSync(exePath) && existsSync(oldPath)) {
      renameSync(oldPath, exePath);
    } else if (existsSync(exePath) && existsSync(oldPath)) {
      rmSync(oldPath, { force: true });
    }
  } catch {
    // Keeping the old program a little longer is always safe.
  }
}

// The Start menu entry that runs this command, refreshed through the
// Windows jobs, the one owner of every Aman shortcut. Best effort: the
// entry is a convenience, and its absence never blocks an update the
// person asked for.
async function ensureUpdateEntry(deps: UpgradeDeps): Promise<void> {
  await deps.jobs.ensureUpdateAmanShortcut().catch(() => undefined);
}

// The health gate: the local doctor's checks, judged the way the doctor
// judges them. A failing check refuses the update, naming that check's
// own next step.
async function healthGate(deps: UpgradeDeps): Promise<boolean> {
  let checks: DoctorChecks;
  try {
    checks = await runDoctorChecks(deps, { local: true });
  } catch (error) {
    deps.print(problemText(doctorStoreProblem(error, deps.host.kind)));
    return false;
  }
  const firstFail = checks.records.find(record => record.state === 'fail');
  if (firstFail === undefined) {
    return true;
  }
  if (firstFail.detail !== '') {
    deps.print(firstFail.detail);
  }
  deps.print(problemText(upgradeNotReadyProblem(firstFail.fix)));
  return false;
}

// Downloads the new program, checks it against the signed record before
// any file moves, and stages the swap: the running program is renamed
// to the kept old name, the new one is run once, and only a new one that
// starts is renamed into place. A new one that does not start is
// removed and the old one put back, so the old Aman keeps working.
async function stageNewProgram(
  deps: UpgradeDeps,
  manifest: ReleaseManifest,
  assetName: string,
  programsDir: string,
): Promise<boolean> {
  const { print } = deps;
  const download = await fetchReleaseFile({ fetchBytes: deps.fetchBytes, manifest, name: assetName });
  if ('unreachable' in download) {
    print(problemText(UPGRADE_DOWNLOAD_FAILED));
    return false;
  }
  if ('missing' in download) {
    print(problemText(UPGRADE_RELEASE_NOT_THERE));
    return false;
  }
  if ('problem' in download) {
    print(problemText(download.problem));
    return false;
  }
  const exePath = join(programsDir, EXE_NAME);
  const newPath = join(programsDir, NEW_NAME);
  const oldPath = join(programsDir, OLD_NAME);
  try {
    await writeFile(newPath, download.data);
    await rename(exePath, oldPath);
  } catch {
    await rm(newPath, { force: true }).catch(() => undefined);
    print(problemText(UPGRADE_REPLACE_FAILED));
    return false;
  }
  const smoke = await deps.runner.run(newPath, ['--version']);
  const smokeOk = smoke.started && smoke.exitCode === 0 && smoke.stdout.trim().startsWith('aman ');
  if (!smokeOk) {
    await rm(newPath, { force: true }).catch(() => undefined);
    await rename(oldPath, exePath).catch(() => undefined);
    print(problemText(UPGRADE_SMOKE_FAILED));
    return false;
  }
  try {
    await rename(newPath, exePath);
  } catch {
    // The end state gets its own words, because it is not the plain
    // replace failure above: the checked new program stays in the
    // folder as aman.exe.new, and which program is in place depends on
    // whether the old one could be put back.
    const oldBack = await rename(oldPath, exePath).then(
      () => true,
      () => false,
    );
    print(problemText(oldBack ? UPGRADE_NEW_PROGRAM_WAITING : UPGRADE_OLD_PROGRAM_NOT_BACK));
    return false;
  }
  print(UPGRADE_EXE_IN_PLACE_LINE);
  return true;
}

// Fetches the release's source archive, checks it against the record,
// and unpacks it into the source volume. This is the flow's only write
// to a volume, and it is finished, container gone, before the upgrade
// container starts: the TypeScript steps never hold anything the
// shell's writers need.
async function unpackSource(deps: UpgradeDeps, manifest: ReleaseManifest, archiveName: string): Promise<boolean> {
  const { print } = deps;
  const download = await fetchReleaseFile({ fetchBytes: deps.fetchBytes, manifest, name: archiveName });
  if ('unreachable' in download || 'missing' in download) {
    print(problemText(UPGRADE_SOURCE_FAILED));
    return false;
  }
  if ('problem' in download) {
    print(problemText(download.problem));
    return false;
  }
  const unpack = await deps.runner.runBytes(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '-v',
      `${SOURCE_VOLUME}:${SOURCE_DIR}`,
      SETUP_IMAGE,
      'sh',
      '-c',
      UNPACK_SCRIPT,
    ],
    download.data,
  );
  if (!unpack.started) {
    print(problemText(UPGRADE_DOCKER_NOT_ANSWERING));
    return false;
  }
  if (unpack.exitCode !== 0) {
    print(problemText(UPGRADE_SOURCE_FAILED));
    return false;
  }
  return true;
}

// The upgrade itself, run by the shell inside the setup container with
// the starter's container shape: the state volume, the source volume,
// and Docker's socket, working in the source. The shell takes the state
// lock in there, after every step above has finished. Its own output is
// shown as it stands, then the verdict is read from its words.
async function runContainerUpgrade(deps: UpgradeDeps, manifest: ReleaseManifest): Promise<number> {
  const { print } = deps;
  const result = await deps.runner.run('docker', [
    'run',
    '--rm',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${STATE_VOLUME}:${VOLUME_HOME}`,
    '-v',
    `${SOURCE_VOLUME}:${SOURCE_DIR}`,
    '-w',
    SOURCE_DIR,
    SETUP_IMAGE,
    'installer/install.sh',
    'upgrade',
  ]);
  if (!result.started) {
    print(problemText(UPGRADE_DOCKER_NOT_ANSWERING));
    return 1;
  }
  for (const line of result.stdout.split('\n')) {
    if (line.trim() !== '') {
      print(line);
    }
  }
  for (const line of result.stderr.split('\n')) {
    if (line.trim() !== '') {
      print(line);
    }
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode === 0) {
    print(upgradeDoneLine(manifest.release));
    return 0;
  }
  if (combined.includes('Another install is running right now')) {
    print(problemText(UPGRADE_BUSY));
    return 1;
  }
  if (combined.includes('The previous version is back')) {
    print(problemText(UPGRADE_ROLLED_BACK));
    return 1;
  }
  if (result.exitCode === 2 || combined.includes('could not be fully put back')) {
    print(problemText(UPGRADE_NOT_PUT_BACK));
    return 1;
  }
  print(problemText(UPGRADE_CONTAINER_FAILED));
  return 1;
}

// aman upgrade, on Windows: bring Aman to the newest release whose
// signed record checks out. It reads what is installed, fetches the
// newest release record and refuses with its Problem when the record
// fails, asks once before anything downloads, gates on the local
// doctor, swaps the program with a kept old copy, then hands the rest
// to the shell's own upgrade in the setup container. There is no
// silent mode, and running Aman-Setup.exe on an installed PC is this
// same command.
export async function runUpgrade(deps: UpgradeDeps): Promise<number> {
  const { host, print } = deps;
  if (host.kind !== 'windows') {
    print(problemText(UPGRADE_NOT_WINDOWS));
    return 1;
  }
  const { programsDir } = deps;
  if (programsDir === null) {
    print(problemText(NOT_INSTALLED));
    return 1;
  }
  let summary: StateSummary;
  try {
    summary = await deps.store.readSummary();
  } catch (error) {
    print(problemText(doctorStoreProblem(error, host.kind)));
    return 1;
  }
  if (summary.releaseUnreadable) {
    print(problemText(STATE_UNREADABLE));
    return 1;
  }
  if (summary.release === null && summary.instances.length === 0) {
    print(problemText(NOT_INSTALLED));
    return 1;
  }
  const exePath = join(programsDir, EXE_NAME);
  if (!existsSync(exePath)) {
    print(problemText(UPGRADE_PROGRAM_MISSING));
    return 1;
  }
  const latest = await fetchLatestManifest({
    fetchBytes: deps.fetchBytes,
    ...(deps.releasePublicKey === undefined ? {} : { publicKeyBase64: deps.releasePublicKey }),
  });
  if ('unreachable' in latest) {
    print(problemText(UPGRADE_DOWNLOAD_FAILED));
    return 1;
  }
  if ('missing' in latest) {
    print(problemText(UPGRADE_RELEASE_NOT_THERE));
    return 1;
  }
  if ('problem' in latest) {
    print(problemText(latest.problem));
    return 1;
  }
  const manifest = latest.manifest;
  const assetName = windowsAssetName(deps.arch);
  const expectedExeHash = manifest.files[assetName];
  if (expectedExeHash === undefined) {
    print(problemText(verifyNotListedProblem(assetName)));
    return 1;
  }
  const archiveName = sourceArchiveName(manifest);
  if (archiveName === null) {
    print(problemText(UPGRADE_SOURCE_MISSING));
    return 1;
  }
  const currentProgram = await readFile(exePath).catch(() => null);
  if (currentProgram === null) {
    print(problemText(UPGRADE_PROGRAM_MISSING));
    return 1;
  }
  if (sha256Hex(currentProgram) === expectedExeHash) {
    print(UPGRADE_UP_TO_DATE_LINE);
    return 0;
  }
  if (!(await healthGate(deps))) {
    return 1;
  }
  const agreed = await deps.confirm(upgradeQuestionLine(manifest.release));
  if (!agreed) {
    print(UPGRADE_DECLINED_LINE);
    return 0;
  }
  await ensureUpdateEntry(deps);
  if (!(await stageNewProgram(deps, manifest, assetName, programsDir))) {
    return 1;
  }
  if (!(await unpackSource(deps, manifest, archiveName))) {
    return 1;
  }
  const upgradeCode = await runContainerUpgrade(deps, manifest);
  // The upgrade ran in its container and wrote the state there, and a
  // rollback writes it too, so what this process read before it is out
  // of date for anything that reads the state after this command.
  deps.store.refreshCache();
  return upgradeCode;
}

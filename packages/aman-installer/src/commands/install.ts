import type { NetworkInterfaceInfo } from 'node:os';
import { win32 } from 'node:path';

import { checkDocker } from '../doctor/dockerDoctor.ts';
import type { DoctorDeps } from '../doctor/doctor.ts';
import { gettingStartedPage } from '../gettingStarted.ts';
import type { Host } from '../host/host.ts';
import { firstInstallArgs, NoFreePortError, pickInstallPorts } from '../host/windowsInstall.ts';
import { DOCKER_DESKTOP_DOWNLOAD_URL, WindowsJobError, type WindowsJobs } from '../host/windowsJobs.ts';
import {
  FILES_COULD_NOT_FIX,
  FILES_MADE_PRIVATE_LINE,
  INSTALL_BUSY,
  INSTALL_CONTAINER_FAILED,
  INSTALL_CONTINUING_LINE,
  INSTALL_DOCKER_DID_NOT_START,
  INSTALL_DOCKER_FAILED,
  INSTALL_DOCKER_NOT_ANSWERING,
  INSTALL_DOCKER_UNTRUSTED,
  INSTALL_DONE_LINE,
  INSTALL_DOWNLOAD_FAILED,
  INSTALL_DRY_RUN_LINES,
  INSTALL_EMAIL_QUESTION,
  INSTALL_IMAGE_UNAVAILABLE,
  INSTALL_KEY_EMPTY_LINE,
  INSTALL_KEY_HELP_LINES,
  INSTALL_KEY_QUESTION,
  INSTALL_NO_ANSWER,
  INSTALL_NO_FREE_PORT,
  INSTALL_NOT_WINDOWS,
  INSTALL_PAGE_FAILED,
  INSTALL_PASSWORD_AGAIN_QUESTION,
  INSTALL_PASSWORD_MISMATCH_LINE,
  INSTALL_PASSWORD_QUESTION,
  INSTALL_PHONE_QUESTION,
  INSTALL_RELEASE_DOWNLOAD_FAILED,
  INSTALL_RESTART_NEEDED,
  INSTALL_SOURCE_FAILED,
  INSTALL_SOURCE_MISSING,
  INSTALL_YES_OR_NO_LINE,
  installPasswordProblem,
  problemText,
} from '../messages.ts';
import type { FetchBytes } from '../release/download.ts';
import { fetchLatestManifest, fetchReleaseFile, sourceArchiveName } from '../release/download.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';
import { StateDockerError, StateImageError, type StateStore, type StateSummary } from '../state/state.ts';
import { SETUP_IMAGE, SOURCE_DIR, SOURCE_VOLUME, STATE_VOLUME, VOLUME_HOME } from '../state/volumeBackend.ts';
import { runAdopt } from './adopt.ts';
import { runNetwork } from './network.ts';
import { httpsAddress, recordedPort, runOpen, servesHttps } from './open.ts';
import { runUpgrade } from './upgrade.ts';

export interface InstallDeps extends DoctorDeps {
  host: Host;
  runner: ProcessRunner;
  store: StateStore;
  print: (line: string) => void;
  // The Windows host jobs: Docker Desktop's installer, the resume
  // entry, the shortcuts and the rest are theirs, as every Windows
  // command's are.
  jobs: WindowsJobs;
  // The health check open waits for, and the wait between tries.
  probeHealth: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  // Asks one question on the terminal and answers what was typed, or
  // null when the terminal closed without an answer. The secret form
  // does not show what is typed.
  ask: (question: string) => Promise<string | null>;
  askSecret: (question: string) => Promise<string | null>;
  // The upgrade step's wiring, the same main wires for aman upgrade:
  // its one question, its downloads, and the folder the program lives
  // in (null keeps the step to the folder the jobs name).
  confirm: (question: string) => Promise<boolean>;
  fetchBytes: FetchBytes;
  programsDir: string | null;
  arch: string;
  // The network step's wiring, the same main wires for aman network.
  interfaces: Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>>;
  hostName: string;
  // Only a test sets this; the shipped command checks downloads
  // against the release key compiled into the executable.
  releasePublicKey?: string;
}

// How long the first install waits for Docker Desktop to answer after
// it is started: it is installing, or showing its terms, or the
// computer is coming back from a restart, all slower than a plain
// start. Polled every two seconds, as the other waits poll.
const DOCKER_WAIT_SECONDS = 600;
const POLL_MS = 2000;

// The unpack the upgrade runs, with its own words here because the
// two flows are judged apart: clear the source volume, pour the
// archive in from stdin, drop its one top folder, and prove the
// installer is there before anything runs it.
const UNPACK_SCRIPT =
  'cd /src || exit 1; rm -rf -- * .[!.]*; tar -xzf - --strip-components=1 && test -f installer/install.sh';

async function dockerAnswers(runner: ProcessRunner): Promise<boolean> {
  const result = await runner.run('docker', ['info', '--format', '{{.ServerVersion}}']);
  return result.started && result.exitCode === 0;
}

// Downloads Docker Desktop, proves it came from Docker Inc before it
// runs, and sets the resume entry before the quiet install: if the
// install restarts the computer, the setup opens again by itself and
// carries on. The installer's own ending is not judged here; whether
// Docker answers afterwards is the test, as everywhere else.
async function installDockerDesktop(deps: InstallDeps): Promise<boolean> {
  const { jobs, print } = deps;
  const bytes = await deps.fetchBytes(DOCKER_DESKTOP_DOWNLOAD_URL);
  if (bytes === null) {
    print(problemText(INSTALL_DOWNLOAD_FAILED));
    return false;
  }
  try {
    await jobs.writeDockerDesktopInstaller(bytes);
  } catch (error) {
    if (error instanceof WindowsJobError) {
      print(problemText(INSTALL_DOCKER_FAILED));
      return false;
    }
    throw error;
  }
  const signer = await jobs.dockerDesktopInstallerSigner().catch(() => null);
  if (signer?.includes('Docker Inc') !== true) {
    print(problemText(INSTALL_DOCKER_UNTRUSTED));
    return false;
  }
  await jobs.ensureRunOnceResume().catch(() => undefined);
  await jobs.keepComputerAwake().catch(() => undefined);
  const run = await deps.runner.run(jobs.dockerDesktopInstallerPath, ['install', '--quiet', '--accept-license']);
  if (!run.started) {
    print(problemText(INSTALL_DOCKER_FAILED));
    return false;
  }
  return true;
}

// Docker ready to work: installed (installing it first when it is
// missing), started, and answering. A run opened by the resume entry
// says so, and the entry is taken down once Docker answers, whichever
// run set it.
async function ensureDockerReady(deps: InstallDeps, options: { resumed: boolean }): Promise<boolean> {
  const { jobs, runner, print } = deps;
  let installedByUs = false;
  const version = await runner.run('docker', ['--version']);
  if (!version.started || version.exitCode !== 0) {
    if (!(await installDockerDesktop(deps))) {
      return false;
    }
    installedByUs = true;
  }
  if (!(await dockerAnswers(runner))) {
    try {
      await jobs.startDockerDesktop();
    } catch (error) {
      if (error instanceof WindowsJobError) {
        print(problemText(installedByUs ? INSTALL_RESTART_NEEDED : INSTALL_DOCKER_DID_NOT_START));
        return false;
      }
      throw error;
    }
    const deadline = deps.now() + DOCKER_WAIT_SECONDS;
    let answered = false;
    for (;;) {
      if (await dockerAnswers(runner)) {
        answered = true;
        break;
      }
      if (deps.now() >= deadline) {
        break;
      }
      await deps.sleep(POLL_MS);
    }
    if (!answered) {
      print(problemText(installedByUs ? INSTALL_RESTART_NEEDED : INSTALL_DOCKER_DID_NOT_START));
      return false;
    }
  }
  if (options.resumed || installedByUs) {
    await jobs.clearRunOnceResume().catch(() => undefined);
  }
  return true;
}

interface Answers {
  email: string;
  password: string;
  key: string;
  phone: boolean;
}

// The plan's four questions, one at a time, each prompt ending with a
// colon. The password is judged by the shell installer's own rule
// here, at the question, and asked again while it falls short or the
// two typings differ. The key may be empty. Nothing else is asked:
// ports are picked, the instance is main, and backups are daily.
async function askQuestions(deps: InstallDeps): Promise<Answers | null> {
  const { print } = deps;
  let email = '';
  while (email === '') {
    const answer = await deps.ask(INSTALL_EMAIL_QUESTION);
    if (answer === null) {
      return null;
    }
    email = answer.trim();
  }
  let password: string | null = null;
  while (password === null) {
    const first = await deps.askSecret(INSTALL_PASSWORD_QUESTION);
    if (first === null) {
      return null;
    }
    const second = await deps.askSecret(INSTALL_PASSWORD_AGAIN_QUESTION);
    if (second === null) {
      return null;
    }
    const problem = installPasswordProblem(first);
    if (problem !== null) {
      print(problem);
      continue;
    }
    if (first !== second) {
      print(INSTALL_PASSWORD_MISMATCH_LINE);
      continue;
    }
    password = first;
  }
  for (const line of INSTALL_KEY_HELP_LINES) {
    print(line);
  }
  const keyAnswer = await deps.askSecret(INSTALL_KEY_QUESTION);
  if (keyAnswer === null) {
    return null;
  }
  const key = keyAnswer.trim();
  if (key === '') {
    print(INSTALL_KEY_EMPTY_LINE);
  }
  let phone: boolean | null = null;
  while (phone === null) {
    const answer = await deps.ask(INSTALL_PHONE_QUESTION);
    if (answer === null) {
      return null;
    }
    const word = answer.trim().toLowerCase();
    if (word === 'yes' || word === 'y') {
      phone = true;
    } else if (word === 'no' || word === 'n') {
      phone = false;
    } else {
      print(INSTALL_YES_OR_NO_LINE);
    }
  }
  return { email, password, key, phone };
}

// The newest release's source, fetched and checked the way the
// upgrade fetches it, and unpacked into the source volume the
// container install runs from. This side's only write to a volume,
// finished before the install container starts.
async function unpackNewestSource(deps: InstallDeps): Promise<boolean> {
  const { print } = deps;
  const latest = await fetchLatestManifest({
    fetchBytes: deps.fetchBytes,
    ...(deps.releasePublicKey === undefined ? {} : { publicKeyBase64: deps.releasePublicKey }),
  });
  if ('unreachable' in latest) {
    print(problemText(INSTALL_RELEASE_DOWNLOAD_FAILED));
    return false;
  }
  if ('problem' in latest) {
    print(problemText(latest.problem));
    return false;
  }
  const archiveName = sourceArchiveName(latest.manifest);
  if (archiveName === null) {
    print(problemText(INSTALL_SOURCE_MISSING));
    return false;
  }
  const download = await fetchReleaseFile({
    fetchBytes: deps.fetchBytes,
    manifest: latest.manifest,
    name: archiveName,
  });
  if ('unreachable' in download) {
    print(problemText(INSTALL_RELEASE_DOWNLOAD_FAILED));
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
    print(problemText(INSTALL_DOCKER_NOT_ANSWERING));
    return false;
  }
  if (unpack.exitCode !== 0) {
    print(problemText(INSTALL_SOURCE_FAILED));
    return false;
  }
  return true;
}

// The install itself, run by the shell inside the setup container
// with the upgrade's container shape plus the input the answers ride
// on: the password on the first line, and the key on the second, in
// the order the shell reads them, only when a key was given. The
// secrets are never on the command line and never printed here; the
// shell's own output is shown as it stands.
async function runContainerInstall(deps: InstallDeps, answers: Answers): Promise<number> {
  const { jobs, print } = deps;
  let ports: { appPort: number; loginPort: number };
  try {
    ports = await pickInstallPorts({ isFree: port => jobs.portIsFree(port) });
  } catch (error) {
    if (error instanceof NoFreePortError) {
      print(problemText(INSTALL_NO_FREE_PORT));
      return 1;
    }
    throw error;
  }
  const args = firstInstallArgs({
    email: answers.email,
    appPort: ports.appPort,
    loginPort: ports.loginPort,
    hasKey: answers.key !== '',
  });
  const stdin = answers.key === '' ? `${answers.password}\n` : `${answers.password}\n${answers.key}\n`;
  const result = await deps.runner.runBytes(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      `${STATE_VOLUME}:${VOLUME_HOME}`,
      '-v',
      `${SOURCE_VOLUME}:${SOURCE_DIR}`,
      '-w',
      SOURCE_DIR,
      SETUP_IMAGE,
      ...args,
    ],
    new TextEncoder().encode(stdin),
  );
  if (!result.started) {
    print(problemText(INSTALL_DOCKER_NOT_ANSWERING));
    return 1;
  }
  const stdout = new TextDecoder().decode(result.stdout);
  for (const line of stdout.split('\n')) {
    if (line.trim() !== '') {
      print(line);
    }
  }
  for (const line of result.stderr.split('\n')) {
    if (line.trim() !== '') {
      print(line);
    }
  }
  if (result.exitCode === 0) {
    return 0;
  }
  const combined = `${stdout}\n${result.stderr}`;
  if (combined.includes('Another install is running right now')) {
    print(problemText(INSTALL_BUSY));
    return 1;
  }
  print(problemText(INSTALL_CONTAINER_FAILED));
  return 1;
}

// The address the getting started page names: the instance's https
// address when it serves https, as open picks it, else its address on
// this computer.
async function installedAddress(deps: InstallDeps): Promise<string | null> {
  let summary: StateSummary;
  try {
    summary = await deps.store.readSummary();
  } catch {
    return null;
  }
  const instance = summary.instances.find(candidate => candidate.name === 'main') ?? summary.instances[0];
  if (instance === undefined) {
    return null;
  }
  if (servesHttps(instance.entries)) {
    const https = httpsAddress(instance.entries);
    if (https !== null) {
      return https;
    }
  }
  const port = recordedPort(instance.entries);
  return port === null ? null : `http://127.0.0.1:${String(port)}`;
}

// What the earlier stages of this chain do, in their order, once the
// install is in: adopt puts the command and the entries in place (and
// turns the daily backup on), the upgrade step finds the program
// already at the newest release, the folder Aman keeps on this
// computer is made private, open sets the trust and opens the
// browser, and the home network is opened when the person said yes.
// The getting started page belongs to a first install this run made;
// a run that found Aman already installed finishes the same steps
// without it.
async function finishInstall(deps: InstallDeps, options: { phone: boolean; page: boolean }): Promise<number> {
  const { jobs, print } = deps;
  const adoptCode = await runAdopt({ host: deps.host, store: deps.store, jobs, print });
  if (adoptCode !== 0) {
    return adoptCode;
  }
  const upgradeCode = await runUpgrade({
    ...deps,
    jobs,
    programsDir: deps.programsDir ?? win32.dirname(jobs.programsExePath),
    ...(deps.releasePublicKey === undefined ? {} : { releasePublicKey: deps.releasePublicKey }),
  });
  if (upgradeCode !== 0) {
    return upgradeCode;
  }
  try {
    await jobs.makeFolderPrivate(jobs.dataDir);
    print(FILES_MADE_PRIVATE_LINE);
  } catch (error) {
    if (error instanceof WindowsJobError) {
      print(problemText(FILES_COULD_NOT_FIX));
      return 1;
    }
    throw error;
  }
  const openCode = await runOpen({ ...deps, jobs });
  if (openCode !== 0) {
    return openCode;
  }
  if (options.phone) {
    const networkCode = await runNetwork(
      { ...deps, jobs, interfaces: deps.interfaces, hostName: deps.hostName },
      { mode: 'open' },
    );
    if (networkCode !== 0) {
      return networkCode;
    }
  }
  if (!options.page) {
    return 0;
  }
  const address = await installedAddress(deps);
  if (address === null) {
    print(problemText(INSTALL_PAGE_FAILED));
    return 1;
  }
  try {
    await jobs.writeGettingStartedPage(gettingStartedPage(address));
    await jobs.openBrowser(`file:///${jobs.gettingStartedPath.replaceAll('\\', '/')}`);
  } catch (error) {
    if (error instanceof WindowsJobError) {
      print(problemText(INSTALL_PAGE_FAILED));
      return 1;
    }
    throw error;
  }
  print(INSTALL_DONE_LINE);
  return 0;
}

// aman install: the first install, what Aman-Setup.exe does on a
// computer with no Aman yet. Docker Desktop is detected or installed,
// the memory check runs before the first question, the plan's four
// questions are asked, and the shell's installer runs in the setup
// container with the starter's command line plus https on this
// computer and daily backups. The stages before it in this chain then
// run in their order, and a getting started page opens at the end.
// A run that finds Aman already installed finishes those same stages
// instead of asking anything.
export async function runInstall(deps: InstallDeps, options: { dryRun: boolean }): Promise<number> {
  const { host, jobs, store, print } = deps;
  if (host.kind !== 'windows') {
    print(problemText(INSTALL_NOT_WINDOWS));
    return 1;
  }
  if (options.dryRun) {
    for (const line of INSTALL_DRY_RUN_LINES) {
      print(line);
    }
    return 0;
  }
  const resumed = await jobs.runOnceResumePending().catch(() => false);
  if (resumed) {
    print(INSTALL_CONTINUING_LINE);
  }
  if (!(await ensureDockerReady(deps, { resumed }))) {
    return 1;
  }
  if ((await checkDocker(deps)) !== 0) {
    return 1;
  }
  let summary: StateSummary | null = null;
  try {
    summary = await store.readSummary();
  } catch (error) {
    if (error instanceof StateImageError) {
      print(problemText(INSTALL_IMAGE_UNAVAILABLE));
      return 1;
    }
    if (!(error instanceof StateDockerError)) {
      throw error;
    }
  }
  if (summary !== null && !summary.releaseUnreadable && (summary.release !== null || summary.instances.length > 0)) {
    return finishInstall(deps, { phone: false, page: false });
  }
  const answers = await askQuestions(deps);
  if (answers === null) {
    print(problemText(INSTALL_NO_ANSWER));
    return 1;
  }
  if (!(await unpackNewestSource(deps))) {
    return 1;
  }
  await jobs.keepComputerAwake().catch(() => undefined);
  const installCode = await runContainerInstall(deps, answers);
  if (installCode !== 0) {
    return installCode;
  }
  return finishInstall(deps, { phone: answers.phone, page: true });
}

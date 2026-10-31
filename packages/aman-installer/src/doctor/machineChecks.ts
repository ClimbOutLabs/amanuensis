import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { registryValue, type InstanceRecord, type StateSummary } from '../state/state.ts';
import type { CheckList, DoctorDeps, MachineContext } from './doctor.ts';

// The machine checks of installer/doctor/aman, in the shell's order, with
// the shell's words: the two doctors agree check for check, so a report
// reads the same whichever one produced it. The shell script is the
// oracle; nothing here adds, drops or reorders a check.

export const INSTANCE_FIX = 'Run aman doctor instance --fix';

const GIB = 1024 * 1024 * 1024;
const DOCKER_MEM_FAIL_BYTES = 6 * GIB;
const DOCKER_MEM_WARN_BYTES = 8 * GIB;
const DOCKER_MIN_COMPOSE_MAJOR = 2;
const CLOCK_WARN_SECONDS = 60;
const CLOCK_FAIL_SECONDS = 300;
const BACKUP_WARN_DAYS = 7;
const INFO_FORMAT =
  '{{.ServerVersion}}|{{.Architecture}}|{{.SecurityOptions}}|{{.DockerRootDir}}|{{.SystemTime}}|{{.OperatingSystem}}|{{.MemTotal}}';
export const PS_FORMAT = '{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}|{{.Label "com.docker.compose.service"}}';

interface Captured {
  started: boolean;
  exitCode: number;
  stdout: string;
  combined: string;
}

// One command, captured the way the shell captures it: the combined text
// has stdout and stderr together, and the trailing newlines a command
// substitution would strip are stripped.
async function capture(deps: DoctorDeps, command: string, args: readonly string[]): Promise<Captured> {
  const result = await deps.runner.run(command, args);
  return {
    started: result.started,
    exitCode: result.exitCode,
    stdout: result.stdout.replace(/\n+$/, ''),
    combined: (result.stdout + result.stderr).replace(/\n+$/, ''),
  };
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

// The shell's file probes ([ -r ], [ -d ], stat) answer no on any error, so
// these helpers do the same instead of throwing.
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

function normalizeArch(arch: string): string {
  if (arch === 'x86_64' || arch === 'amd64') {
    return 'amd64';
  }
  if (arch === 'aarch64' || arch === 'arm64') {
    return 'arm64';
  }
  return arch;
}

function formatGb(kb: number): string {
  return `${(kb / 1048576).toFixed(1)} GB`;
}

// The one command that fixes a Docker problem where it can be fixed from
// here (Debian and Ubuntu); elsewhere what to open.
async function dockerFixHint(deps: DoctorDeps, mode: 'install' | 'running' | 'compose'): Promise<string> {
  const release = await readTextOrNull(deps.osReleasePath);
  if (release !== null && /^ID="?(debian|ubuntu)/m.test(release)) {
    return 'Run aman doctor docker --fix';
  }
  if (mode === 'running') {
    return 'Open Docker Desktop and wait until it says it is running, then run aman doctor.';
  }
  return 'Install Docker Desktop (macOS, Windows) or Docker Engine with Compose 2 (Linux), then run aman doctor.';
}

async function checkDocker(deps: DoctorDeps, list: CheckList, ctx: MachineContext): Promise<void> {
  const info = await capture(deps, 'docker', ['info', '--format', INFO_FORMAT]);
  if (!info.started) {
    list.record({
      scope: 'machine',
      id: 'docker',
      state: 'fail',
      detail: 'Docker is not installed.',
      fix: await dockerFixHint(deps, 'install'),
    });
    return;
  }
  const fields = info.stdout.split('|');
  const version = fields[0] ?? '';
  if (info.exitCode !== 0 || version === '') {
    const out = info.combined;
    if (out.includes('permission denied')) {
      list.record({
        scope: 'machine',
        id: 'docker',
        state: 'fail',
        detail: 'Your user cannot use Docker yet.',
        fix: 'Run aman doctor docker --fix',
      });
    } else if (
      out.includes('Cannot connect') ||
      out.includes('daemon running') ||
      out.includes('error during connect') ||
      out.includes('connection refused')
    ) {
      list.record({
        scope: 'machine',
        id: 'docker',
        state: 'fail',
        detail: 'Docker is installed, but it is not running.',
        fix: await dockerFixHint(deps, 'running'),
      });
    } else {
      list.record({
        scope: 'machine',
        id: 'docker',
        state: 'fail',
        detail: `Docker did not answer: ${firstLine(out)}`,
        fix: await dockerFixHint(deps, 'running'),
      });
    }
    return;
  }
  ctx.dockerArch = normalizeArch(fields[1] ?? '');
  ctx.dockerSecurity = fields[2] ?? '';
  ctx.dockerRoot = fields[3] ?? '';
  ctx.dockerSystemTime = fields[4] ?? '';
  ctx.dockerOs = fields[5] ?? '';
  ctx.dockerMem = fields.slice(6).join('|');
  ctx.dockerVersion = version;
  const composeResult = await capture(deps, 'docker', ['compose', 'version', '--short']);
  let compose = composeResult.stdout;
  if (compose.startsWith('v')) {
    compose = compose.slice(1);
  }
  const majorMatch = /^(\d+)\.\d+/.exec(compose);
  const composeMajor =
    composeResult.exitCode === 0 && majorMatch !== null ? Number.parseInt(majorMatch[1] ?? '0', 10) : 0;
  if (composeMajor < DOCKER_MIN_COMPOSE_MAJOR) {
    if (composeMajor === 0) {
      list.record({
        scope: 'machine',
        id: 'docker',
        state: 'fail',
        detail: `Docker Compose is missing; version ${String(DOCKER_MIN_COMPOSE_MAJOR)} is needed.`,
        fix: await dockerFixHint(deps, 'compose'),
      });
    } else {
      list.record({
        scope: 'machine',
        id: 'docker',
        state: 'fail',
        detail: `Docker Compose ${compose} is too old; version ${String(DOCKER_MIN_COMPOSE_MAJOR)} is needed.`,
        fix: await dockerFixHint(deps, 'compose'),
      });
    }
    return;
  }
  ctx.dockerOk = true;
  list.record({
    scope: 'machine',
    id: 'docker',
    state: 'ok',
    detail: `Docker ${version} is running and Compose ${compose} is available.`,
    fix: '',
  });
}

// On native Linux, Engine 27 and older let other devices on the network
// reach ports published to 127.0.0.1 only.
const DOCKER_MIN_LINUX_ENGINE_MAJOR = 28;

function dockerNativeLinux(deps: DoctorDeps, osName: string): boolean {
  if (deps.host.kind !== 'linux') {
    return false;
  }
  const kernel = deps.host.kernelRelease();
  if (
    kernel.includes('Microsoft') ||
    kernel.includes('microsoft') ||
    kernel.includes('WSL') ||
    kernel.includes('wsl')
  ) {
    return false;
  }
  return !/[Dd]ocker [Dd]esktop/.test(osName);
}

function engineLeaksLoopback(deps: DoctorDeps, version: string, osName: string): boolean {
  if (!dockerNativeLinux(deps, osName)) {
    return false;
  }
  const major = version.split('.')[0] ?? '';
  if (!/^\d+$/.test(major)) {
    return false;
  }
  return Number.parseInt(major, 10) < DOCKER_MIN_LINUX_ENGINE_MAJOR;
}

async function checkRuntime(deps: DoctorDeps, list: CheckList, ctx: MachineContext): Promise<void> {
  if (!ctx.dockerOk) {
    list.record({
      scope: 'machine',
      id: 'runtime',
      state: 'off',
      detail: 'Skipped: Docker is not reachable.',
      fix: '',
    });
    return;
  }
  const components = await capture(deps, 'docker', [
    'version',
    '--format',
    '{{range .Server.Components}}{{.Name}};{{end}}',
  ]);
  const cli = await capture(deps, 'docker', ['--version']);
  const text = `${components.stdout} ${cli.stdout} ${ctx.dockerOs}`.toLowerCase();
  if (text.includes('podman')) {
    list.record({
      scope: 'machine',
      id: 'runtime',
      state: 'fail',
      detail: 'Podman is not supported.',
      fix: 'Install Docker Engine or Docker Desktop and make it the docker command, then run aman doctor.',
    });
    return;
  }
  // The shell matches the raw SecurityOptions text, case-sensitively.
  if (ctx.dockerSecurity.includes('rootless')) {
    list.record({
      scope: 'machine',
      id: 'runtime',
      state: 'fail',
      detail: 'Rootless Docker is not supported.',
      fix: 'Install the regular Docker Engine or Docker Desktop and switch to it, then run aman doctor.',
    });
    return;
  }
  if (engineLeaksLoopback(deps, ctx.dockerVersion, ctx.dockerOs)) {
    list.record({
      scope: 'machine',
      id: 'runtime',
      state: 'fail',
      detail: `Docker Engine ${ctx.dockerVersion} lets other devices on your network reach ports meant for this computer only. Install Docker Engine ${String(DOCKER_MIN_LINUX_ENGINE_MAJOR)} or newer (install.sh --print-root-steps shows the steps), then run this again.`,
      fix: 'Install a current Docker Engine (install.sh --print-root-steps shows the steps), then run aman doctor.',
    });
    return;
  }
  list.record({
    scope: 'machine',
    id: 'runtime',
    state: 'ok',
    detail: 'A supported Docker runtime is in use.',
    fix: '',
  });
}

async function checkCredentials(deps: DoctorDeps, list: CheckList): Promise<void> {
  const config = await readTextOrNull(join(deps.dockerConfigDir, 'config.json'));
  if (config === null) {
    list.record({
      scope: 'machine',
      id: 'credentials',
      state: 'ok',
      detail: 'No Docker settings file, so no credential store is in use.',
      fix: '',
    });
    return;
  }
  const storeMatch = /"credsStore"\s*:\s*"([^"]*)"/.exec(config);
  const store = storeMatch === null ? '' : (storeMatch[1] ?? '');
  if (store === '') {
    list.record({
      scope: 'machine',
      id: 'credentials',
      state: 'ok',
      detail: 'Docker uses no credential store.',
      fix: '',
    });
    return;
  }
  const helper = `docker-credential-${store}`;
  const answer = await capture(deps, helper, ['list']);
  if (!answer.started) {
    list.record({
      scope: 'machine',
      id: 'credentials',
      state: 'fail',
      detail: `Docker is set to use the credential store "${store}", but ${helper} is not on PATH; image downloads will fail with "error getting credentials".`,
      fix: 'Open Docker Desktop and wait until it says it is running, then run aman doctor.',
    });
    return;
  }
  if (answer.exitCode !== 0) {
    list.record({
      scope: 'machine',
      id: 'credentials',
      state: 'fail',
      detail: `The credential store "${store}" is installed but did not answer; image downloads will fail.`,
      fix: 'Open Docker Desktop and unlock your keychain, then run aman doctor.',
    });
    return;
  }
  list.record({
    scope: 'machine',
    id: 'credentials',
    state: 'ok',
    detail: `The Docker credential store "${store}" answers.`,
    fix: '',
  });
}

async function checkImages(
  deps: DoctorDeps,
  list: CheckList,
  ctx: MachineContext,
  summary: StateSummary,
): Promise<void> {
  if (!ctx.dockerOk) {
    list.record({ scope: 'machine', id: 'images', state: 'off', detail: 'Skipped: Docker is not reachable.', fix: '' });
    return;
  }
  if (summary.release === null && !summary.releaseUnreadable) {
    list.record({
      scope: 'machine',
      id: 'images',
      state: 'warn',
      detail: 'No release record was found, so the expected images are unknown.',
      fix: 'Run install.sh again from the folder Aman was installed from.',
    });
    return;
  }
  const keys: [string, string | null][] = [
    ['app_image', summary.release?.appImage ?? null],
    ['dex_image', summary.release?.dexImage ?? null],
    ['stt_image', summary.release?.sttImage ?? null],
  ];
  let checked = 0;
  let missing = '';
  let wrongArch = '';
  for (const [key, ref] of keys) {
    if (ref === null) {
      continue;
    }
    checked += 1;
    const out = await capture(deps, 'docker', ['image', 'inspect', '--format', '{{.Architecture}}', ref]);
    if (out.exitCode !== 0) {
      missing += ` ${key}`;
      continue;
    }
    const imageArch = normalizeArch(out.stdout.trim());
    if (ctx.dockerArch !== '' && imageArch !== ctx.dockerArch) {
      wrongArch += ` ${key}(${imageArch})`;
    }
  }
  if (checked === 0) {
    list.record({
      scope: 'machine',
      id: 'images',
      state: 'warn',
      detail: 'The release record lists no images.',
      fix: 'Run install.sh again from the folder Aman was installed from.',
    });
  } else if (missing !== '') {
    list.record({
      scope: 'machine',
      id: 'images',
      state: 'fail',
      detail: `Some of Aman is not built on this computer:${missing}.`,
      fix: 'Run aman upgrade',
    });
  } else if (wrongArch !== '') {
    list.record({
      scope: 'machine',
      id: 'images',
      state: 'fail',
      detail: `Images built for another CPU type than Docker uses (${ctx.dockerArch}):${wrongArch}.`,
      fix: 'Run aman upgrade',
    });
  } else {
    list.record({
      scope: 'machine',
      id: 'images',
      state: 'ok',
      detail: `All ${String(checked)} images are ready.`,
      fix: '',
    });
  }
}

async function checkDisk(deps: DoctorDeps, list: CheckList, ctx: MachineContext): Promise<void> {
  if (!ctx.dockerOk) {
    list.record({ scope: 'machine', id: 'disk', state: 'off', detail: 'Skipped: Docker is not reachable.', fix: '' });
    return;
  }
  const rootStats = ctx.dockerRoot === '' ? null : await statOrNull(ctx.dockerRoot);
  if (rootStats?.isDirectory() !== true) {
    list.record({
      scope: 'machine',
      id: 'disk',
      state: 'off',
      detail: 'Docker keeps its data inside a virtual machine here; free space is checked per instance.',
      fix: '',
    });
    return;
  }
  const df = await capture(deps, 'df', ['-Pk', ctx.dockerRoot]);
  const line = df.stdout.split('\n')[1] ?? '';
  const field = line.trim().split(/\s+/)[3] ?? '';
  if (!/^\d+$/.test(field)) {
    list.record({
      scope: 'machine',
      id: 'disk',
      state: 'warn',
      detail: 'The free space for Docker data could not be read.',
      fix: 'Run aman doctor disk --fix',
    });
    return;
  }
  const kb = Number.parseInt(field, 10);
  const bytes = kb * 1024;
  if (bytes < 2 * GIB) {
    list.record({
      scope: 'machine',
      id: 'disk',
      state: 'fail',
      detail: `Only ${formatGb(kb)} is free for Docker data; installs and upgrades will fail.`,
      fix: 'Run aman doctor disk --fix',
    });
  } else if (bytes < 10 * GIB) {
    list.record({
      scope: 'machine',
      id: 'disk',
      state: 'warn',
      detail: `${formatGb(kb)} is free for Docker data; 10 GB is recommended.`,
      fix: 'Run aman doctor disk --fix',
    });
  } else {
    list.record({
      scope: 'machine',
      id: 'disk',
      state: 'ok',
      detail: `${formatGb(kb)} is free for Docker data.`,
      fix: '',
    });
  }
}

function checkDockerMemory(list: CheckList, ctx: MachineContext): void {
  const fix = 'Raise it in Docker Desktop under Settings, Resources, Memory. On Linux, free up memory or add swap.';
  if (!ctx.dockerOk) {
    list.record({
      scope: 'machine',
      id: 'docker_memory',
      state: 'off',
      detail: 'Skipped: Docker is not reachable.',
      fix: '',
    });
    return;
  }
  if (!/^\d+$/.test(ctx.dockerMem)) {
    list.record({
      scope: 'machine',
      id: 'docker_memory',
      state: 'off',
      detail: 'Skipped: Docker did not report how much memory it has.',
      fix: '',
    });
    return;
  }
  const mem = Number.parseInt(ctx.dockerMem, 10);
  const gb = (mem / GIB).toFixed(1);
  if (mem < DOCKER_MEM_FAIL_BYTES) {
    list.record({
      scope: 'machine',
      id: 'docker_memory',
      state: 'fail',
      detail: `Docker has only ${gb} GB of memory; building the app needs at least 6 GB.`,
      fix: fix,
    });
  } else if (mem < DOCKER_MEM_WARN_BYTES) {
    list.record({
      scope: 'machine',
      id: 'docker_memory',
      state: 'warn',
      detail: `Docker has ${gb} GB of memory; 8 GB is recommended for builds and upgrades.`,
      fix: fix,
    });
  } else {
    list.record({
      scope: 'machine',
      id: 'docker_memory',
      state: 'ok',
      detail: `Docker has ${gb} GB of memory.`,
      fix: '',
    });
  }
}

// Days-from-civil arithmetic, the shell's rfc3339_to_epoch, so no date
// flags are needed on any system.
function rfc3339ToEpoch(value: string): number | null {
  const tAt = value.indexOf('T');
  if (tAt === -1) {
    return null;
  }
  const datePart = value.slice(0, tAt);
  let rest = value.slice(tAt + 1);
  let sign = 0;
  let offsetText = '';
  if (rest.endsWith('Z')) {
    rest = rest.slice(0, -1);
  } else if (rest.lastIndexOf('+') > 0) {
    sign = 1;
    offsetText = rest.slice(rest.lastIndexOf('+') + 1);
    rest = rest.slice(0, rest.lastIndexOf('+'));
  } else if (rest.lastIndexOf('-') > 0) {
    sign = -1;
    offsetText = rest.slice(rest.lastIndexOf('-') + 1);
    rest = rest.slice(0, rest.lastIndexOf('-'));
  } else {
    return null;
  }
  const timePart = (rest.split('.')[0] ?? '').split(':');
  const dateFields = datePart.split('-');
  const [yText, mText, dText] = dateFields;
  const [hhText, mmText, ssText] = timePart;
  const digits = (text: string | undefined): text is string => text !== undefined && /^\d+$/.test(text);
  if (
    dateFields.length !== 3 ||
    timePart.length !== 3 ||
    !digits(yText) ||
    !digits(mText) ||
    !digits(dText) ||
    !digits(hhText) ||
    !digits(mmText) ||
    !digits(ssText)
  ) {
    return null;
  }
  let offset = 0;
  if (offsetText !== '') {
    const [ohText, omText] = offsetText.split(':');
    if (!digits(ohText) || !digits(omText)) {
      return null;
    }
    offset = sign * (Number.parseInt(ohText, 10) * 3600 + Number.parseInt(omText, 10) * 60);
  }
  let y = Number.parseInt(yText, 10);
  const m = Number.parseInt(mText, 10);
  const d = Number.parseInt(dText, 10);
  if (m <= 2) {
    y -= 1;
  }
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468;
  return (
    days * 86400 +
    Number.parseInt(hhText, 10) * 3600 +
    Number.parseInt(mmText, 10) * 60 +
    Number.parseInt(ssText, 10) -
    offset
  );
}

function checkClock(deps: DoctorDeps, list: CheckList, ctx: MachineContext): void {
  if (!ctx.dockerOk) {
    list.record({ scope: 'machine', id: 'clock', state: 'off', detail: 'Skipped: Docker is not reachable.', fix: '' });
    return;
  }
  const daemon = rfc3339ToEpoch(ctx.dockerSystemTime);
  if (daemon === null) {
    list.record({
      scope: 'machine',
      id: 'clock',
      state: 'off',
      detail: 'Skipped: Docker did not report a readable time.',
      fix: '',
    });
    return;
  }
  const skew = Math.abs(deps.now() - daemon);
  const fix =
    'Turn on automatic time sync in your system settings (with Docker Desktop, restart it: its clock drifts after the computer sleeps).';
  if (skew > CLOCK_FAIL_SECONDS) {
    list.record({
      scope: 'machine',
      id: 'clock',
      state: 'fail',
      detail: `This machine and Docker disagree on the time by ${String(skew)} seconds; sign-in will fail.`,
      fix: fix,
    });
  } else if (skew > CLOCK_WARN_SECONDS) {
    list.record({
      scope: 'machine',
      id: 'clock',
      state: 'warn',
      detail: `This machine and Docker disagree on the time by ${String(skew)} seconds.`,
      fix: fix,
    });
  } else {
    list.record({
      scope: 'machine',
      id: 'clock',
      state: 'ok',
      detail: 'This machine and Docker agree on the time.',
      fix: '',
    });
  }
}

// A path for a person to read: the home folder becomes ~.
function uiPath(deps: DoctorDeps, path: string): string {
  if (path === deps.homeDir) {
    return '~';
  }
  if (path.startsWith(`${deps.homeDir}/`)) {
    return `~${path.slice(deps.homeDir.length)}`;
  }
  return path;
}

// True when any of the three schedules the installer can make is in place:
// a systemd timer that is enabled, a launchd agent, or a crontab line.
// The shell tests for a file with [ -f ]; a folder at either path does
// not count.
async function backupSchedulePresent(deps: DoctorDeps): Promise<boolean> {
  const timer = join(deps.homeDir, '.config/systemd/user/aman-backup.timer');
  if ((await statOrNull(timer))?.isFile() === true) {
    const enabled = await capture(deps, 'systemctl', ['--user', 'is-enabled', 'aman-backup.timer']);
    if (enabled.started && enabled.exitCode === 0) {
      return true;
    }
  }
  const agent = join(deps.homeDir, 'Library/LaunchAgents/com.amanuensis.backup.plist');
  if ((await statOrNull(agent))?.isFile() === true) {
    return true;
  }
  const cron = await deps.runner.run('crontab', ['-l']);
  return cron.started && cron.stdout.includes('# amanuensis-backup');
}

// A schedule turned on within the last two days has not had its first run
// yet. The store reads the record's own time on a folder home.
function backupModeIsRecent(deps: DoctorDeps, summary: StateSummary): boolean {
  const time = summary.backupsModeTimeSeconds;
  return time !== null && deps.now() - time < 172800;
}

async function checkBackup(deps: DoctorDeps, list: CheckList, summary: StateSummary): Promise<void> {
  // Backups are made of instances; before the first one exists there is
  // nothing to be late.
  if (summary.instances.length === 0) {
    list.record({
      scope: 'machine',
      id: 'backup',
      state: 'ok',
      detail: 'No instances yet; nothing to back up.',
      fix: '',
    });
    return;
  }
  const facts = { entries: summary.backupEntries };
  let newest = '';
  let newestTime = 0;
  for (const entry of facts.entries) {
    if (entry.timeSeconds !== null && entry.timeSeconds > newestTime) {
      newestTime = entry.timeSeconds;
      newest = entry.name;
    }
  }
  const now = deps.now();
  // The shell divides whole numbers, which drops the fraction toward
  // zero: a backup newer than this computer's clock is 0 days old there,
  // never -1, so the count is cut the same way here.
  const ageDays = newest === '' ? -1 : Math.trunc((now - newestTime) / 86400);
  const days = ageDays === 1 ? '1 day' : `${String(ageDays)} days`;
  const scheduled = await backupSchedulePresent(deps);
  const mode = summary.backupsMode ?? '';
  if (mode === 'daily') {
    if (!scheduled) {
      list.record({
        scope: 'machine',
        id: 'backup',
        state: 'warn',
        detail: 'Daily backups are on, but the schedule that runs them is missing.',
        fix: 'Run aman doctor backup --fix',
      });
    } else if (ageDays < 0 && backupModeIsRecent(deps, summary)) {
      list.record({
        scope: 'machine',
        id: 'backup',
        state: 'ok',
        detail: 'Daily backups are on; the first one runs within a day.',
        fix: '',
      });
    } else if (ageDays < 0) {
      list.record({
        scope: 'machine',
        id: 'backup',
        state: 'warn',
        detail: 'Daily backups are scheduled, but none has been made yet.',
        fix: 'Run aman doctor backup --fix',
      });
    } else if (ageDays > 2) {
      const newestPath = join(deps.stateHome, 'backups', newest);
      list.record({
        scope: 'machine',
        id: 'backup',
        state: 'warn',
        detail: `Daily backups are scheduled, but the last one is ${days} old. The newest backup is in ${uiPath(deps, newestPath)}.`,
        fix: 'Run aman doctor backup --fix',
      });
    } else {
      list.record({
        scope: 'machine',
        id: 'backup',
        state: 'ok',
        detail: `Daily backups are on; the last one is ${days} old.`,
        fix: '',
      });
    }
    return;
  }
  if (mode === 'off') {
    if (ageDays > BACKUP_WARN_DAYS) {
      list.record({
        scope: 'machine',
        id: 'backup',
        state: 'warn',
        detail: `Automatic backups are off, and the last backup is ${days} old.`,
        fix: 'Run aman doctor backup --fix',
      });
    } else {
      list.record({ scope: 'machine', id: 'backup', state: 'ok', detail: 'Automatic backups are off.', fix: '' });
    }
    return;
  }
  if (newest === '') {
    list.record({
      scope: 'machine',
      id: 'backup',
      state: 'ok',
      detail: 'No backup yet; one is made automatically before your first upgrade.',
      fix: '',
    });
  } else if (ageDays > BACKUP_WARN_DAYS) {
    list.record({
      scope: 'machine',
      id: 'backup',
      state: 'warn',
      detail: `The last backup is ${days} old.`,
      fix: 'Run aman backup',
    });
  } else {
    list.record({ scope: 'machine', id: 'backup', state: 'ok', detail: `The last backup is ${days} old.`, fix: '' });
  }
}

// The sandbox slots, whichever instance they serve: reported even before
// the first instance exists. No slot containers, no line: the sandbox may
// be off, or never installed. Read-only: this never starts or repairs a
// slot, that is the shell doctor's `aman doctor sandbox --fix`.
async function checkSandbox(deps: DoctorDeps, list: CheckList, ctx: MachineContext): Promise<void> {
  if (!ctx.dockerOk) {
    return;
  }
  const ps = await capture(deps, 'docker', ['ps', '-a', '--format', PS_FORMAT]);
  let total = 0;
  let bad = '';
  for (const line of ps.stdout.split('\n')) {
    if (line === '') {
      continue;
    }
    const fields = line.split('|');
    const id = fields[0] ?? '';
    const name = fields[1] ?? '';
    const state = fields[2] ?? '';
    const status = fields[3] ?? '';
    const service = fields[4] ?? '';
    if (!service.startsWith('sandbox-') && !name.includes('-slots-sandbox-')) {
      continue;
    }
    total += 1;
    if (bad !== '') {
      continue;
    }
    if (state === 'running') {
      if (status.includes('(unhealthy)')) {
        bad = id;
      }
    } else {
      bad = id;
    }
  }
  if (total === 0) {
    return;
  }
  if (bad === '') {
    list.record({
      scope: 'machine',
      id: 'sandbox',
      state: 'ok',
      detail: `All ${String(total)} sandbox slots are running and healthy.`,
      fix: '',
    });
    return;
  }
  const logs = await capture(deps, 'docker', ['logs', '--tail', '50', bad]);
  let failedLine = '';
  for (const line of logs.combined.split('\n')) {
    const at = line.indexOf('attestation FAILED');
    if (at !== -1) {
      failedLine = line.slice(at);
      break;
    }
  }
  if (failedLine === '') {
    list.record({
      scope: 'machine',
      id: 'sandbox',
      state: 'fail',
      detail: 'One of the sandbox slots is not running properly, and its log does not say which check failed.',
      fix: 'Run aman doctor sandbox --fix',
    });
    return;
  }
  // The slot's own line names the check in the slot agent's words; say it
  // in plain words, and keep the line as it is when it does not read as a
  // check and a reason.
  let shown = failedLine;
  const prefix = 'attestation FAILED ';
  if (failedLine.startsWith(prefix)) {
    const rest = failedLine.slice(prefix.length);
    const colonAt = rest.indexOf(': ');
    if (colonAt > 0) {
      shown = `Safety check ${rest.slice(0, colonAt)} failed: ${rest.slice(colonAt + 2)}`;
    }
  }
  list.record({
    scope: 'machine',
    id: 'sandbox',
    state: 'fail',
    detail: `A sandbox slot failed: ${shown}`,
    fix: 'Run aman doctor sandbox --fix',
  });
}

interface WalkedEntry {
  isLink: boolean;
  mode: number;
  uid: number;
}

// Every entry under a folder, with the facts the checkout probe needs.
// An unreadable folder gives no entries, as the shell's find prints
// nothing for one.
async function walkEntries(root: string): Promise<WalkedEntry[]> {
  const out: WalkedEntry[] = [];
  const pending: string[] = [root];
  for (;;) {
    const dir = pending.pop();
    if (dir === undefined) {
      break;
    }
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const stats = await lstatOrNull(path);
      if (stats === null) {
        continue;
      }
      out.push({ isLink: stats.isSymbolicLink(), mode: stats.mode, uid: stats.uid });
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        pending.push(path);
      }
    }
  }
  return out;
}

// What makes the installer in the checkout folder unsafe to run, one word,
// or null when it is fine: the shell's checkout_problem, in its order.
// The folder is one the installer runs from, often with more rights than
// the person has otherwise, so it must be changeable by its owner alone.
async function checkoutProblem(dir: string): Promise<string | null> {
  const installerDir = join(dir, 'installer');
  const dirStats = await lstatOrNull(dir);
  const installerStats = await lstatOrNull(installerDir);
  const entries = await walkEntries(installerDir);
  if (
    dirStats?.isSymbolicLink() === true ||
    installerStats?.isSymbolicLink() === true ||
    entries.some(entry => entry.isLink)
  ) {
    return 'links';
  }
  const writableByOthers = (mode: number): boolean => (mode & 0o022) !== 0;
  const dirStat = await statOrNull(dir);
  const installerStat = await statOrNull(installerDir);
  if (
    (dirStat !== null && writableByOthers(dirStat.mode)) ||
    (installerStat !== null && writableByOthers(installerStat.mode)) ||
    entries.some(entry => !entry.isLink && writableByOthers(entry.mode))
  ) {
    return 'writable';
  }
  let resolved: string | null;
  try {
    resolved = await realpath(dir);
  } catch {
    resolved = null;
  }
  if (resolved !== null) {
    let ancestor = dirname(resolved);
    for (;;) {
      // The walk stops where the shell's stops: the root folder itself
      // is not judged.
      if (ancestor === '/') {
        break;
      }
      const stats = await statOrNull(ancestor);
      if (stats !== null && stats.mode & 0o022 && !(stats.mode & 0o1000)) {
        return 'parent';
      }
      ancestor = dirname(ancestor);
    }
  }
  const myUid = process.getuid?.();
  if (myUid !== undefined) {
    const ownedByOther = (uid: number): boolean => uid !== myUid && uid !== 0;
    if (
      (dirStat !== null && ownedByOther(dirStat.uid)) ||
      (installerStat !== null && ownedByOther(installerStat.uid)) ||
      entries.some(entry => ownedByOther(entry.uid))
    ) {
      return 'owner';
    }
  }
  return null;
}

const CHECKOUT_WORDS: Record<string, [string, string]> = {
  links: [
    'The installer of the folder Aman was installed from contains links, so Aman will not run it.',
    'Copy the folder to one of yours and run install.sh from there.',
  ],
  writable: [
    'The folder Aman was installed from can be changed by other users, so Aman will not run its installer from it.',
    'Run aman doctor checkout --fix',
  ],
  parent: [
    'A folder above the folder Aman was installed from can be changed by other users, so Aman will not run its installer from it.',
    'Move the folder to one only you can change, such as one inside your home folder, then run install.sh from there.',
  ],
  owner: [
    'The folder Aman was installed from belongs to another user, so Aman will not run its installer from it.',
    'Copy it to a folder of yours and run install.sh from there.',
  ],
};

// Nothing is recorded until Aman has been installed from a folder.
async function checkCheckout(list: CheckList, summary: StateSummary): Promise<void> {
  const repo = summary.sourceCheckout;
  if (repo === null) {
    return;
  }
  const installerFile = await statOrNull(join(repo, 'installer', 'install.sh'));
  if (installerFile?.isFile() !== true) {
    return;
  }
  const problem = await checkoutProblem(repo);
  if (problem === null) {
    list.record({
      scope: 'machine',
      id: 'checkout',
      state: 'ok',
      detail: 'The folder Aman was installed from can only be changed by you.',
      fix: '',
    });
    return;
  }
  const words = CHECKOUT_WORDS[problem];
  if (words !== undefined) {
    const [detail, fix] = words;
    list.record({ scope: 'machine', id: 'checkout', state: 'fail', detail, fix });
  }
}

function servesHttps(instance: InstanceRecord): boolean {
  const tls = registryValue(instance.entries, 'tls') ?? '';
  const tlsPort = registryValue(instance.entries, 'tls_port') ?? '';
  const origins = registryValue(instance.entries, 'origins') ?? '';
  return tls === 'local' && tlsPort !== '' && origins !== '';
}

function originHost(origin: string): string {
  const rest = origin.includes('://') ? origin.slice(origin.indexOf('://') + 3) : origin;
  return rest.split(/[:/]/)[0] ?? '';
}

// Https on the instances opened on the network: the authority and its key,
// the certificate (how long it lasts, which addresses it lists) and a real
// answer over https from this computer. One line for the worst thing
// found. The authority's facts come through the store; the certificate
// read mounts the state home's tls folder and the probe uses its
// certificate file.
async function checkTls(deps: DoctorDeps, list: CheckList, ctx: MachineContext, summary: StateSummary): Promise<void> {
  const serving = summary.instances.filter(servesHttps);
  if (serving.length === 0) {
    return;
  }
  const stateHome = deps.stateHome;
  const tlsFix = 'Run aman doctor tls --fix';
  const caDir = join(stateHome, 'tls/ca');
  let state = 'ok';
  let detail = '';
  let fix = '';
  // Keeps the worst: a failure always replaces, a warning only replaces
  // a pass.
  const note = (next: { state: string; detail: string; fix: string }): void => {
    if (next.state === 'fail') {
      state = next.state;
      detail = next.detail;
      fix = next.fix;
    } else if (next.state === 'warn' && state === 'ok') {
      state = next.state;
      detail = next.detail;
      fix = next.fix;
    }
  };
  const ca = summary.certificateAuthority;
  if (!ca.certPresent || ca.keyMode === null) {
    note({
      state: 'fail',
      detail: 'The certificate authority of this computer is missing, so devices cannot trust Aman.',
      fix: tlsFix,
    });
  } else if (ca.keyMode !== '600') {
    note({
      state: 'fail',
      detail: "The key of this computer's certificate authority can be read by other users.",
      fix: tlsFix,
    });
  }
  const image = summary.release?.appImage ?? '';
  const fingerprint = ca.fingerprint ?? '';
  for (const instance of serving) {
    const name = instance.name;
    if (ctx.dockerOk && image !== '' && ca.certPresent) {
      const uid = (await capture(deps, 'id', ['-u'])).stdout.trim();
      const gid = (await capture(deps, 'id', ['-g'])).stdout.trim();
      const info = await capture(deps, 'docker', [
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        `${uid}:${gid}`,
        '-v',
        `${join(stateHome, 'tls')}:/tls:ro`,
        '-v',
        `${join(stateHome, 'lib', 'pki.mjs')}:/pki.mjs:ro`,
        '--entrypoint',
        'node',
        image,
        '/pki.mjs',
        'info',
        '/tls/ca',
        `/tls/leaf/${name}`,
      ]);
      const field = (pattern: RegExp): string => {
        const match = pattern.exec(info.stdout);
        return match === null ? '' : (match[1] ?? '');
      };
      const rootDaysText = field(/"root_days_left":(-?\d+)/);
      const leafDaysText = field(/"leaf_days_left":(-?\d+)/);
      const namesText = field(/"leaf_names":\[([^\]]*)\]/)
        .replaceAll('"', '')
        .replaceAll(',', ' ');
      const constrained = field(/"root_constrained":(true|false)/);
      const covers = field(/"root_covers_leaf":(true|false)/);
      if (leafDaysText === '') {
        note({ state: 'fail', detail: `The https certificate of instance ${name} is missing.`, fix: tlsFix });
      } else {
        const leafDays = Number.parseInt(leafDaysText, 10);
        const rootDays = rootDaysText === '' ? null : Number.parseInt(rootDaysText, 10);
        // A pki answer with no root days takes the shell's substitutions:
        // -1 in the run-out test, so a missing root count reads as run
        // out, and -1000 in the warning test below.
        if (leafDays <= 0 || (rootDays ?? -1) <= 0) {
          note({
            state: 'fail',
            detail: `The https certificate of instance ${name} has run out, so devices refuse it.`,
            fix: tlsFix,
          });
        } else if (leafDays < 60 || (rootDays ?? -1000) < 60) {
          const days = leafDays < (rootDays ?? -1000) ? leafDays : (rootDays ?? -1000);
          note({
            state: 'warn',
            detail: `The https certificate of instance ${name} ends in ${String(days)} days.`,
            fix: tlsFix,
          });
        } else if (constrained === 'false') {
          note({
            state: 'warn',
            detail:
              'The certificate authority of this computer, from an earlier version, can vouch for more names than it should. A new one covers only the names Aman is opened at and private addresses; each device then trusts it again.',
            fix: tlsFix,
          });
        } else if (covers === 'false') {
          note({
            state: 'warn',
            detail: `The certificate authority of this computer does not cover every name of instance ${name}. A new one does; each device then trusts it again.`,
            fix: tlsFix,
          });
        } else {
          let missing = '';
          const origins = (registryValue(instance.entries, 'origins') ?? '').split(',');
          for (const origin of origins) {
            const host = originHost(origin);
            if (!` ${namesText} `.includes(` ${host} `)) {
              missing += ` ${host}`;
            }
          }
          if (missing !== '') {
            note({
              state: 'warn',
              detail: `The https certificate of instance ${name} does not list:${missing}.`,
              fix: tlsFix,
            });
          } else if (state === 'ok') {
            detail = `Https is on; the certificate of instance ${name} lasts ${String(leafDays)} more days, and Aman renews it in its last 60 days. Authority fingerprint, to compare on a device before trusting it: ${fingerprint}`;
          }
        }
      }
    }
    if (ca.certPresent) {
      const tlsPort = registryValue(instance.entries, 'tls_port') ?? '';
      const probe = await deps.runner.run('curl', [
        '-sS',
        '--max-time',
        '8',
        '--cacert',
        join(caDir, 'root.crt'),
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        `https://127.0.0.1:${tlsPort}/healthz`,
      ]);
      if (probe.started) {
        const lines = probe.stdout.split('\n').filter(line => line.trim() !== '');
        const status = lines[lines.length - 1] ?? '';
        if (status !== '200') {
          note({
            state: 'fail',
            detail: `Instance ${name} does not answer over https on this computer.`,
            fix: INSTANCE_FIX,
          });
        }
      }
    }
  }
  if (state === 'ok' && summary.backupsMode !== 'daily') {
    note({
      state: 'warn',
      detail:
        'Daily backups are off, so the https certificate is renewed only when you run an aman command in its last 60 days, or run aman doctor tls --fix.',
      fix: 'Run aman doctor backup --fix',
    });
  }
  if (state === 'ok' && detail === '') {
    detail = "Https is on, with a certificate from this computer's own authority.";
  }
  if (state !== 'ok' && ca.fingerprintHasContent) {
    detail += ` Authority fingerprint, to compare on a device before trusting it: ${fingerprint}`;
  }
  list.record({ scope: 'machine', id: 'tls', state: state, detail: detail, fix: fix });
}

// Every check of this computer, in the order the report shows them. This
// is the shell's check_machine set, in its order, so the report and later
// stages agree on what healthy means.
export async function runMachineChecks(
  deps: DoctorDeps,
  list: CheckList,
  summary: StateSummary,
): Promise<MachineContext> {
  const ctx: MachineContext = {
    dockerOk: false,
    dockerArch: '',
    dockerRoot: '',
    dockerSystemTime: '',
    dockerSecurity: '',
    dockerOs: '',
    dockerVersion: '',
    dockerMem: '',
  };
  await checkDocker(deps, list, ctx);
  await checkRuntime(deps, list, ctx);
  await checkCredentials(deps, list);
  await checkImages(deps, list, ctx, summary);
  await checkDisk(deps, list, ctx);
  checkDockerMemory(list, ctx);
  checkClock(deps, list, ctx);
  await checkBackup(deps, list, summary);
  await checkSandbox(deps, list, ctx);
  await checkCheckout(list, summary);
  await checkTls(deps, list, ctx, summary);
  return ctx;
}

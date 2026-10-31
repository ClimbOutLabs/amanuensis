import type { Host } from '../host/host.ts';
import { DOCTOR_STATE_UNREADABLE, STATE_BUSY, problemText, type Problem } from '../messages.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';
import { StateBusyError, type StateStore, type StateSummary } from '../state/state.ts';
import { INSTANCE_FIX, PS_FORMAT, runMachineChecks } from './machineChecks.ts';

export interface DoctorDeps {
  host: Host;
  runner: ProcessRunner;
  store: StateStore;
  print: (line: string) => void;
  // The clock, in epoch seconds: the shell doctor's AMAN_DOCTOR_NOW hook,
  // so a test can pin the time both doctors judge by.
  now: () => number;
  // The person's home folder: Docker's settings file and the backup
  // schedule are looked for under it, as the shell doctor looks.
  homeDir: string;
  // The state home as a folder on this computer: the tls check mounts
  // this folder for its certificate read and probes with its
  // certificate, and a backup line names a folder in it.
  stateHome: string;
  // The file that names the system (/etc/os-release, or the shell
  // doctor's AMAN_OS_RELEASE override).
  osReleasePath: string;
  // The folder holding Docker's settings file (DOCKER_CONFIG, or
  // ~/.docker).
  dockerConfigDir: string;
  // The compose service name of the app in an instance (the shell
  // doctor's AMAN_DOCTOR_APP_SERVICE, else app).
  appService: string;
}

// What the docker check learns, shared by the checks that follow it, as
// the shell shares its DOCKER_ variables between its checks.
export interface MachineContext {
  dockerOk: boolean;
  dockerArch: string;
  dockerRoot: string;
  dockerSystemTime: string;
  dockerSecurity: string;
  dockerOs: string;
  dockerVersion: string;
  dockerMem: string;
}

export interface CheckRecord {
  scope: string;
  id: string;
  state: string;
  detail: string;
  fix: string;
}

// One printable line's worth, as the shell's record keeps it: characters
// that do not print become spaces, and no field runs past 400 characters.
function cleanText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 400);
}

// The records of one run, in the order the checks made them.
export class CheckList {
  private readonly items: CheckRecord[] = [];

  record(entry: CheckRecord): void {
    this.items.push({ ...entry, detail: cleanText(entry.detail), fix: cleanText(entry.fix) });
  }

  all(): readonly CheckRecord[] {
    return this.items;
  }
}

// The per-instance checks come from the instance's own doctor, called
// exactly as the shell calls it: the app container is found by its
// compose project, then `aman doctor --text` runs inside it with the
// host's time, and its lines (id, state, detail, fix, tab-separated)
// become records. The host-side lines the shell adds around that call
// (settings files, the container list, ports, public and network
// addresses) are not reimplemented here; they stay with the shell
// doctor, as the plan's PR 3 scope states. A local run adds the shell's
// --local: the instance's own checks then skip the ones that reach the
// network, as the shell's health gate before an upgrade asks them to.
async function checkInstance(
  deps: DoctorDeps,
  list: CheckList,
  ctx: MachineContext,
  name: string,
  local: boolean,
): Promise<void> {
  if (!ctx.dockerOk) {
    list.record({
      scope: name,
      id: 'service',
      state: 'fail',
      detail: 'Docker is not reachable, so this instance cannot be checked.',
      fix: 'Fix the Docker problem reported under the machine checks first.',
    });
    return;
  }
  const ps = await deps.runner.run('docker', [
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=aman-${name}`,
    '--format',
    PS_FORMAT,
  ]);
  let appContainer = '';
  for (const line of ps.stdout.split('\n')) {
    const fields = line.split('|');
    if (fields[2] === 'running' && fields[4] === deps.appService) {
      appContainer = fields[0] ?? '';
    }
  }
  if (appContainer === '') {
    list.record({ scope: name, id: 'service', state: 'off', detail: 'Skipped: the app is not running.', fix: '' });
    return;
  }
  const out = await deps.runner.run('docker', [
    'exec',
    '-e',
    `AMAN_HOST_EPOCH=${String(deps.now())}`,
    appContainer,
    'aman',
    'doctor',
    '--text',
    ...(local ? ['--local'] : []),
  ]);
  const combined = (out.stdout + out.stderr).replace(/\n+$/, '');
  if (out.exitCode !== 0 && out.exitCode !== 1) {
    list.record({
      scope: name,
      id: 'service',
      state: 'fail',
      detail: `The checks could not run inside the app container: ${combined.split('\n')[0] ?? ''}`,
      fix: INSTANCE_FIX,
    });
    return;
  }
  for (const line of combined.split('\n')) {
    const fields = line.split('\t');
    const id = fields[0] ?? '';
    const state = fields[1] ?? '';
    if (state === 'ok' || state === 'warn' || state === 'fail' || state === 'off') {
      list.record({ scope: name, id, state, detail: fields[2] ?? '', fix: fields.slice(3).join('\t') });
    }
  }
}

interface CheckJson {
  id: string;
  state: string;
  detail: string;
  fix: string;
}

function checksJson(records: readonly CheckRecord[], scope: string): CheckJson[] {
  const out: CheckJson[] = [];
  for (const record of records) {
    if (record.scope === scope) {
      out.push({ id: record.id, state: record.state, detail: record.detail, fix: record.fix });
    }
  }
  return out;
}

// The --json document, the shell doctor's shape exactly: the machine
// checks as one list, then each instance's checks under its name.
export function doctorJson(records: readonly CheckRecord[], instanceNames: readonly string[]): string {
  const instances: Record<string, CheckJson[]> = {};
  for (const name of instanceNames) {
    instances[name] = checksJson(records, name);
  }
  return JSON.stringify({ machine: checksJson(records, 'machine'), instances });
}

// Checks that pass without saying anything useful are counted in the
// verdict but not shown, as in the shell's report.
const QUIET_OK_IDS: ReadonlySet<string> = new Set(['runtime', 'credentials', 'checkout']);

function plural(count: number, word: string): string {
  return count === 1 ? `1 ${word}` : `${String(count)} ${word}s`;
}

// The plain report: a phase line per scope, one line per check with the
// next step under the ones that need it, skipped checks with the same
// reason on one line, and the closing verdict in the shell's words.
export function doctorTextLines(records: readonly CheckRecord[], instanceNames: readonly string[]): string[] {
  const lines: string[] = [];
  const renderScope = ({ scope, title }: { scope: string; title: string }): void => {
    lines.push('', title);
    let skipIds: string[] = [];
    let skipDetail = '';
    const flushSkipped = (): void => {
      if (skipIds.length > 0) {
        lines.push(`${skipDetail} (${skipIds.join(', ')})`);
      }
      skipIds = [];
      skipDetail = '';
    };
    for (const record of records) {
      if (record.scope !== scope) {
        continue;
      }
      if (record.state !== 'ok' && record.state !== 'warn' && record.state !== 'fail') {
        if (skipIds.length > 0 && skipDetail !== record.detail) {
          flushSkipped();
        }
        skipDetail = record.detail;
        skipIds.push(record.id);
        continue;
      }
      flushSkipped();
      if (record.state === 'ok' && QUIET_OK_IDS.has(record.id)) {
        continue;
      }
      lines.push(record.detail);
      if (record.state !== 'ok' && record.fix !== '') {
        lines.push(`Next: ${record.fix}`);
      }
    }
    flushSkipped();
  };
  renderScope({ scope: 'machine', title: 'Checking this computer' });
  for (const name of instanceNames) {
    renderScope({ scope: name, title: `Checking instance ${name}` });
  }
  let fails = 0;
  let warns = 0;
  for (const record of records) {
    if (record.state === 'fail') {
      fails += 1;
    } else if (record.state === 'warn') {
      warns += 1;
    }
  }
  const parts: string[] = [];
  if (fails > 0) {
    parts.push(plural(fails, 'problem'));
  }
  if (warns > 0) {
    parts.push(plural(warns, 'warning'));
  }
  if (parts.length === 0) {
    lines.push('', 'All checks passed.');
  } else {
    lines.push('', `${parts.join(', ')}.`, 'Run the Next command for each, then run aman doctor again.');
  }
  return lines;
}

// The Problem a state read failure is reported with. The unreadable
// record gets the doctor's own next step, since the doctor is the
// command a person runs to find what is wrong.
export function doctorStoreProblem(error: unknown): Problem {
  if (error instanceof StateBusyError) {
    return STATE_BUSY;
  }
  return DOCTOR_STATE_UNREADABLE;
}

export interface DoctorChecks {
  summary: StateSummary;
  records: readonly CheckRecord[];
  instanceNames: readonly string[];
}

// The checks themselves, with no printing: the doctor renders them. A
// state read failure is thrown, for the caller to report with
// doctorStoreProblem.
export async function runDoctorChecks(
  deps: DoctorDeps,
  options: { local: boolean; fix?: boolean },
): Promise<DoctorChecks> {
  const summary = await deps.store.readSummary();
  const list = new CheckList();
  const ctx = await runMachineChecks(deps, list, summary);
  for (const instance of summary.instances) {
    await checkInstance(deps, list, ctx, instance.name, options.local);
  }
  return {
    summary,
    records: list.all(),
    instanceNames: summary.instances.map(instance => instance.name),
  };
}

// aman doctor: the machine checks and each instance's own checks, in one
// report. It changes nothing: unlike the shell doctor it does not save a
// host report for the app, and it takes no lock, so the state it reads is
// only read.
export async function runDoctor(
  deps: DoctorDeps,
  options: { json: boolean; local?: boolean; fix?: boolean },
): Promise<number> {
  const { print } = deps;
  let checks: DoctorChecks;
  try {
    checks = await runDoctorChecks(deps, { local: options.local ?? false, fix: options.fix ?? false });
  } catch (error) {
    print(problemText(doctorStoreProblem(error)));
    return 1;
  }
  const { records, instanceNames: names } = checks;
  if (options.json) {
    print(doctorJson(records, names));
  } else {
    for (const line of doctorTextLines(records, names)) {
      print(line);
    }
  }
  return records.some(record => record.state === 'fail') ? 1 : 0;
}

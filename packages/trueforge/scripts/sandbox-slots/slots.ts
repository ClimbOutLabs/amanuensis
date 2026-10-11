/**
 * Builds the sandbox slot image and starts the slots, so a checkout or an existing Compose deploy gets
 * isolated code execution with one command. Safe to re-run; changes no file of the user's.
 */
import { join } from 'node:path';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs one command; rejects with `CommandNotFoundError` when the binary does not exist. */
export type CommandRunner = (input: {
  command: string;
  args: string[];
  cwd: string | undefined;
  /** Stream the command's output to the terminal while it runs. */
  echo: boolean;
  /** Give the command the terminal, for a password prompt. */
  interactive: boolean;
}) => Promise<CommandResult>;

export class CommandNotFoundError extends Error {}

export const SLOT_COUNT = 4;
export const SLOT_IMAGE = 'amanuensis-sandbox-slot:local';
export const APPARMOR_PROFILE = 'aman-sandbox-slot';
const SLOTS_PROJECT = 'aman-slots';
const SLOTS_COMPOSE_FILE = 'docker-compose.slots.yml';
const APP_COMPOSE_FILE = 'docker-compose.slots-app.yml';
const PROFILE_PATH = join('ops', 'sandbox-slot', 'apparmor', APPARMOR_PROFILE);
const UP_TIMEOUT_SECONDS = 300;

export type SlotsStep = 'docker' | 'compose' | 'apparmor' | 'build' | 'start' | 'attest';

export interface SlotsCheck {
  step: SlotsStep;
  status: 'ok' | 'info';
  message: string;
}

export type SlotsResult =
  | {
      ok: true;
      checks: SlotsCheck[];
      image_size_mb: number | undefined;
      app_compose_file: string;
    }
  | { ok: false; checks: SlotsCheck[]; step: SlotsStep; error: string; fix: string };

export interface SlotsOptions {
  repoRoot: string;
  run: CommandRunner;
  /** Allow the one `sudo` step that loads the AppArmor profile. */
  fix: boolean;
  onCheck: ((check: SlotsCheck) => void) | undefined;
}

class StepFailure extends Error {
  constructor(
    readonly step: SlotsStep,
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

function tail(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(-400);
}

class Slots {
  readonly checks: SlotsCheck[] = [];

  constructor(private readonly options: SlotsOptions) {}

  private record(check: SlotsCheck): void {
    this.checks.push(check);
    this.options.onCheck?.(check);
  }

  private async run(input: {
    args: string[];
    echo?: boolean;
    interactive?: boolean;
    command?: string;
  }): Promise<CommandResult> {
    return this.options.run({
      command: input.command ?? 'docker',
      args: input.args,
      cwd: this.options.repoRoot,
      echo: input.echo ?? false,
      interactive: input.interactive ?? false,
    });
  }

  private composeArgs(tail: string[]): string[] {
    return [
      'compose',
      '--project-directory',
      this.options.repoRoot,
      '-p',
      SLOTS_PROJECT,
      '-f',
      join(this.options.repoRoot, SLOTS_COMPOSE_FILE),
      ...tail,
    ];
  }

  async execute(): Promise<SlotsResult> {
    try {
      await this.checkDocker();
      const appArmor = await this.detectAppArmor();
      await this.build();
      if (appArmor) {
        await this.ensureProfile();
      }
      await this.start();
      await this.attest();
    } catch (error: unknown) {
      if (error instanceof StepFailure) {
        return { ok: false, checks: this.checks, step: error.step, error: error.message, fix: error.fix };
      }
      throw error;
    }
    return {
      ok: true,
      checks: this.checks,
      image_size_mb: await this.imageSizeMb(),
      app_compose_file: join(this.options.repoRoot, APP_COMPOSE_FILE),
    };
  }

  private async checkDocker(): Promise<void> {
    let version: CommandResult;
    try {
      version = await this.run({ args: ['version', '--format', '{{.Server.Version}} {{.Server.Arch}}'] });
    } catch (error: unknown) {
      if (error instanceof CommandNotFoundError) {
        throw new StepFailure(
          'docker',
          'Docker is not installed.',
          'Install Docker Engine 23 or newer (Docker Desktop on Mac or Windows), then run this again.',
        );
      }
      throw error;
    }
    if (version.exitCode !== 0) {
      throw new StepFailure(
        'docker',
        `Docker is installed but not responding: ${tail(version.stderr)}`,
        'Start Docker (on Linux: sudo systemctl start docker) and make sure your account can use it, then run this again.',
      );
    }
    this.record({ step: 'docker', status: 'ok', message: `Docker ${version.stdout.trim()} is running` });
    const compose = await this.run({ args: ['compose', 'version', '--short'] });
    if (compose.exitCode !== 0) {
      throw new StepFailure(
        'compose',
        'Docker Compose v2 is missing.',
        'Install the Docker Compose plugin (it ships with current Docker Engine and Docker Desktop), then run this again.',
      );
    }
    this.record({ step: 'compose', status: 'ok', message: `Docker Compose ${compose.stdout.trim()}` });
  }

  /** The daemon's own security options say whether its host runs AppArmor (Ubuntu does, Docker Desktop does not). */
  private async detectAppArmor(): Promise<boolean> {
    const info = await this.run({ args: ['info', '--format', '{{json .SecurityOptions}}'] });
    const present = info.exitCode === 0 && info.stdout.includes('name=apparmor');
    this.record({
      step: 'apparmor',
      status: 'info',
      message: present
        ? 'AppArmor is on in this Docker host, so the slots must run under the aman-sandbox-slot profile'
        : 'No AppArmor in this Docker host; the other safety checks still apply',
    });
    return present;
  }

  private async build(): Promise<void> {
    const built = await this.run({ args: this.composeArgs(['build', 'sandbox-1']), echo: true });
    if (built.exitCode !== 0) {
      throw new StepFailure(
        'build',
        `Building the sandbox image failed: ${tail(built.stderr)}`,
        'Check that this machine can reach Docker Hub and the Ubuntu package mirror (the build downloads packages once), then run this again. A Docker Hub rate-limit message means: run docker login first.',
      );
    }
    this.record({ step: 'build', status: 'ok', message: `Built ${SLOT_IMAGE}` });
  }

  private async profileLoaded(): Promise<boolean> {
    const probe = await this.run({
      args: [
        'run',
        '--rm',
        '--network',
        'none',
        '--security-opt',
        `apparmor=${APPARMOR_PROFILE}`,
        '--entrypoint',
        'true',
        SLOT_IMAGE,
      ],
    });
    return probe.exitCode === 0;
  }

  private async ensureProfile(): Promise<void> {
    if (await this.profileLoaded()) {
      this.record({ step: 'apparmor', status: 'ok', message: `AppArmor profile ${APPARMOR_PROFILE} is loaded` });
      return;
    }
    const profile = join(this.options.repoRoot, PROFILE_PATH);
    if (!this.options.fix) {
      throw new StepFailure(
        'apparmor',
        `The AppArmor profile ${APPARMOR_PROFILE} is not loaded on this machine.`,
        'Run pnpm sandbox:slots --fix. It asks for your password once to load the profile.',
      );
    }
    const loaded = await this.run({
      command: 'sudo',
      args: ['apparmor_parser', '-r', '-W', profile],
      interactive: true,
      echo: true,
    });
    if (loaded.exitCode !== 0 || !(await this.profileLoaded())) {
      throw new StepFailure(
        'apparmor',
        `Loading the AppArmor profile failed: ${tail(loaded.stderr)}`,
        'Make sure apparmor_parser is installed (sudo apt install apparmor) and that your account may use sudo, then run pnpm sandbox:slots --fix again.',
      );
    }
    this.record({ step: 'apparmor', status: 'ok', message: `Loaded the AppArmor profile ${APPARMOR_PROFILE}` });
  }

  private async start(): Promise<void> {
    const up = await this.run({
      args: this.composeArgs(['up', '-d', '--no-build', '--wait', '--wait-timeout', String(UP_TIMEOUT_SECONDS)]),
      echo: true,
    });
    if (up.exitCode !== 0) {
      const logs = await this.run({ args: this.composeArgs(['logs', '--no-color', '--tail', '15']) });
      throw new StepFailure(
        'start',
        `The slots did not become healthy: ${tail(`${up.stderr} ${logs.stdout} ${logs.stderr}`)}`,
        'Read the attestation lines above: each names the safety check that failed. On Ubuntu 24.04 run pnpm sandbox:slots --fix; otherwise see the failure fixes in the test sheet.',
      );
    }
    this.record({ step: 'start', status: 'ok', message: `Started ${String(SLOT_COUNT)} slots` });
  }

  private async attest(): Promise<void> {
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      const result = await this.run({
        args: this.composeArgs([
          'exec',
          '-T',
          `sandbox-${String(slot)}`,
          '/usr/local/bin/aman-slot-agent',
          'healthcheck',
        ]),
      });
      if (result.exitCode !== 0) {
        throw new StepFailure(
          'attest',
          `Slot ${String(slot)} failed its safety checks: ${tail(`${result.stdout} ${result.stderr}`)}`,
          'Run pnpm sandbox:slots --fix, then again. If the failing check is runsc, see the failure fixes in the test sheet.',
        );
      }
    }
    this.record({ step: 'attest', status: 'ok', message: `All ${String(SLOT_COUNT)} slots passed every safety check` });
  }

  private async imageSizeMb(): Promise<number | undefined> {
    const inspect = await this.run({ args: ['image', 'inspect', '--format', '{{.Size}}', SLOT_IMAGE] });
    const bytes = Number.parseInt(inspect.stdout.trim(), 10);
    return Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : undefined;
  }
}

export function runSandboxSlots(options: SlotsOptions): Promise<SlotsResult> {
  return new Slots(options).execute();
}

/** Stops the slots and, with `purge`, deletes their workspace volumes. */
export async function stopSandboxSlots(options: {
  repoRoot: string;
  run: CommandRunner;
  purge: boolean;
}): Promise<CommandResult> {
  return options.run({
    command: 'docker',
    args: [
      'compose',
      '--project-directory',
      options.repoRoot,
      '-p',
      SLOTS_PROJECT,
      '-f',
      join(options.repoRoot, SLOTS_COMPOSE_FILE),
      'down',
      ...(options.purge ? ['--volumes'] : []),
    ],
    cwd: options.repoRoot,
    echo: true,
    interactive: false,
  });
}

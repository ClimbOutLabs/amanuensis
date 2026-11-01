/**
 * Builds the sandbox slot image and starts the slots. The installer and `aman doctor sandbox` run this same
 * code, and `pnpm sandbox:slots` runs it from a checkout. Safe to re-run; changes no file of the user's.
 */
import { join } from 'node:path';
import { PackError, toPackArch, type PackName, type PacksPort } from './packs.js';

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
  /** Added to the command's environment. */
  env: Record<string, string>;
}) => Promise<CommandResult>;

export class CommandNotFoundError extends Error {}

export const SLOT_COUNT = 2;
/**
 * Installs from before had four slots. The slots past SLOT_COUNT, with their volumes and disks, are removed on
 * the next run, so an upgrade frees what they held.
 */
export const RETIRED_SLOTS: readonly number[] = [3, 4];
/** A removal deletes the disks of every slot an install may have, retired ones included. */
const MOST_SLOTS_EVER = Math.max(SLOT_COUNT, ...RETIRED_SLOTS);
export const SLOT_IMAGE = 'amanuensis-sandbox-slot:local';
/** The user the app runs as; it binds its package mirror sockets inside the mirror volumes. */
const APP_USER = '10001:10001';
export const APPARMOR_PROFILE = 'aman-sandbox-slot';
/** Names the Compose project and volumes, so two installs on one Docker host never share slots. */
export const DEFAULT_INSTANCE = 'aman';
export const DEFAULT_DISK_GB = 16;
export const MIN_DISK_GB = 4;
export const MAX_DISK_GB = 512;
/** The installer's instance names (lowercase letters, digits and inner hyphens), so one name serves both. */
export const INSTANCE_PATTERN = /^[a-z]([a-z0-9-]{0,22}[a-z0-9])?$/;
/** The variable the compose files read their project and volume names from. */
const INSTANCE_ENV = 'AMAN_SLOTS_INSTANCE';
export function slotsProject(instance: string): string {
  return `${instance}-slots`;
}
const SLOTS_COMPOSE_FILE = 'docker-compose.slots.yml';
const DISKS_COMPOSE_FILE = 'docker-compose.slots-disks.yml';
const DISK_SCRIPT = join('ops', 'sandbox-slot', 'disks', 'setup-disks.sh');
const PROFILE_PATH = join('ops', 'sandbox-slot', 'apparmor', APPARMOR_PROFILE);
/** Where the system loads profiles from at boot; a profile loaded only with apparmor_parser is gone after a restart. */
export const APPARMOR_INSTALLED_PATH = join('/etc', 'apparmor.d', APPARMOR_PROFILE);
const UP_TIMEOUT_SECONDS = 300;

/** What a run does: `up` builds and starts, `build` only builds the image, `check` only reads. */
export type SlotsMode = 'up' | 'build' | 'check';

export type SlotsStep = 'docker' | 'compose' | 'apparmor' | 'disk' | 'retire' | 'packs' | 'build' | 'start' | 'attest';

/** The parts of a run, in order, for a front end that shows progress; a part with nothing to do is still announced. */
export type SlotsStage = 'docker' | 'image' | 'profile' | 'disks' | 'start' | 'attest';

/** `hard`: each slot has its own fixed-size disk. `vm`: Docker's VM bounds the disk. `off`: only the soft per-chat limit. */
export type DiskMode = 'hard' | 'vm' | 'off';

/** Where the per-slot disk files live on a Linux host. */
export function diskRoot(instance: string): string {
  return `/var/lib/aman-slots/${instance}`;
}

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
      disk: { mode: DiskMode; bytes: number | undefined };
      packs: PackName[];
      /** Things that work but weaken the setup, to be shown to the person. */
      warnings: string[];
    }
  | {
      ok: false;
      checks: SlotsCheck[];
      step: SlotsStep;
      error: string;
      fix: string;
      /** The tool output `error` ends with, for a front end that shows it only on request. */
      detail: string | undefined;
    };

export interface SlotsOptions {
  repoRoot: string;
  run: CommandRunner;
  /** Allow the one `sudo` step that loads the AppArmor profile. */
  fix: boolean;
  /** Which install's slots to manage. */
  instance: string;
  /** `up` by default for callers that omit it. */
  mode: SlotsMode;
  /** The command a person types to repair the slots, quoted in every fix line; differs per front end. */
  command: string;
  /** Recreate running slots instead of leaving them as they are, for a repair. */
  restart: boolean;
  /** Platform of the machine running this command. */
  platform: NodeJS.Platform;
  /** True when this process is already root, so no sudo is needed. */
  isRoot: boolean;
  /** Size of each slot's fixed disk, used when the disks are created. */
  diskGb: number;
  /** False skips the per-slot disks; the per-chat soft limit still applies. */
  hardDiskLimit: boolean;
  /** Where optional toolchain packs are chosen and downloaded. */
  packsPort: PacksPort;
  /** Packs to add to the image and packs to take out of it, from --add and --remove. */
  addPacks: PackName[];
  removePacks: PackName[];
  /** Asks the person to agree before system files are touched; false when they decline or cannot be asked. */
  confirm: (question: string) => Promise<boolean>;
  onCheck: ((check: SlotsCheck) => void) | undefined;
  /** Called as each part of the run begins. */
  onStage: ((stage: SlotsStage) => void) | undefined;
  /**
   * Called once before the first step that needs sudo, so the password is asked in one predictable place. Returns
   * true when sudo then works without asking again, which lets the step's output go to the log instead of the terminal.
   */
  prepareRoot: (() => Promise<boolean>) | undefined;
}

class StepFailure extends Error {
  constructor(
    readonly step: SlotsStep,
    message: string,
    readonly fix: string,
    cause?: unknown,
    readonly detail?: string,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** A message that ends with a tool's output, split so the output can be shown apart from the sentence. */
function withDetail({ sentence, detail }: { sentence: string; detail: string }): { message: string; detail: string } {
  return { message: `${sentence}: ${detail}`, detail };
}

function tail(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(-400);
}

/**
 * The failing attestation lines in a slot's log, each cut free of the log's own prefixes (the container name
 * and the time it was written) and said in plain words: the line itself names the safety check that failed
 * and why. A line that does not read as a check and a reason is kept as it is.
 */
export function attestationFailuresOf(text: string): string[] {
  const failures: string[] = [];
  for (const line of text.split('\n')) {
    const at = line.indexOf('attestation FAILED');
    if (at >= 0) {
      failures.push(plainFailure(line.slice(at).trim()));
    }
  }
  return failures;
}

/** "attestation FAILED network: interfaces: ..." said plainly: "Safety check network failed: interfaces: ...". */
function plainFailure(line: string): string {
  const rest = line.slice('attestation FAILED '.length);
  const colon = rest.indexOf(': ');
  if (colon <= 0) {
    return line;
  }
  return `Safety check ${rest.slice(0, colon)} failed: ${rest.slice(colon + 2)}`;
}

/** True when a slot's healthcheck answer names its failing checks itself: one FAIL line per failed check. */
function healthcheckNamesFailures(output: string): boolean {
  return /(^|\n)FAIL /.test(output) || output.includes('attestation failed:');
}

class Slots {
  readonly checks: SlotsCheck[] = [];
  private diskMode: DiskMode = 'off';
  private diskBytes: number | undefined;
  /** Set once the disks are mounted; from then on every compose call carries the disk file. */
  private disksReady = false;
  private packs: PackName[] = [];
  /** True when the disks of the retired slots were left in place (no --fix, or the person said no). */
  private retiredDisksLeft = false;
  private rootAsked = false;
  /** True once sudo works without a password prompt, so root steps can run with their output captured. */
  private rootCached = false;

  constructor(private readonly options: SlotsOptions) {}

  private stage(stage: SlotsStage): void {
    this.options.onStage?.(stage);
  }

  /** Asks for the sudo password once, before the first root step. */
  private async prepareRoot(): Promise<void> {
    if (this.options.isRoot || this.rootAsked || this.options.prepareRoot === undefined) {
      return;
    }
    this.rootAsked = true;
    this.rootCached = await this.options.prepareRoot();
  }

  private get rootNeedsTerminal(): boolean {
    return !this.options.isRoot && !this.rootCached;
  }

  /** Only a full run may use sudo; a read-only check never changes the machine. */
  private get mayFix(): boolean {
    return this.options.fix && this.options.mode === 'up';
  }

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
      env: this.composeEnv(),
    });
  }

  private composeEnv(): Record<string, string> {
    const env: Record<string, string> = {
      [INSTANCE_ENV]: this.options.instance,
      AMAN_SLOTS_PACKS: this.packs.join(','),
      AMAN_SLOTS_DISK_MODE: this.diskMode === 'vm' ? 'vm' : 'none',
    };
    if (this.disksReady && this.diskBytes !== undefined) {
      env['AMAN_SLOTS_DISK_DIR'] = diskRoot(this.options.instance);
      env['AMAN_SLOTS_DISK_BYTES'] = String(this.diskBytes);
    }
    return env;
  }

  /**
   * Reads the logs of the given slots (all of them when none are named) out loud, so they are written to the
   * log file as well as read here: the reason a slot failed must reach the log, not only this run's output.
   */
  private async slotLogs(services: string[]): Promise<CommandResult> {
    return this.run({ args: this.composeArgs(['logs', '--no-color', '--tail', '50', ...services]), echo: true });
  }

  /**
   * Reads lines out loud, so they are written to the log file as well: the output of an echoed call is what
   * reaches the log (see the runner in main.ts), so the plain failure lines are printed through one. Best
   * effort: the failure itself is already in this run's result, so a line that cannot be read out is not
   * another failure.
   */
  private async sayOutLoud(lines: string[]): Promise<void> {
    if (lines.length === 0) {
      return;
    }
    await this.run({ command: 'printf', args: ['%s\n', ...lines], echo: true }).catch(() => undefined);
  }

  private composeArgs(tail: string[]): string[] {
    return [
      'compose',
      '--project-directory',
      this.options.repoRoot,
      '-p',
      slotsProject(this.options.instance),
      '-f',
      join(this.options.repoRoot, SLOTS_COMPOSE_FILE),
      ...(this.disksReady ? ['-f', join(this.options.repoRoot, DISKS_COMPOSE_FILE)] : []),
      ...tail,
    ];
  }

  async execute(): Promise<SlotsResult> {
    const { mode } = this.options;
    try {
      this.stage('docker');
      await this.checkDocker();
      const appArmor = await this.detectAppArmor();
      this.diskMode = await this.detectDiskMode();
      this.stage('image');
      if (mode !== 'check') {
        await this.preparePacks();
        await this.build();
      }
      if (mode === 'check') {
        await this.checkImage();
      }
      if (mode !== 'build') {
        this.stage('profile');
        if (appArmor) {
          await this.ensureProfile();
        }
        this.stage('disks');
        await this.retireSlots();
        if (this.diskMode === 'hard') {
          await this.ensureDisks();
        }
      }
      if (mode === 'up') {
        this.stage('start');
        await this.repairMirrorVolumes();
        await this.start();
      }
      if (mode !== 'build') {
        this.stage('attest');
        await this.attest();
      }
    } catch (error: unknown) {
      if (error instanceof StepFailure) {
        return {
          ok: false,
          checks: this.checks,
          step: error.step,
          error: error.message,
          fix: error.fix,
          detail: error.detail,
        };
      }
      throw error;
    }
    return {
      ok: true,
      checks: this.checks,
      image_size_mb: await this.imageSizeMb(),
      disk: { mode: this.diskMode, bytes: this.diskBytes },
      packs: this.packs,
      warnings: this.warnings(),
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
          error,
        );
      }
      throw error;
    }
    if (version.exitCode !== 0) {
      const failed = withDetail({ sentence: 'Docker is installed but not responding', detail: tail(version.stderr) });
      throw new StepFailure(
        'docker',
        failed.message,
        'Start Docker (on Linux: sudo systemctl start docker) and make sure your account can use it, then run this again.',
        undefined,
        failed.detail,
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
        ? 'AppArmor is on in this Docker host, so the sandboxes must run under the aman-sandbox-slot profile'
        : 'No AppArmor in this Docker host; the other safety checks still apply',
    });
    return present;
  }

  /** Linux with a native Docker engine can give each slot its own disk; a Docker VM already bounds the disk. */
  private warnings(): string[] {
    const warnings: string[] = [];
    if (this.options.platform === 'linux' && this.diskMode === 'off') {
      warnings.push(
        `The sandboxes have no disk of their own, so a runaway program could fill this computer's disk. Run ${this.options.command} --fix to give each sandbox a fixed-size disk.`,
      );
    }
    if (this.retiredDisksLeft) {
      warnings.push(
        `The disks of the extra sandboxes of an older version were left in place under ${diskRoot(this.options.instance)}. Run ${this.options.command} --fix to remove them.`,
      );
    }
    return warnings;
  }

  private async detectDiskMode(): Promise<DiskMode> {
    if (!this.options.hardDiskLimit) {
      this.record({
        step: 'disk',
        status: 'info',
        message: 'Per-sandbox disks are off (--no-hard-disk-limit); only the per-chat disk limit applies',
      });
      return 'off';
    }
    const engine = await this.run({ args: ['info', '--format', '{{.OperatingSystem}}'] });
    const kernel = this.options.platform === 'linux' ? await this.run({ command: 'uname', args: ['-r'] }) : undefined;
    const inVm =
      this.options.platform !== 'linux' ||
      /docker desktop/i.test(engine.stdout) ||
      /microsoft|wsl/i.test(kernel?.stdout ?? '');
    if (inVm) {
      this.record({
        step: 'disk',
        status: 'info',
        message:
          "Docker runs in a virtual machine here, so the VM's disk limit bounds the sandbox workspaces; there is no per-sandbox disk to set up",
      });
      return 'vm';
    }
    return 'hard';
  }

  /** The size of the largest mounted slot disk, or undefined when any of them is missing or not ext4. */
  private async readDisks(): Promise<number | undefined> {
    const root = diskRoot(this.options.instance);
    let largest = 0;
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      let found: CommandResult;
      try {
        found = await this.run({
          command: 'findmnt',
          args: ['-n', '-b', '-o', 'FSTYPE,SIZE', '--mountpoint', `${root}/ws-${String(slot)}`],
        });
      } catch (error: unknown) {
        if (error instanceof CommandNotFoundError) {
          return undefined;
        }
        throw error;
      }
      const [type, size] = found.stdout.trim().split(/\s+/);
      const bytes = Number.parseInt(size ?? '', 10);
      if (found.exitCode !== 0 || type !== 'ext4' || !Number.isFinite(bytes) || bytes <= 0) {
        return undefined;
      }
      largest = Math.max(largest, bytes);
    }
    return largest;
  }

  /** Workspace volumes from before the disks existed hold scratch files of earlier chats and sit on the host disk. */
  private async staleWorkspaceVolumes(): Promise<string[]> {
    const root = diskRoot(this.options.instance);
    const stale: string[] = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      const name = `${this.options.instance}_slot_ws_${String(slot)}`;
      const inspect = await this.run({
        args: ['volume', 'inspect', '--format', '{{index .Options "device"}}', name],
      });
      if (inspect.exitCode === 0 && inspect.stdout.trim() !== `${root}/ws-${String(slot)}`) {
        stale.push(name);
      }
    }
    return stale;
  }

  /**
   * Mirror volumes created before the slot image carried the mirror folder started out owned by
   * root, and the app cannot bind its mirror socket in them; the folder holds only that socket, so
   * handing it to the app user loses nothing. One throwaway container that may only change owners
   * does it for every mirror volume that exists; a volume that does not exist yet is left alone, so
   * the slot image seeds it with the right owner when the slots create it.
   */
  private async repairMirrorVolumes(): Promise<void> {
    const existing: string[] = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      const name = `${this.options.instance}_slot_mirror_${String(slot)}`;
      const inspect = await this.run({ args: ['volume', 'inspect', name] });
      if (inspect.exitCode === 0) {
        existing.push(name);
      }
    }
    if (existing.length === 0) {
      return;
    }
    const mounts: string[] = [];
    const folders: string[] = [];
    existing.forEach((name, index) => {
      const folder = `/mirror-${String(index + 1)}`;
      mounts.push('-v', `${name}:${folder}`);
      folders.push(folder);
    });
    const repaired = await this.run({
      args: [
        'run',
        '--rm',
        '--user',
        '0:0',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'CHOWN',
        '--read-only',
        ...mounts,
        '--entrypoint',
        'chown',
        SLOT_IMAGE,
        APP_USER,
        ...folders,
      ],
    });
    if (repaired.exitCode !== 0) {
      const failed = withDetail({
        sentence: 'The package mirror folders could not be handed to the app user',
        detail: tail(repaired.stderr),
      });
      throw new StepFailure(
        'start',
        failed.message,
        `Make sure Docker is running, then run ${this.options.command} --fix again. Package downloads stay off until the folders belong to the app user.`,
        undefined,
        failed.detail,
      );
    }
    this.record({
      step: 'start',
      status: 'ok',
      message: 'The package mirror folders belong to the app user, so the app can open its mirror sockets in them',
    });
  }

  private async runDiskScript(args: string[]): Promise<CommandResult> {
    const script = join(this.options.repoRoot, DISK_SCRIPT);
    await this.prepareRoot();
    return this.run({
      command: this.options.isRoot ? 'sh' : 'sudo',
      args: this.options.isRoot ? [script, ...args] : ['sh', script, ...args],
      interactive: this.rootNeedsTerminal,
      echo: true,
    });
  }

  /**
   * Removes the slots an older install had past SLOT_COUNT: their containers, their volumes and, on Linux, their
   * disks. A chat's files live in a folder named by its session id under its slot's workspace, and a chat keeps
   * its old slot in its sandbox id, so the folders of the retired slots are moved into the slots that stay
   * (slot 3 into slot 1, slot 4 into slot 2, the same mapping the app resolves old ids with) before anything
   * is removed. A control or mirror volume the instance's app still mounts stays until the app is started
   * again without it; the installer removes it then. A read-only check only reports what is left. Removing
   * the retired disks is cleanup, not setup: without --fix, or when the person says no, the disks stay, the
   * run carries on, and the result warns about them; a later check reports them again.
   */
  private async retireSlots(): Promise<void> {
    const project = slotsProject(this.options.instance);
    const containers: string[] = [];
    for (const slot of RETIRED_SLOTS) {
      const found = await this.run({
        args: [
          'ps',
          '-aq',
          '--filter',
          `label=com.docker.compose.project=${project}`,
          '--filter',
          `label=com.docker.compose.service=sandbox-${String(slot)}`,
        ],
      });
      containers.push(...found.stdout.split(/\s+/).filter(id => id !== ''));
    }
    const disks = this.diskMode === 'hard' ? await this.retiredDisks() : [];
    const sessions = await this.retiredSessions();
    if (containers.length === 0 && disks.length === 0 && sessions.length === 0) {
      await this.removeRetiredVolumes();
      return;
    }
    if (this.options.mode !== 'up') {
      throw new StepFailure(
        'retire',
        `This computer still has the extra sandboxes of an older version of Aman, which now uses ${String(SLOT_COUNT)}.`,
        `Run ${this.options.command} --fix to remove them.`,
      );
    }
    if (containers.length > 0) {
      const removed = await this.run({ args: ['rm', '--force', ...containers], echo: true });
      if (removed.exitCode !== 0) {
        const failed = withDetail({
          sentence: 'The extra sandboxes could not be removed',
          detail: tail(removed.stderr),
        });
        throw new StepFailure(
          'start',
          failed.message,
          `Make sure Docker is running, then run ${this.options.command} --fix again.`,
          undefined,
          failed.detail,
        );
      }
    }
    // The retired containers are gone, so nothing can write to their workspaces while the folders move.
    await this.moveRetiredSessions(sessions);
    await this.removeRetiredVolumes();
    if (disks.length > 0) {
      await this.retireDisks();
    }
    this.record({
      step: 'start',
      status: 'ok',
      message: this.retiredDisksLeft
        ? `Removed the extra sandboxes of an older version; their disks were left in place`
        : `Removed the extra sandboxes of an older version; ${String(SLOT_COUNT)} sandboxes are enough`,
    });
  }

  /** The slot a retired slot's chats move to: slot 3 to slot 1, slot 4 to slot 2. */
  private retiredTarget(slot: number): number {
    return ((slot - 1) % SLOT_COUNT) + 1;
  }

  /**
   * The chats still on the retired slots, read with one throwaway container per workspace volume that
   * exists: the session ids are the folder names under the volume's sessions folder. Read-only.
   */
  private async retiredSessions(): Promise<{ slot: number; sessionIds: string[] }[]> {
    // Only a full run looks inside the workspaces: a read-only check runs no container and inspects no volume,
    // and the containers or disks it does report are what an older install leaves behind in practice.
    if (this.options.mode !== 'up') {
      return [];
    }
    const found: { slot: number; sessionIds: string[] }[] = [];
    for (const slot of RETIRED_SLOTS) {
      const name = `${this.options.instance}_slot_ws_${String(slot)}`;
      const inspect = await this.run({ args: ['volume', 'inspect', name] });
      if (inspect.exitCode !== 0) {
        continue;
      }
      const listed = await this.run({
        args: [
          'run',
          '--rm',
          '--network',
          'none',
          '--read-only',
          '-v',
          `${name}:/from:ro`,
          '--entrypoint',
          'ls',
          SLOT_IMAGE,
          '/from/sessions',
        ],
      });
      if (listed.exitCode !== 0) {
        continue;
      }
      const sessionIds = listed.stdout.split(/\s+/).filter(id => /^[0-9a-f]{32}$/.test(id));
      if (sessionIds.length > 0) {
        found.push({ slot, sessionIds });
      }
    }
    return found;
  }

  /**
   * Moves each retired slot's chat folders into the workspace of the slot that takes its chats over, with
   * one throwaway container per retired slot. A folder the target already has is left where it is.
   */
  private async moveRetiredSessions(sessions: { slot: number; sessionIds: string[] }[]): Promise<void> {
    for (const { slot, sessionIds } of sessions) {
      const moved = await this.run({
        args: [
          'run',
          '--rm',
          '--network',
          'none',
          '--read-only',
          '-v',
          `${this.options.instance}_slot_ws_${String(slot)}:/from`,
          '-v',
          `${this.options.instance}_slot_ws_${String(this.retiredTarget(slot))}:/to`,
          '--entrypoint',
          'sh',
          SLOT_IMAGE,
          '-c',
          'mkdir -p /to/sessions; for id in "$@"; do if [ -d "/from/sessions/$id" ] && [ ! -e "/to/sessions/$id" ]; then mv "/from/sessions/$id" "/to/sessions/$id"; fi; done',
          'move-sessions',
          ...sessionIds,
        ],
        echo: true,
      });
      if (moved.exitCode !== 0) {
        const failed = withDetail({
          sentence: 'The chats of the extra sandboxes could not be moved, so nothing was removed',
          detail: tail(moved.stderr),
        });
        throw new StepFailure(
          'start',
          failed.message,
          `Make sure Docker is running, then run ${this.options.command} --fix again.`,
          undefined,
          failed.detail,
        );
      }
    }
  }

  /** The volumes of retired slots that still exist and that no container uses; the rest are left as they are. */
  private async removeRetiredVolumes(): Promise<void> {
    if (this.options.mode !== 'up') {
      return;
    }
    const names = RETIRED_SLOTS.flatMap(slot =>
      ['ws', 'ctl', 'mirror'].map(kind => `${this.options.instance}_slot_${kind}_${String(slot)}`),
    );
    for (const name of names) {
      const inspect = await this.run({ args: ['volume', 'inspect', name] });
      if (inspect.exitCode !== 0) {
        continue;
      }
      // Fails while the app still mounts it; the installer removes it after the app starts without it.
      await this.run({ args: ['volume', 'rm', name] });
    }
  }

  /** Disk files or mount points of retired slots under the instance's disk folder. */
  private async retiredDisks(): Promise<string[]> {
    const root = diskRoot(this.options.instance);
    const tests = RETIRED_SLOTS.flatMap(slot => [`ws-${String(slot)}`, `ws-${String(slot)}.img`]).flatMap(
      (name, index) => (index === 0 ? ['-name', name] : ['-o', '-name', name]),
    );
    let found: CommandResult;
    try {
      // A missing folder means no disks at all; find then prints nothing.
      found = await this.run({ command: 'find', args: [root, '-maxdepth', '1', '(', ...tests, ')', '-print'] });
    } catch (error: unknown) {
      if (error instanceof CommandNotFoundError) {
        return [];
      }
      throw error;
    }
    return found.stdout.split('\n').filter(line => line.trim() !== '');
  }

  /**
   * Removes the retired slots' disks with the root disk script. Cleanup only: without --fix, or when the
   * person says no, the disks stay and the run carries on with a warning, so an upgrade is never undone
   * over them. A later check reports the disks again.
   */
  private async retireDisks(): Promise<void> {
    const root = diskRoot(this.options.instance);
    if (!this.mayFix) {
      this.retiredDisksLeft = true;
      return;
    }
    const agreed = await this.options.confirm(
      `This will remove the disks of the extra sandboxes an older version of Aman made under ${root}, and their lines in /etc/fstab. It needs root.`,
    );
    if (!agreed) {
      this.retiredDisksLeft = true;
      return;
    }
    const retired = await this.runDiskScript(['retire', root, String(SLOT_COUNT)]);
    if (retired.exitCode !== 0) {
      const failed = withDetail({ sentence: 'Removing the old sandbox disks failed', detail: tail(retired.stderr) });
      throw new StepFailure(
        'retire',
        failed.message,
        `Make sure your account may use sudo, then run ${this.options.command} --fix again.`,
        undefined,
        failed.detail,
      );
    }
  }

  private async ensureDisks(): Promise<void> {
    const root = diskRoot(this.options.instance);
    const mounted = await this.readDisks();
    const stale = await this.staleWorkspaceVolumes();
    if (mounted !== undefined && stale.length === 0) {
      this.diskBytes = mounted;
      this.disksReady = true;
      this.record({
        step: 'disk',
        status: 'ok',
        message: `Each sandbox has its own ${String(Math.round(mounted / 2 ** 30))} GB disk under ${root}`,
      });
      return;
    }
    if (!this.mayFix) {
      throw new StepFailure(
        'disk',
        "The sandbox workspaces do not have a disk limit of their own yet, so a runaway program could fill this computer's disk.",
        `Run ${this.options.command} --fix. It asks first, then your password once, to create ${String(SLOT_COUNT)} fixed-size disk files that fill only as they are used.`,
      );
    }
    const staleNote =
      stale.length === 0
        ? ''
        : ' The scratch files of earlier test chats in the existing workspace volumes will be deleted.';
    const agreed = await this.options.confirm(
      `This will create ${String(SLOT_COUNT)} disk files of ${String(this.options.diskGb)} GB each under ${root} (they use real space only as the slots write), add ${String(SLOT_COUNT)} lines to /etc/fstab so they mount again after a reboot, and mount them. It needs root.${staleNote}`,
    );
    if (!agreed) {
      throw new StepFailure(
        'disk',
        'Setting up the sandbox disks was not confirmed, so nothing was changed.',
        `Run ${this.options.command} --fix again and answer yes. Add --yes when no one is at the keyboard.`,
      );
    }
    if (stale.length > 0) {
      const down = await this.run({ args: this.composeArgs(['down']), echo: true });
      const removed = await this.run({ args: ['volume', 'rm', '--force', ...stale] });
      if (down.exitCode !== 0 || removed.exitCode !== 0) {
        const failed = withDetail({
          sentence: 'The old workspace volumes could not be removed',
          detail: tail(`${down.stderr} ${removed.stderr}`),
        });
        throw new StepFailure(
          'disk',
          failed.message,
          `Stop anything that still uses the sandboxes, then run ${this.options.command} --fix again.`,
          undefined,
          failed.detail,
        );
      }
    }
    if (mounted === undefined) {
      const created = await this.runDiskScript(['setup', root, String(this.options.diskGb), String(SLOT_COUNT)]);
      if (created.exitCode !== 0) {
        const failed = withDetail({ sentence: 'Creating the sandbox disks failed', detail: tail(created.stderr) });
        throw new StepFailure(
          'disk',
          failed.message,
          `Make sure mkfs.ext4 is installed (sudo apt install e2fsprogs) and that your account may use sudo, then run ${this.options.command} --fix again. On a machine that cannot mount disk files, run ${this.options.command} --no-hard-disk-limit instead.`,
          undefined,
          failed.detail,
        );
      }
    }
    const after = await this.readDisks();
    if (after === undefined) {
      throw new StepFailure(
        'disk',
        'The sandbox disks were created but are not mounted.',
        `Run ${this.options.command} --fix again; if it keeps failing, run ${this.options.command} --no-hard-disk-limit.`,
      );
    }
    this.diskBytes = after;
    this.disksReady = true;
    this.record({
      step: 'disk',
      status: 'ok',
      message: `Created ${String(SLOT_COUNT)} sandbox disks of ${String(Math.round(after / 2 ** 30))} GB under ${root}`,
    });
  }

  /** Downloads and checks what the chosen packs need, before the image build uses them. */
  private async preparePacks(): Promise<void> {
    const info = await this.run({ args: ['info', '--format', '{{.Architecture}}'] });
    try {
      this.packs = await this.options.packsPort.prepare({
        add: this.options.addPacks,
        remove: this.options.removePacks,
        arch: toPackArch(info.stdout),
      });
    } catch (error: unknown) {
      if (error instanceof PackError) {
        throw new StepFailure('packs', error.message, error.fix, error);
      }
      throw error;
    }
    if (this.packs.length > 0) {
      this.record({ step: 'packs', status: 'ok', message: `Toolchain packs in the sandbox: ${this.packs.join(', ')}` });
    }
  }

  private async build(): Promise<void> {
    const built = await this.run({ args: this.composeArgs(['build', 'sandbox-1']), echo: true });
    if (built.exitCode !== 0) {
      const failed = withDetail({ sentence: 'Building the sandbox image failed', detail: tail(built.stderr) });
      throw new StepFailure(
        'build',
        failed.message,
        'Check that this machine can reach Docker Hub and the Ubuntu package mirror (the build downloads packages once), then run this again. A Docker Hub rate-limit message means: run docker login first.',
        undefined,
        failed.detail,
      );
    }
    this.record({ step: 'build', status: 'ok', message: 'Built the sandbox' });
  }

  private async checkImage(): Promise<void> {
    const inspect = await this.run({ args: ['image', 'inspect', '--format', '{{.Id}}', SLOT_IMAGE] });
    if (inspect.exitCode !== 0) {
      throw new StepFailure(
        'build',
        'The sandbox is not built on this computer.',
        `Run ${this.options.command} --fix to build it.`,
      );
    }
    this.record({ step: 'build', status: 'ok', message: 'The sandbox is built' });
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
    if (!this.mayFix) {
      throw new StepFailure(
        'apparmor',
        `The AppArmor profile ${APPARMOR_PROFILE} is not loaded on this machine.`,
        `Run ${this.options.command} --fix. It asks for your password once to load the profile.`,
      );
    }
    const asRoot = (args: string[]): { command: string; args: string[] } =>
      this.options.isRoot ? { command: args[0] ?? '', args: args.slice(1) } : { command: 'sudo', args };
    await this.prepareRoot();
    const installed = await this.run({
      ...asRoot(['install', '-m', '0644', profile, APPARMOR_INSTALLED_PATH]),
      interactive: this.rootNeedsTerminal,
      echo: true,
    });
    const loaded =
      installed.exitCode === 0
        ? await this.run({
            ...asRoot(['apparmor_parser', '-r', '-W', APPARMOR_INSTALLED_PATH]),
            interactive: this.rootNeedsTerminal,
            echo: true,
          })
        : installed;
    if (loaded.exitCode !== 0 || !(await this.profileLoaded())) {
      const failed = withDetail({
        sentence: 'Installing and loading the AppArmor profile failed',
        detail: tail(loaded.stderr),
      });
      throw new StepFailure(
        'apparmor',
        failed.message,
        `Make sure apparmor_parser is installed (sudo apt install apparmor) and that your account may use sudo, then run ${this.options.command} --fix again.`,
        undefined,
        failed.detail,
      );
    }
    this.record({
      step: 'apparmor',
      status: 'ok',
      message: `Installed the AppArmor profile ${APPARMOR_PROFILE} in /etc/apparmor.d and loaded it (it loads again at boot)`,
    });
  }

  private async start(): Promise<void> {
    const up = await this.run({
      args: this.composeArgs([
        'up',
        '-d',
        '--no-build',
        ...(this.options.restart ? ['--force-recreate'] : []),
        '--wait',
        '--wait-timeout',
        String(UP_TIMEOUT_SECONDS),
      ]),
      echo: true,
    });
    if (up.exitCode !== 0) {
      const logs = await this.slotLogs([]);
      const failures = attestationFailuresOf(`${logs.stdout}\n${logs.stderr}`);
      await this.sayOutLoud(failures);
      const failed = withDetail({
        sentence: 'The sandboxes did not become healthy',
        detail: failures.length > 0 ? failures.join(' ') : tail(`${up.stderr} ${logs.stdout} ${logs.stderr}`),
      });
      throw new StepFailure(
        'start',
        failed.message,
        `Read the safety check lines above: each names the safety check that failed. On Ubuntu 24.04 run ${this.options.command} --fix; otherwise see the failure fixes in the test sheet.`,
        undefined,
        failed.detail,
      );
    }
    this.record({ step: 'start', status: 'ok', message: `Started ${String(SLOT_COUNT)} sandboxes` });
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
        let detail = tail(`${result.stdout} ${result.stderr}`);
        // A slot that is not running cannot answer, so its answer names no check; its own log holds the
        // attestation line instead. An answer that names its checks is kept as it is.
        if (!healthcheckNamesFailures(`${result.stdout}\n${result.stderr}`)) {
          const logs = await this.slotLogs([`sandbox-${String(slot)}`]);
          const failures = attestationFailuresOf(`${logs.stdout}\n${logs.stderr}`);
          if (failures.length > 0) {
            detail = failures.join(' ');
            await this.sayOutLoud(failures);
          }
        }
        const failed = withDetail({
          sentence: `Sandbox ${String(slot)} failed its safety checks`,
          detail,
        });
        throw new StepFailure(
          'attest',
          failed.message,
          `Run ${this.options.command} --fix, then again. If the failing check is runsc, see the failure fixes in the test sheet.`,
          undefined,
          failed.detail,
        );
      }
    }
    this.record({
      step: 'attest',
      status: 'ok',
      message: `All ${String(SLOT_COUNT)} sandboxes passed every safety check`,
    });
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

/** Stops the slots and, with `purge`, deletes their workspace volumes and, on Linux, their disk files. */
export async function stopSandboxSlots(options: {
  repoRoot: string;
  run: CommandRunner;
  purge: boolean;
  instance: string;
  platform: NodeJS.Platform;
  isRoot: boolean;
}): Promise<CommandResult> {
  const env = { [INSTANCE_ENV]: options.instance };
  const down = await options.run({
    command: 'docker',
    args: [
      'compose',
      '--project-directory',
      options.repoRoot,
      '-p',
      slotsProject(options.instance),
      '-f',
      join(options.repoRoot, SLOTS_COMPOSE_FILE),
      'down',
      // Also stops the extra slots of an install from before SLOT_COUNT dropped.
      '--remove-orphans',
      ...(options.purge ? ['--volumes'] : []),
    ],
    cwd: options.repoRoot,
    echo: true,
    interactive: false,
    env,
  });
  const root = diskRoot(options.instance);
  if (!options.purge || down.exitCode !== 0) {
    return down;
  }
  // The compose file no longer names the volumes of retired slots, so --volumes leaves them.
  for (const slot of RETIRED_SLOTS) {
    for (const kind of ['ws', 'ctl', 'mirror']) {
      await options.run({
        command: 'docker',
        args: ['volume', 'rm', '--force', `${options.instance}_slot_${kind}_${String(slot)}`],
        cwd: options.repoRoot,
        echo: false,
        interactive: false,
        env,
      });
    }
  }
  if (options.platform !== 'linux') {
    return down;
  }
  const present = await options.run({
    command: 'test',
    args: ['-d', root],
    cwd: options.repoRoot,
    echo: false,
    interactive: false,
    env,
  });
  if (present.exitCode !== 0) {
    return down;
  }
  const script = join(options.repoRoot, DISK_SCRIPT);
  return options.run({
    command: options.isRoot ? 'sh' : 'sudo',
    args: options.isRoot
      ? [script, 'remove', root, String(MOST_SLOTS_EVER)]
      : ['sh', script, 'remove', root, String(MOST_SLOTS_EVER)],
    cwd: options.repoRoot,
    echo: true,
    interactive: !options.isRoot,
    env,
  });
}

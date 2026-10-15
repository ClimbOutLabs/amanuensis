/**
 * `pnpm sandbox:slots`: builds the sandbox slot image and starts the slots. The installer runs the same code, built
 * into the app image, through the `aman doctor sandbox` shim on the host.
 * Flags: `--fix` (allow the sudo steps: loading the AppArmor profile and creating the per-slot disks on
 * Linux; the disks are only created after a yes, or with `--yes`), `--disk-gb <n>` (size of each slot's
 * disk, default 16), `--no-hard-disk-limit` (skip the per-slot disks), `--down` (stop the slots), `--purge`
 * (with `--down`, also delete their workspace volumes and disk files), `--add <packs>` / `--remove <packs>`
 * (toolchain packs `go`, `rust`, `java` in the image; they stay chosen until removed), `--instance <name>`
 * (manage a second install's slots on the same Docker host; default `aman`), `--json`, `--check` (read only: verify
 * the image, profile, disks and every slot's attestation), `--build-only` (build the image and stop), `--restart`
 * (recreate running slots), `--repo-root <dir>` (where the compose files and `ops/sandbox-slot` are; default this
 * checkout), `--log-file <path>` (send the image build output there), `--command-name <text>` (the command quoted in
 * fix lines).
 * Exit code 0 when every check passes, 1 when a check fails, 2 on a usage error.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createPacksPort, parsePackList, type Download } from './packs.js';
import {
  CommandNotFoundError,
  DEFAULT_DISK_GB,
  DEFAULT_INSTANCE,
  INSTANCE_PATTERN,
  MAX_DISK_GB,
  MIN_DISK_GB,
  runSandboxSlots,
  stopSandboxSlots,
  type CommandResult,
  type CommandRunner,
  type SlotsCheck,
  type SlotsResult,
} from './slots.js';

const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function isMissingBinary(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Follows redirects by hand so none can leave https, and stops at a size no pack comes near. */
const download: Download = async ({ url, destination }) => {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!current.startsWith('https://')) {
      throw new Error(`refusing a non-https address (${new URL(current).protocol})`);
    }
    const response = await fetch(current, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location !== null) {
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)} from ${new URL(current).host}`);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_DOWNLOAD_BYTES) {
      throw new Error('the file is larger than any pack');
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error('the file is larger than any pack');
    }
    await writeFile(destination, body);
    return;
  }
  throw new Error('too many redirects');
};

/** Asks on the terminal; without a terminal the answer is no unless `--yes` was given. */
async function askYesNo({ question, assumeYes }: { question: string; assumeYes: boolean }): Promise<boolean> {
  if (assumeYes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question}\nContinue? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Where a command's streamed output goes: the terminal, or a log file when the caller wants only progress lines. */
function createRunCommand({ logFile }: { logFile: string | undefined }): CommandRunner {
  const sink = (chunk: Buffer | string): void => {
    if (logFile === undefined) {
      process.stderr.write(chunk);
    } else {
      appendFileSync(logFile, chunk, { mode: 0o600 });
    }
  };
  return ({ command, args, cwd, echo, interactive, env }) =>
    new Promise<CommandResult>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
        if (echo) {
          sink(chunk);
        }
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
        if (echo) {
          sink(chunk);
        }
      });
      child.on('error', (error: Error) => {
        reject(isMissingBinary(error) ? new CommandNotFoundError(command, { cause: error }) : error);
      });
      child.on('close', (code: number | null) => {
        resolvePromise({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
}

function formatCheck(check: SlotsCheck): string {
  return `${check.status === 'ok' ? '[ok]  ' : '[note]'} ${check.message}\n`;
}

function formatFailure(result: Extract<SlotsResult, { ok: false }>): string {
  return `[fail] ${result.step}: ${result.error}\n       Fix: ${result.fix}\n`;
}

async function main(): Promise<number> {
  let values: {
    fix?: boolean | undefined;
    down?: boolean | undefined;
    purge?: boolean | undefined;
    json?: boolean | undefined;
    instance?: string | undefined;
    'disk-gb'?: string | undefined;
    'no-hard-disk-limit'?: boolean | undefined;
    yes?: boolean | undefined;
    add?: string | undefined;
    remove?: string | undefined;
    check?: boolean | undefined;
    'build-only'?: boolean | undefined;
    restart?: boolean | undefined;
    'repo-root'?: string | undefined;
    'log-file'?: string | undefined;
    'command-name'?: string | undefined;
  };
  try {
    ({ values } = parseArgs({
      options: {
        fix: { type: 'boolean' },
        down: { type: 'boolean' },
        purge: { type: 'boolean' },
        json: { type: 'boolean' },
        instance: { type: 'string' },
        'disk-gb': { type: 'string' },
        'no-hard-disk-limit': { type: 'boolean' },
        yes: { type: 'boolean' },
        add: { type: 'string' },
        remove: { type: 'string' },
        check: { type: 'boolean' },
        'build-only': { type: 'boolean' },
        restart: { type: 'boolean' },
        'repo-root': { type: 'string' },
        'log-file': { type: 'string' },
        'command-name': { type: 'string' },
      },
      strict: true,
    }));
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\nUsage: pnpm sandbox:slots [--fix [--yes]] [--disk-gb <n>] [--no-hard-disk-limit] [--add go,rust,java] [--remove go,rust,java] [--json] [--instance <name>] [--check | --build-only | --restart] [--repo-root <dir>] [--log-file <path>] | --down [--purge] [--instance <name>]\n`,
    );
    return 2;
  }
  const instance = values.instance ?? DEFAULT_INSTANCE;
  if (!INSTANCE_PATTERN.test(instance)) {
    process.stderr.write('--instance must be 1 to 24 lowercase letters, digits or hyphens, starting with a letter.\n');
    return 2;
  }
  const repoRoot = resolve(values['repo-root'] ?? CHECKOUT_ROOT);
  if (!existsSync(resolve(repoRoot, 'docker-compose.slots.yml'))) {
    process.stderr.write(`--repo-root ${repoRoot} does not hold docker-compose.slots.yml.\n`);
    return 2;
  }
  const modes = [values.check, values['build-only'], values.restart].filter(flag => flag === true);
  if (modes.length > 1 || (values.check === true && values.fix === true)) {
    process.stderr.write('--check, --build-only and --restart are separate; --check also does not take --fix.\n');
    return 2;
  }
  const run = createRunCommand({ logFile: values['log-file'] });
  const commandName = values['command-name'] ?? 'pnpm sandbox:slots';
  const diskGb = values['disk-gb'] === undefined ? DEFAULT_DISK_GB : Number(values['disk-gb']);
  if (!Number.isInteger(diskGb) || diskGb < MIN_DISK_GB || diskGb > MAX_DISK_GB) {
    process.stderr.write(`--disk-gb must be a whole number from ${String(MIN_DISK_GB)} to ${String(MAX_DISK_GB)}.\n`);
    return 2;
  }
  const added = parsePackList(values.add ?? '');
  const removed = parsePackList(values.remove ?? '');
  const unknownPacks = [...added.unknown, ...removed.unknown];
  if (unknownPacks.length > 0) {
    process.stderr.write(`Unknown pack: ${unknownPacks.join(', ')}. The packs are go, rust and java.\n`);
    return 2;
  }
  if (values.purge === true && values.down !== true) {
    process.stderr.write('--purge only goes with --down.\n');
    return 2;
  }
  if (values.down === true) {
    const stopped = await stopSandboxSlots({
      repoRoot,
      run,
      purge: values.purge === true,
      instance,
      platform: process.platform,
      isRoot: process.getuid?.() === 0,
    });
    return stopped.exitCode === 0 ? 0 : 1;
  }
  const json = values.json === true;
  const result = await runSandboxSlots({
    repoRoot,
    run,
    fix: values.fix === true,
    instance,
    mode: values.check === true ? 'check' : values['build-only'] === true ? 'build' : 'up',
    command: commandName,
    restart: values.restart === true,
    platform: process.platform,
    isRoot: process.getuid?.() === 0,
    diskGb,
    packsPort: createPacksPort({ dir: resolve(repoRoot, 'ops', 'sandbox-slot', 'packs'), download }),
    addPacks: added.packs,
    removePacks: removed.packs,
    hardDiskLimit: values['no-hard-disk-limit'] !== true,
    confirm: question => askYesNo({ question, assumeYes: values.yes === true }),
    onCheck: json
      ? undefined
      : check => {
          process.stdout.write(formatCheck(check));
        },
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.ok) {
    for (const warning of result.warnings) {
      process.stdout.write(`[warn] ${warning}\n`);
    }
    const size = result.image_size_mb === undefined ? '' : ` Image size: ${String(result.image_size_mb)} MB.`;
    const done = values.check === true ? 'healthy' : values['build-only'] === true ? 'built' : 'running';
    process.stdout.write(`\nThe sandbox slots are ${done}.${size}\n`);
  } else {
    process.stdout.write(`\n${formatFailure(result)}`);
  }
  return result.ok ? 0 : 1;
}

process.exitCode = await main();

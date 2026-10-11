/**
 * `pnpm sandbox:slots`: builds the sandbox slot image and starts the slots.
 * Flags: `--fix` (allow the sudo steps: loading the AppArmor profile and creating the per-slot disks on
 * Linux; the disks are only created after a yes, or with `--yes`), `--disk-gb <n>` (size of each slot's
 * disk, default 16), `--no-hard-disk-limit` (skip the per-slot disks), `--down` (stop the slots), `--purge`
 * (with `--down`, also delete their workspace volumes and disk files), `--add <packs>` / `--remove <packs>`
 * (toolchain packs `go`, `rust`, `java` in the image; they stay chosen until removed), `--instance <name>`
 * (manage a second install's slots on the same Docker host; default `aman`), `--json`.
 * Exit code 0 when every check passes, 1 when a check fails, 2 on a usage error.
 */
import { spawn } from 'node:child_process';
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
  INSTANCE_ENV,
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function isMissingBinary(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

const download: Download = async ({ url, destination }) => {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)} from ${new URL(url).host}`);
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
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

const runCommand: CommandRunner = ({ command, args, cwd, echo, interactive, env }) =>
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
        process.stderr.write(chunk);
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (echo) {
        process.stderr.write(chunk);
      }
    });
    child.on('error', (error: Error) => {
      reject(isMissingBinary(error) ? new CommandNotFoundError(command, { cause: error }) : error);
    });
    child.on('close', (code: number | null) => {
      resolvePromise({ stdout, stderr, exitCode: code ?? 1 });
    });
  });

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
      },
      strict: true,
    }));
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\nUsage: pnpm sandbox:slots [--fix [--yes]] [--disk-gb <n>] [--no-hard-disk-limit] [--add go,rust,java] [--remove go,rust,java] [--json] [--instance <name>] | --down [--purge] [--instance <name>]\n`,
    );
    return 2;
  }
  const instance = values.instance ?? DEFAULT_INSTANCE;
  if (!INSTANCE_PATTERN.test(instance)) {
    process.stderr.write('--instance must be 1 to 16 lowercase letters or digits, starting with a letter.\n');
    return 2;
  }
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
      repoRoot: REPO_ROOT,
      run: runCommand,
      purge: values.purge === true,
      instance,
      platform: process.platform,
      isRoot: process.getuid?.() === 0,
    });
    return stopped.exitCode === 0 ? 0 : 1;
  }
  const json = values.json === true;
  const result = await runSandboxSlots({
    repoRoot: REPO_ROOT,
    run: runCommand,
    fix: values.fix === true,
    instance,
    platform: process.platform,
    isRoot: process.getuid?.() === 0,
    diskGb,
    packsPort: createPacksPort({ dir: resolve(REPO_ROOT, 'ops', 'sandbox-slot', 'packs'), download }),
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
    const size = result.image_size_mb === undefined ? '' : ` Image size: ${String(result.image_size_mb)} MB.`;
    process.stdout.write(
      `\nThe sandbox slots are running.${size}\nNext: add this file to your deploy's compose command with -f, then restart the app:\n  -f ${result.app_compose_file}\n${instance === DEFAULT_INSTANCE ? '' : `This install is named "${instance}": run the deploy's compose command with ${INSTANCE_ENV}=${instance} set.\n`}`,
    );
  } else {
    process.stdout.write(`\n${formatFailure(result)}`);
  }
  return result.ok ? 0 : 1;
}

process.exitCode = await main();

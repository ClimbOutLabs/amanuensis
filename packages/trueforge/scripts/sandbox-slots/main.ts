/**
 * `pnpm sandbox:slots`: builds the sandbox slot image and starts the slots.
 * Flags: `--fix` (allow the one sudo step that loads the AppArmor profile), `--down` (stop the slots),
 * `--purge` (with `--down`, also delete their workspace volumes), `--json`.
 * Exit code 0 when every check passes, 1 when a check fails, 2 on a usage error.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  CommandNotFoundError,
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

const runCommand: CommandRunner = ({ command, args, cwd, echo, interactive }) =>
  new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
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
  };
  try {
    ({ values } = parseArgs({
      options: {
        fix: { type: 'boolean' },
        down: { type: 'boolean' },
        purge: { type: 'boolean' },
        json: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\nUsage: pnpm sandbox:slots [--fix] [--json] | --down [--purge]\n`,
    );
    return 2;
  }
  if (values.purge === true && values.down !== true) {
    process.stderr.write('--purge only goes with --down.\n');
    return 2;
  }
  if (values.down === true) {
    const stopped = await stopSandboxSlots({ repoRoot: REPO_ROOT, run: runCommand, purge: values.purge === true });
    return stopped.exitCode === 0 ? 0 : 1;
  }
  const json = values.json === true;
  const result = await runSandboxSlots({
    repoRoot: REPO_ROOT,
    run: runCommand,
    fix: values.fix === true,
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
      `\nThe sandbox slots are running.${size}\nNext: add this file to your deploy's compose command with -f, then restart the app:\n  -f ${result.app_compose_file}\n`,
    );
  } else {
    process.stdout.write(`\n${formatFailure(result)}`);
  }
  return result.ok ? 0 : 1;
}

process.exitCode = await main();

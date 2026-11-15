import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './atomicFile.js';
import type { KeyStoreKind } from './instances.js';

/**
 * Where a terminal key lives on the person's computer: the system keychain where
 * the platform offers one this app can reach without extra installs, and an
 * owner-only file where it does not. A key is never printed and never logged.
 * It is handed to the keychain command as that command expects, and to the file
 * store at mode 0600 inside a folder at mode 0700.
 */
export interface KeyStore {
  readonly kind: KeyStoreKind;
  get(address: string): Promise<string | undefined>;
  set(options: { address: string; key: string }): Promise<void>;
  delete(address: string): Promise<void>;
}

/** Runs one external command. The key travels only as an argument or on stdin, never in a message this app prints. */
export type CommandRunner = (file: string, args: string[], input?: string) => Promise<{ stdout: string }>;

/** A command that ran and failed. Carries the exit code so callers can tell "not there" from "broken". */
export class CommandFailedError extends Error {
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CommandFailedError';
    this.exitCode = exitCode;
  }
}

function exitCodeOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code;
    return typeof code === 'number' ? code : null;
  }
  return null;
}

/** The default runner: execFile with no shell, so arguments are never reinterpreted. Input goes to stdin. */
export const runCommand: CommandRunner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        reject(new CommandFailedError(`The command ${file} did not run.`, exitCodeOf(error), error));
        return;
      }
      resolve({ stdout: stdout.toString() });
    });
    child.stdin?.end(input);
  });

const KEYCHAIN_SERVICE = 'aman-tui';

/** macOS: the person's login keychain, reached through the `security` tool that ships with the system. */
export class MacKeychainStore implements KeyStore {
  readonly kind = 'keychain' as const;
  readonly #run: CommandRunner;

  constructor(run: CommandRunner = runCommand) {
    this.#run = run;
  }

  async get(address: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.#run('security', [
        'find-generic-password',
        '-a',
        address,
        '-s',
        KEYCHAIN_SERVICE,
        '-w',
      ]);
      const key = stdout.replace(/\n$/, '');
      return key === '' ? undefined : key;
    } catch (error) {
      // Exit 44 is the keychain saying there is no such item.
      if (error instanceof CommandFailedError && error.exitCode === 44) {
        return undefined;
      }
      throw error;
    }
  }

  async set(options: { address: string; key: string }): Promise<void> {
    await this.#run('security', [
      'add-generic-password',
      '-a',
      options.address,
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
      options.key,
      '-U',
    ]);
  }

  async delete(address: string): Promise<void> {
    try {
      await this.#run('security', ['delete-generic-password', '-a', address, '-s', KEYCHAIN_SERVICE]);
    } catch (error) {
      if (error instanceof CommandFailedError && error.exitCode === 44) {
        return;
      }
      throw error;
    }
  }
}

/** Linux: the desktop secret service, reached through `secret-tool` where it is installed. The key goes on stdin. */
export class LinuxSecretStore implements KeyStore {
  readonly kind = 'keychain' as const;
  readonly #run: CommandRunner;

  constructor(run: CommandRunner = runCommand) {
    this.#run = run;
  }

  async get(address: string): Promise<string | undefined> {
    const { stdout } = await this.#run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', address]);
    const key = stdout.replace(/\n$/, '');
    return key === '' ? undefined : key;
  }

  async set(options: { address: string; key: string }): Promise<void> {
    await this.#run(
      'secret-tool',
      ['store', '--label', 'Aman terminal key', 'service', KEYCHAIN_SERVICE, 'account', options.address],
      options.key,
    );
  }

  async delete(address: string): Promise<void> {
    await this.#run('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', address]);
  }

  /** True when the tool answers at all: a missing tool or an unreachable secret service both fail the probe. */
  async probe(): Promise<boolean> {
    try {
      await this.get('aman-tui-probe');
      return true;
    } catch {
      return false;
    }
  }
}

const KEYS_FILE = 'keys.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The fallback: an owner-only file in the app's own config folder. Used where no keychain is offered. */
export class FileKeyStore implements KeyStore {
  readonly kind = 'file' as const;
  readonly #configDir: string;

  constructor(configDir: string) {
    this.#configDir = configDir;
  }

  #readAll(): Record<string, string> {
    let raw: string;
    try {
      raw = readFileSync(path.join(this.#configDir, KEYS_FILE), 'utf8');
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (!isRecord(parsed)) {
      return {};
    }
    const keys: Record<string, string> = {};
    for (const [address, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value !== '') {
        keys[address] = value;
      }
    }
    return keys;
  }

  #writeAll(keys: Record<string, string>): void {
    mkdirSync(this.#configDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#configDir, 0o700);
    writeFileAtomic({
      filePath: path.join(this.#configDir, KEYS_FILE),
      content: `${JSON.stringify(keys, null, 2)}\n`,
      mode: 0o600,
    });
  }

  async get(address: string): Promise<string | undefined> {
    return this.#readAll()[address];
  }

  async set(options: { address: string; key: string }): Promise<void> {
    const keys = this.#readAll();
    keys[options.address] = options.key;
    this.#writeAll(keys);
  }

  async delete(address: string): Promise<void> {
    const keys = this.#readAll();
    if (address in keys) {
      delete keys[address];
      this.#writeAll(keys);
    }
  }
}

/** The store a new pairing saves into: the keychain where the platform offers one, the file where it does not. */
export async function chooseKeyStore(options: {
  configDir: string;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
}): Promise<KeyStore> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  if (platform === 'darwin') {
    return new MacKeychainStore(run);
  }
  if (platform === 'linux') {
    const linux = new LinuxSecretStore(run);
    if (await linux.probe()) {
      return linux;
    }
  }
  return new FileKeyStore(options.configDir);
}

/** The store a saved instance names, opened for reading its key back. */
export function keyStoreForKind(
  kind: KeyStoreKind,
  options: { configDir: string; platform?: NodeJS.Platform; run?: CommandRunner },
): KeyStore {
  const run = options.run ?? runCommand;
  if (kind === 'file') {
    return new FileKeyStore(options.configDir);
  }
  return (options.platform ?? process.platform) === 'linux' ? new LinuxSecretStore(run) : new MacKeychainStore(run);
}

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';

import type { Command } from './command';
import { processEnv, type CliEnv } from './env';
import { errorCode } from './errorCode';
import { UsageError } from './io';

const MANIFEST_NAME = 'manifest.json';
const DB_NAME = 'db.sqlite';
const MEMORY_DIR = 'memory';
const PERSONA_DIR = 'persona-knowledge';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface BackupDeps {
  env: CliEnv;
  now(): Date;
  /** Writes a consistent copy of a live SQLite database to `dest`. */
  backupSqlite(options: { source: string; dest: string }): Promise<void>;
}

interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** Online backup API, so a running app keeps writing; the copy must pass an integrity check. */
export async function backupSqliteFile({ source, dest }: { source: string; dest: string }): Promise<void> {
  const db = new Database(source, { fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  // Opened read-write so SQLite removes its -wal and -shm sidecars when it closes, leaving one file.
  const copy = new Database(dest, { fileMustExist: true });
  try {
    const result = copy.pragma('integrity_check', { simple: true });
    if (result !== 'ok') {
      throw new Error(`The SQLite copy failed its integrity check: ${String(result)}`);
    }
  } finally {
    copy.close();
  }
}

/** Copies regular files only; symlinks are skipped so a link cannot pull in files from outside the directory. */
async function copyTree({
  source,
  dest,
  warn,
}: {
  source: string;
  dest: string;
  warn: (message: string) => void;
}): Promise<void> {
  await mkdir(dest, { recursive: true, mode: DIR_MODE });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree({ source: from, dest: to, warn });
    } else if (entry.isFile()) {
      await copyFile(from, to);
      await chmod(to, FILE_MODE);
    } else {
      warn(`Skipped ${entry.name}: not a regular file.`);
    }
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', chunk => {
        hash.update(chunk);
      })
      .on('end', () => {
        resolve(hash.digest('hex'));
      });
  });
}

async function listFiles({ root, dir = '' }: { root: string; dir?: string }): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await listFiles({ root, dir: relative })));
    } else if (entry.isFile()) {
      found.push(relative);
    }
  }
  return found.sort();
}

async function isEmptyDirectory(target: string): Promise<boolean> {
  return (await stat(target)).isDirectory() && (await readdir(target)).length === 0;
}

function isInside({ child, parent }: { child: string; parent: string }): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requiredPath({ value, flag, envKey }: { value: string | undefined; flag: string; envKey: string }): string {
  if (value === undefined || value.trim() === '') {
    throw new UsageError(`Missing ${flag} (or ${envKey} in the environment).`);
  }
  return path.resolve(value);
}

export function createBackup(deps: BackupDeps): Command {
  return async ({ args, io }) => {
    let values: { target?: string; sqlite?: string; 'memory-dir'?: string; 'persona-dir'?: string };
    try {
      ({ values } = parseArgs({
        args: [...args],
        options: {
          target: { type: 'string' },
          sqlite: { type: 'string' },
          'memory-dir': { type: 'string' },
          'persona-dir': { type: 'string' },
        },
        allowPositionals: false,
        strict: true,
      }));
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : 'Invalid arguments.', { cause: error });
    }
    if (values.target === undefined) {
      throw new UsageError('Missing --target <directory>.');
    }
    const target = path.resolve(values.target);
    const sqlite = requiredPath({
      value: values.sqlite ?? deps.env['SQLITE_PATH'],
      flag: '--sqlite',
      envKey: 'SQLITE_PATH',
    });
    const memoryDir = requiredPath({
      value: values['memory-dir'] ?? deps.env['MEMORY_MARKDOWN_DIR'],
      flag: '--memory-dir',
      envKey: 'MEMORY_MARKDOWN_DIR',
    });
    const personaDir = requiredPath({
      value: values['persona-dir'] ?? deps.env['PERSONA_KNOWLEDGE_DIR'],
      flag: '--persona-dir',
      envKey: 'PERSONA_KNOWLEDGE_DIR',
    });

    for (const source of [memoryDir, personaDir]) {
      if (isInside({ child: target, parent: source })) {
        throw new UsageError('--target must not be inside a directory being backed up.');
      }
    }
    if ((await pathExists(target)) && !(await isEmptyDirectory(target))) {
      throw new UsageError('--target already exists and is not an empty directory; backups never overwrite.');
    }

    const warnings: string[] = [];
    let createdRoot: string | undefined;
    try {
      createdRoot = await mkdir(target, { recursive: true, mode: DIR_MODE });
      await chmod(target, DIR_MODE);
      await deps.backupSqlite({ source: sqlite, dest: path.join(target, DB_NAME) });
      await chmod(path.join(target, DB_NAME), FILE_MODE);
      for (const [source, name] of [
        [memoryDir, MEMORY_DIR],
        [personaDir, PERSONA_DIR],
      ] as const) {
        if (await pathExists(source)) {
          await copyTree({ source, dest: path.join(target, name), warn: message => warnings.push(message) });
        } else {
          warnings.push(`${name} directory does not exist; backed up as empty.`);
          await mkdir(path.join(target, name), { recursive: true, mode: DIR_MODE });
        }
      }

      const files: ManifestFile[] = [];
      for (const relative of await listFiles({ root: target })) {
        const full = path.join(target, relative);
        files.push({ path: relative, sha256: await sha256File(full), bytes: (await stat(full)).size });
      }
      const manifest = { version: 1, created_at: deps.now().toISOString(), files };
      await writeFile(path.join(target, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: FILE_MODE });

      for (const warning of warnings) {
        await io.stderr(`${warning}\n`);
      }
      const bytes = files.reduce((total, file) => total + file.bytes, 0);
      await io.stdout(`${JSON.stringify({ target, manifest: MANIFEST_NAME, files: files.length, bytes })}\n`);
      return 0;
    } catch (error) {
      // Never leave a half-written backup that could be mistaken for a good one.
      // A pre-existing target may be a mount point, so empty it instead of removing it.
      if (createdRoot !== undefined) {
        await rm(createdRoot, { recursive: true, force: true });
      } else {
        for (const name of await readdir(target)) {
          await rm(path.join(target, name), { recursive: true, force: true });
        }
      }
      throw error;
    }
  };
}

export const backup: Command = createBackup({
  env: processEnv(),
  now: () => new Date(),
  backupSqlite: backupSqliteFile,
});

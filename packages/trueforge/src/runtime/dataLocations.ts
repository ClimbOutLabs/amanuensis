import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { errorCode } from '../cli/errorCode';
import type { ServerConfiguration } from '../config';
import type { DataLocation } from '../schemas/privacy';

/** Stop counting a folder after this many entries; the size is then reported as not measured. */
const DIR_SIZE_MAX_ENTRIES = 50_000;

export type DatabaseLocation = { kind: 'sqlite'; file: string } | { kind: 'postgres'; address: string };

export interface DataLocationsInput {
  database: DatabaseLocation;
  memory: { backend: 'markdown' | 'hindsight'; dir: string };
  personaKnowledgeDir: string;
  sandboxRunsDir: string;
}

/** Bytes in a regular file, or 0 when it does not exist. */
async function fileSize(file: string): Promise<number> {
  try {
    return (await lstat(file)).size;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

/**
 * Total bytes of regular files under `dir` (symlinks are not followed); 0 for a folder that does
 * not exist yet, null when it holds too many entries to count cheaply.
 */
export async function directorySize({
  dir,
  maxEntries = DIR_SIZE_MAX_ENTRIES,
}: {
  dir: string;
  maxEntries?: number;
}): Promise<number | null> {
  let total = 0;
  let seen = 0;
  const pending = [dir];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > maxEntries) {
        return null;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        total += await fileSize(full);
      }
    }
  }
  return total;
}

async function databaseSize(database: DatabaseLocation): Promise<number | null> {
  if (database.kind === 'postgres') {
    return null;
  }
  const sizes = await Promise.all([database.file, `${database.file}-wal`, `${database.file}-shm`].map(fileSize));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function databasePhrase(database: DatabaseLocation): string {
  return database.kind === 'sqlite'
    ? `the database file ${database.file}`
    : `the Postgres database ${database.address}`;
}

/** Host, port and name of a Postgres connection string; credentials are never read out. */
function postgresAddress(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const name = url.pathname.replace(/^\//, '');
    return `"${name}" on ${url.hostname}${url.port === '' ? '' : `:${url.port}`}`;
  } catch {
    return 'named by DATABASE_URL';
  }
}

/** The settings the inventory reads; either storage mode supplies its own database setting. */
export type DataLocationsConfiguration = Pick<
  ServerConfiguration,
  'MEMORY_BACKEND' | 'MEMORY_MARKDOWN_DIR' | 'PERSONA_KNOWLEDGE_DIR' | 'SANDBOX_RUNS_DIR'
> &
  ({ STANDALONE: true; SQLITE_PATH: string } | { STANDALONE: false; DATABASE_URL: string });

/** The inventory input for the running server's configuration. */
export function dataLocationsInput(config: DataLocationsConfiguration): DataLocationsInput {
  return {
    database: config.STANDALONE
      ? { kind: 'sqlite', file: config.SQLITE_PATH }
      : { kind: 'postgres', address: postgresAddress(config.DATABASE_URL) },
    memory: { backend: config.MEMORY_BACKEND, dir: config.MEMORY_MARKDOWN_DIR },
    personaKnowledgeDir: config.PERSONA_KNOWLEDGE_DIR,
    sandboxRunsDir: config.SANDBOX_RUNS_DIR,
  };
}

/** Where each kind of data lives, read from the running server's configuration and measured on disk. */
export async function listDataLocations(input: DataLocationsInput): Promise<DataLocation[]> {
  const memoryDir = path.resolve(input.memory.dir);
  const knowledgeDir = path.resolve(input.personaKnowledgeDir);
  const runsDir = path.resolve(input.sandboxRunsDir);
  const [dbBytes, memoryBytes, knowledgeBytes, runsBytes] = await Promise.all([
    databaseSize(input.database),
    input.memory.backend === 'markdown' ? directorySize({ dir: memoryDir }) : Promise.resolve(null),
    directorySize({ dir: knowledgeDir }),
    directorySize({ dir: runsDir }),
  ]);
  const database = databasePhrase(input.database);
  const sharedDatabase = 'chats, personas and settings together';
  return [
    {
      id: 'chats',
      name: 'Chats',
      where: `Inside ${database}.`,
      size_bytes: dbBytes,
      size_covers: dbBytes === null ? null : sharedDatabase,
    },
    {
      id: 'memory',
      name: 'Memory',
      where:
        input.memory.backend === 'markdown'
          ? `In plain text files in the folder ${memoryDir}.`
          : 'In the memory service you connected under Settings > Connectors, not on this computer.',
      size_bytes: memoryBytes,
      size_covers: null,
    },
    {
      id: 'personas',
      name: 'Personas',
      where: `Persona definitions are inside ${database}. Their knowledge files are in the folder ${knowledgeDir}.`,
      size_bytes: knowledgeBytes,
      size_covers: 'the knowledge files only; the definitions are counted with chats',
    },
    {
      id: 'files_from_runs',
      name: 'Files from runs',
      where: `Working files from code runs are in the folder ${runsDir}. Result files you can download are kept inside ${database}.`,
      size_bytes: runsBytes,
      size_covers: 'the working folder only',
    },
    {
      id: 'settings',
      name: 'Settings',
      where: `Inside ${database}.`,
      size_bytes: dbBytes,
      size_covers: dbBytes === null ? null : sharedDatabase,
    },
    {
      id: 'backups',
      name: 'Backups',
      where:
        'Aman makes no backups by itself. When you run "aman backup --target <folder>", the copy goes to the folder you name.',
      size_bytes: null,
      size_covers: null,
    },
  ];
}

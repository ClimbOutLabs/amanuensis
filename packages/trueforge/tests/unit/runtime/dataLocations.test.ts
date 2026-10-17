import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { dataLocationsInput, directorySize, listDataLocations } from '../../../src/runtime/dataLocations';

describe('data locations', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'aman-locations-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function populate() {
    const memory = path.join(root, 'memory');
    const knowledge = path.join(root, 'knowledge');
    const runs = path.join(root, 'runs');
    const database = path.join(root, 'db.sqlite');
    await mkdir(path.join(memory, 'nested'), { recursive: true });
    await writeFile(path.join(memory, 'a.md'), 'x'.repeat(100));
    await writeFile(path.join(memory, 'nested', 'b.md'), 'y'.repeat(50));
    await mkdir(knowledge);
    await writeFile(path.join(knowledge, 'k.txt'), 'z'.repeat(300));
    await writeFile(database, 'd'.repeat(1000));
    await writeFile(`${database}-wal`, 'w'.repeat(24));
    return { memory, knowledge, runs, database };
  }

  it('measures the real files and names the real folders', async () => {
    const paths = await populate();
    const locations = await listDataLocations({
      database: { kind: 'sqlite', file: paths.database },
      memory: { backend: 'markdown', dir: paths.memory },
      personaKnowledgeDir: paths.knowledge,
      sandboxRunsDir: paths.runs,
    });

    expect(locations.map(location => location.id)).toEqual([
      'chats',
      'memory',
      'personas',
      'files_from_runs',
      'settings',
      'backups',
    ]);
    const byId = Object.fromEntries(locations.map(location => [location.id, location]));
    expect(byId['chats']?.where).toContain(paths.database);
    expect(byId['chats']?.size_bytes).toBe(1024);
    expect(byId['settings']?.where).toContain(paths.database);
    expect(byId['memory']?.where).toContain(paths.memory);
    expect(byId['memory']?.size_bytes).toBe(150);
    expect(byId['personas']?.where).toContain(paths.knowledge);
    expect(byId['personas']?.size_bytes).toBe(300);
  });

  it('reports a folder that does not exist yet as empty, not unknown', async () => {
    const paths = await populate();
    const locations = await listDataLocations({
      database: { kind: 'sqlite', file: paths.database },
      memory: { backend: 'markdown', dir: paths.memory },
      personaKnowledgeDir: paths.knowledge,
      sandboxRunsDir: paths.runs,
    });

    expect(locations.find(location => location.id === 'files_from_runs')?.size_bytes).toBe(0);
  });

  it('says backups are made only on request, with no invented folder or size', async () => {
    const paths = await populate();
    const backups = (
      await listDataLocations({
        database: { kind: 'sqlite', file: paths.database },
        memory: { backend: 'markdown', dir: paths.memory },
        personaKnowledgeDir: paths.knowledge,
        sandboxRunsDir: paths.runs,
      })
    ).find(location => location.id === 'backups');

    expect(backups?.size_bytes).toBeNull();
    expect(backups?.where).toContain('aman backup --target');
  });

  it('names a Postgres database by name and host and leaves its size unmeasured', async () => {
    const paths = await populate();
    const locations = await listDataLocations({
      database: { kind: 'postgres', address: '"aman" on db.internal:5432' },
      memory: { backend: 'markdown', dir: paths.memory },
      personaKnowledgeDir: paths.knowledge,
      sandboxRunsDir: paths.runs,
    });
    const chats = locations.find(location => location.id === 'chats');

    expect(chats?.where).toContain('"aman" on db.internal:5432');
    expect(chats?.size_bytes).toBeNull();
    expect(chats?.size_covers).toBeNull();
  });

  it('points memory at the connected service when it is not kept in files', async () => {
    const paths = await populate();
    const memory = (
      await listDataLocations({
        database: { kind: 'sqlite', file: paths.database },
        memory: { backend: 'hindsight', dir: paths.memory },
        personaKnowledgeDir: paths.knowledge,
        sandboxRunsDir: paths.runs,
      })
    ).find(location => location.id === 'memory');

    expect(memory?.where).toContain('Connectors');
    expect(memory?.size_bytes).toBeNull();
  });

  it('never follows a link out of the folder it measures', async () => {
    const paths = await populate();
    await symlink(paths.knowledge, path.join(paths.memory, 'link'));

    expect(await directorySize({ dir: paths.memory })).toBe(150);
  });

  it('gives up measuring a folder with too many entries rather than guessing', async () => {
    const paths = await populate();

    expect(await directorySize({ dir: paths.memory, maxEntries: 2 })).toBeNull();
    expect(await directorySize({ dir: paths.memory, maxEntries: 3 })).toBe(150);
  });

  it('reads the running configuration, and never a password out of the Postgres address', () => {
    const shared = {
      MEMORY_BACKEND: 'markdown',
      MEMORY_MARKDOWN_DIR: '/data/memory',
      PERSONA_KNOWLEDGE_DIR: '/data/knowledge',
      SANDBOX_RUNS_DIR: '/data/runs',
    } as const;
    const standalone = dataLocationsInput({ ...shared, STANDALONE: true, SQLITE_PATH: '/data/db.sqlite' });
    expect(standalone).toEqual({
      database: { kind: 'sqlite', file: '/data/db.sqlite' },
      memory: { backend: 'markdown', dir: '/data/memory' },
      personaKnowledgeDir: '/data/knowledge',
      sandboxRunsDir: '/data/runs',
    });

    const distributed = dataLocationsInput({
      ...shared,
      STANDALONE: false,
      DATABASE_URL: 'postgres://aman:hunter2@db.internal:5432/aman',
    });
    expect(distributed.database).toEqual({ kind: 'postgres', address: '"aman" on db.internal:5432' });
    expect(JSON.stringify(distributed)).not.toContain('hunter2');
  });

  it('falls back to naming DATABASE_URL when the address cannot be read', () => {
    const input = dataLocationsInput({
      MEMORY_BACKEND: 'markdown',
      MEMORY_MARKDOWN_DIR: '/m',
      PERSONA_KNOWLEDGE_DIR: '/k',
      SANDBOX_RUNS_DIR: '/r',
      STANDALONE: false,
      DATABASE_URL: 'not a url',
    });
    expect(input.database).toEqual({ kind: 'postgres', address: 'named by DATABASE_URL' });
  });
});

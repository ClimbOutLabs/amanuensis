import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runCli } from '../../../src/cli/dispatch';
import { createImportData, type ImportDataDeps } from '../../../src/cli/importData';
import type { ImportDataSession } from '../../../src/cli/importData/session';
import { DataImportError } from '../../../src/dataImport/importError';
import type { ImportDataResult } from '../../../src/schemas/dataImport';
import { fakeIo } from './fakeIo';

// The dispatcher must run without the server config, which throws on missing env.
jest.mock('../../../src/config', () => {
  throw new Error('server config was loaded by the CLI');
});

const OWNER = 'owner@example.com';
const RESULT: ImportDataResult = {
  chats: 3,
  memories: 2,
  personas: 1,
  spaces: 0,
  schedules: 1,
  folders: 1,
  agents: 1,
  connectors: 2,
  schedules_off: true,
  summary: 'Imported 3 chats, 2 memories, 1 persona, 0 spaces, 1 agent, 1 schedule (off).',
};

interface Calls {
  opened: number;
  closed: number;
  imports: { bytes: string; userId: string; displayName: string; dryRun: boolean }[];
  audits: { userId: string; description: string }[];
}

function fakeDeps(options: { importError?: Error; auditError?: Error; modelReady?: boolean } = {}) {
  const calls: Calls = { opened: 0, closed: 0, imports: [], audits: [] };
  const session: ImportDataSession = {
    owner: OWNER,
    importArchive: ({ archive, userId, displayName, dryRun }) => {
      calls.imports.push({ bytes: archive.toString('utf8'), userId, displayName, dryRun });
      return options.importError === undefined ? Promise.resolve(RESULT) : Promise.reject(options.importError);
    },
    recordAudit: input => {
      calls.audits.push(input);
      return options.auditError === undefined ? Promise.resolve() : Promise.reject(options.auditError);
    },
    close: () => {
      calls.closed += 1;
      return Promise.resolve();
    },
  };
  const deps: ImportDataDeps = {
    open: () => {
      calls.opened += 1;
      return Promise.resolve(session);
    },
    searchModelReady: () => Promise.resolve(options.modelReady ?? true),
  };
  return { deps, calls };
}

describe('aman import-data', () => {
  let dir: string;
  let archivePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tfy-import-cli-'));
    archivePath = path.join(dir, 'export.zip');
    await writeFile(archivePath, 'archive-bytes');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('imports for the owner by default, prints JSON on stdout and the summary on stderr', async () => {
    const { deps, calls } = fakeDeps();
    const io = fakeIo();
    const code = await createImportData(deps)({ args: ['--in', archivePath], io });
    expect(code).toBe(0);
    expect(calls.imports).toEqual([{ bytes: 'archive-bytes', userId: OWNER, displayName: OWNER, dryRun: false }]);
    expect(JSON.parse(io.out.join(''))).toEqual({ user_id: OWNER, ...RESULT });
    expect(io.err.join('')).toBe(`${RESULT.summary}\n`);
    expect(calls.audits).toHaveLength(1);
    expect(calls.audits[0]).toMatchObject({ userId: OWNER });
    expect(calls.audits[0]?.description).toContain('from the command line');
    expect(calls.closed).toBe(1);
  });

  it('with --dry-run, prints what an import would bring and records nothing', async () => {
    const { deps, calls } = fakeDeps();
    const io = fakeIo();
    const code = await createImportData(deps)({ args: ['--in', archivePath, '--dry-run'], io });
    expect(code).toBe(0);
    expect(calls.imports).toEqual([{ bytes: 'archive-bytes', userId: OWNER, displayName: OWNER, dryRun: true }]);
    expect(JSON.parse(io.out.join(''))).toEqual({ user_id: OWNER, dry_run: true, ...RESULT });
    expect(io.err.join('')).toBe(`${RESULT.summary}\n`);
    expect(calls.audits).toEqual([]);
  });

  it('accepts the owner given explicitly, with a display name', async () => {
    const { deps, calls } = fakeDeps();
    const io = fakeIo();
    const code = await createImportData(deps)({
      args: ['--in', archivePath, '--user', OWNER, '--display-name', 'Sam Example'],
      io,
    });
    expect(code).toBe(0);
    expect(calls.imports[0]).toMatchObject({ userId: OWNER, displayName: 'Sam Example' });
  });

  it('refuses any user that is not the owner, without importing', async () => {
    const { deps, calls } = fakeDeps();
    const run = createImportData(deps)({ args: ['--in', archivePath, '--user', 'someone@example.com'], io: fakeIo() });
    await expect(run).rejects.toThrow(/must be this instance's owner \(owner@example.com\)/);
    await expect(run).rejects.toBeInstanceOf(Error);
    expect(calls.imports).toEqual([]);
    expect(calls.closed).toBeGreaterThan(0);
  });

  it('exits 2 for a usage mistake and 1 for a failure, through the dispatcher', async () => {
    // Registered through the real dispatcher: no --in is a usage error (exit 2).
    const io = fakeIo();
    expect(await runCli({ argv: ['import-data'], io })).toBe(2);
    expect(io.err.join('')).toContain('Missing --in <file.zip>.');
    expect(io.out).toEqual([]);
  });

  it('exits 2 for a user that is not the owner', async () => {
    const { deps } = fakeDeps();
    const io = fakeIo();
    const command = createImportData(deps);
    const failure: unknown = await command({ args: ['--in', archivePath, '--user', 'x@example.com'], io }).catch(
      (caught: unknown) => caught,
    );
    expect(failure).toMatchObject({ name: 'UsageError' });
  });

  it('reports a missing file without opening the instance', async () => {
    const { deps, calls } = fakeDeps();
    const run = createImportData(deps)({ args: ['--in', path.join(dir, 'nope.zip')], io: fakeIo() });
    await expect(run).rejects.toThrow(/There is no file at/);
    expect(calls.opened).toBe(0);
  });

  it('passes the refusal message of a failed import through, and adds a hint when the search model is missing', async () => {
    const refused = fakeDeps({ importError: new DataImportError('This instance already has chats.', 409) });
    await expect(createImportData(refused.deps)({ args: ['--in', archivePath], io: fakeIo() })).rejects.toThrow(
      'This instance already has chats.',
    );
    expect(refused.calls.closed).toBe(1);
    expect(refused.calls.audits).toEqual([]);

    const notReady = fakeDeps({
      importError: new DataImportError(
        'The knowledge index is still downloading, retry in a few minutes. Nothing was imported.',
        503,
      ),
    });
    await expect(createImportData(notReady.deps)({ args: ['--in', archivePath], io: fakeIo() })).rejects.toThrow(
      /still downloading, retry in a few minutes.*Start the instance, wait/s,
    );
  });

  it('still reports success when only the audit row could not be written', async () => {
    const { deps } = fakeDeps({ auditError: new Error('audit table locked') });
    const io = fakeIo();
    expect(await createImportData(deps)({ args: ['--in', archivePath], io })).toBe(0);
    expect(io.err.join('')).toContain('audit row was not written: audit table locked');
    expect(JSON.parse(io.out.join(''))).toMatchObject({ user_id: OWNER, chats: 3 });
  });

  it('says whether the search model is on disk with --check-ready, without opening the instance', async () => {
    for (const [modelReady, word] of [
      [true, 'ready'],
      [false, 'downloading'],
    ] as const) {
      const { deps, calls } = fakeDeps({ modelReady });
      const io = fakeIo();
      expect(await createImportData(deps)({ args: ['--check-ready'], io })).toBe(0);
      expect(JSON.parse(io.out.join(''))).toEqual({ search_model: word });
      expect(calls.opened).toBe(0);
    }
  });

  it('refuses --check-ready beside an import option', async () => {
    const { deps } = fakeDeps();
    await expect(
      createImportData(deps)({ args: ['--check-ready', '--in', archivePath], io: fakeIo() }),
    ).rejects.toThrow('--check-ready takes no other options.');
  });

  it('prints its usage for --help', async () => {
    const io = fakeIo();
    expect(await runCli({ argv: ['import-data', '--help'], io })).toBe(0);
    expect(io.err.join('')).toContain('Usage: aman import-data --in <file.zip>');
    expect(io.err.join('')).not.toContain('Export button');
  });
});

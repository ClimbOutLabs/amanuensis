import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { z } from 'zod';

import { makeCreateTurnInput } from '../../../../trueforge-core/tests/agent-session/testHelpers';

import { createExportData, type ExportDataDeps } from '../../../src/cli/exportData';
import { openExportDataSession } from '../../../src/cli/exportData/runtime';
import type { ExportDataSession } from '../../../src/cli/exportData/session';
import { UsageError } from '../../../src/cli/io';
import configuration from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { sanitizeNamespace, vaultWriteNamespace } from '../../../src/runtime/memory/markdownMemoryFiles';
import { legacySessionsOf } from '../../fixtures/legacySessions';
import { readZipEntries, zipEntryJson, zipEntryText } from '../../fixtures/zipReader';
import { fakeIo } from './fakeIo';

const ListSchema = z.object({
  sign_in: z.enum(['on', 'off']),
  sign_in_off_user_id: z.string().optional(),
  users: z.array(z.object({ user_id: z.string(), display_name: z.string(), sessions: z.number() })),
});
const ResultSchema = z.object({
  user_id: z.string(),
  out: z.string(),
  bytes: z.number(),
  files: z.number(),
  redactions: z.number(),
  uploads_included: z.boolean(),
  instance_data_included: z.boolean(),
  persona_memory_left_out: z.number(),
});

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'aman-export-data-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function fakeSession(overrides: Partial<ExportDataSession> = {}): ExportDataSession {
  return {
    signInOffUserId: undefined,
    listOwners: () => Promise.resolve([{ user_id: 'alice', display_name: 'Alice', sessions: 3 }]),
    exportUser: ({ out }) => {
      out.write('zip-bytes');
      return Promise.resolve({ bytesWritten: 9, entries: 1, redactions: 2, personaVaultsLeftOut: 0 });
    },
    recordAudit: () => Promise.resolve(),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

function command(session: ExportDataSession, opened?: { migrate: boolean[] }) {
  const deps: ExportDataDeps = {
    open: options => {
      opened?.migrate.push(options.migrate);
      return Promise.resolve(session);
    },
  };
  return createExportData(deps);
}

describe('aman export-data (arguments)', () => {
  it('needs exactly one of --list-users and --user', async () => {
    const run = command(fakeSession());
    await expect(run({ args: [], io: fakeIo() })).rejects.toBeInstanceOf(UsageError);
    await expect(run({ args: ['--list-users', '--user', 'alice'], io: fakeIo() })).rejects.toBeInstanceOf(UsageError);
  });

  it('needs --out with --user, and takes no other option with --list-users', async () => {
    const run = command(fakeSession());
    await expect(run({ args: ['--user', 'alice'], io: fakeIo() })).rejects.toThrow('--out');
    await expect(run({ args: ['--list-users', '--out', 'x.zip'], io: fakeIo() })).rejects.toBeInstanceOf(UsageError);
    await expect(run({ args: ['--nope'], io: fakeIo() })).rejects.toBeInstanceOf(UsageError);
  });

  it('prints usage for --help without opening anything', async () => {
    const opened = { migrate: [] };
    const io = fakeIo();
    expect(await command(fakeSession(), opened)({ args: ['--help'], io })).toBe(0);
    expect(io.err.join('')).toContain('aman export-data --list-users');
    expect(opened.migrate).toEqual([]);
  });
});

describe('aman export-data --list-users', () => {
  it('prints the owners and the sign-in state as one JSON line', async () => {
    const io = fakeIo();
    const session = fakeSession({ signInOffUserId: 'trueforge-default' });
    expect(await command(session)({ args: ['--list-users'], io })).toBe(0);
    expect(io.out).toHaveLength(1);
    expect(ListSchema.parse(JSON.parse(io.out.join('')))).toEqual({
      sign_in: 'off',
      sign_in_off_user_id: 'trueforge-default',
      users: [{ user_id: 'alice', display_name: 'Alice', sessions: 3 }],
    });
  });

  it('passes --migrate through only when asked', async () => {
    const migrate: boolean[] = [];
    const opened = { migrate };
    await command(fakeSession(), opened)({ args: ['--list-users'], io: fakeIo() });
    await command(fakeSession(), opened)({ args: ['--list-users', '--migrate'], io: fakeIo() });
    expect(opened.migrate).toEqual([false, true]);
  });
});

describe('aman export-data --user', () => {
  it('writes the archive whole and leaves no temporary file', async () => {
    const out = path.join(scratch, 'export.zip');
    const io = fakeIo();
    expect(await command(fakeSession())({ args: ['--user', 'alice', '--out', out], io })).toBe(0);
    expect(ResultSchema.parse(JSON.parse(io.out.join('')))).toMatchObject({
      user_id: 'alice',
      out,
      bytes: 9,
      redactions: 2,
      uploads_included: false,
      instance_data_included: false,
    });
    expect(await readdir(scratch)).toEqual(['export.zip']);
  });

  it('leaves the shared memories out unless asked, and says how to bring them', async () => {
    const asked: boolean[] = [];
    const session = fakeSession({
      exportUser: ({ includeInstanceData }) => {
        asked.push(includeInstanceData);
        return Promise.resolve({ bytesWritten: 0, entries: 0, redactions: 0, personaVaultsLeftOut: 0 });
      },
    });
    const io = fakeIo();
    await command(session)({ args: ['--user', 'alice', '--out', path.join(scratch, 'a.zip')], io });
    expect(io.err.join('')).toContain('--include-instance-data');
    const withShared = fakeIo();
    await command(session)({
      args: ['--user', 'alice', '--out', path.join(scratch, 'b.zip'), '--include-instance-data'],
      io: withShared,
    });
    expect(asked).toEqual([false, true]);
    expect(withShared.err.join('')).toBe('');
  });

  it('never leaves a partial file when the export fails midway', async () => {
    const out = path.join(scratch, 'export.zip');
    const session = fakeSession({
      exportUser: ({ out: sink }) => {
        sink.write('half');
        return Promise.reject(new Error('the database went away\n  at somewhere'));
      },
    });
    const failure = await command(session)({ args: ['--user', 'alice', '--out', out], io: fakeIo() }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : '').toBe('the database went away at somewhere');
    expect(await readdir(scratch)).toEqual([]);
  });

  it('records an audit row for a finished export and for a failed one', async () => {
    const rows: string[] = [];
    const recordAudit = ({ description }: { description: string }) => {
      rows.push(description);
      return Promise.resolve();
    };
    await command(fakeSession({ recordAudit }))({
      args: ['--user', 'alice', '--out', path.join(scratch, 'ok.zip')],
      io: fakeIo(),
    });
    await command(fakeSession({ recordAudit, exportUser: () => Promise.reject(new Error('boom')) }))({
      args: ['--user', 'alice', '--out', path.join(scratch, 'bad.zip')],
      io: fakeIo(),
    }).catch(() => undefined);
    expect(rows).toEqual([
      'Exported data of user alice from the command line (9 bytes).',
      'Data export of user alice from the command line failed.',
    ]);
  });

  it('still succeeds, with a note on stderr, when the audit row cannot be written', async () => {
    const io = fakeIo();
    const session = fakeSession({ recordAudit: () => Promise.reject(new Error('audit table locked')) });
    expect(await command(session)({ args: ['--user', 'alice', '--out', path.join(scratch, 'ok.zip')], io })).toBe(0);
    expect(io.err.join('')).toContain('audit table locked');
    expect(await readdir(scratch)).toEqual(['ok.zip']);
  });

  it('closes the session on success and on failure', async () => {
    let closed = 0;
    const base = { close: () => ((closed += 1), Promise.resolve()) };
    await command(fakeSession(base))({ args: ['--user', 'alice', '--out', path.join(scratch, 'a.zip')], io: fakeIo() });
    await command(fakeSession({ ...base, exportUser: () => Promise.reject(new Error('boom')) }))({
      args: ['--user', 'alice', '--out', path.join(scratch, 'b.zip')],
      io: fakeIo(),
    }).catch(() => undefined);
    expect(closed).toBe(2);
  });

  it('refuses to overwrite and to write into a missing directory', async () => {
    const existing = path.join(scratch, 'there.zip');
    await writeFile(existing, 'precious');
    await expect(
      command(fakeSession())({ args: ['--user', 'alice', '--out', existing], io: fakeIo() }),
    ).rejects.toThrow('already exists');
    await expect(
      command(fakeSession())({ args: ['--user', 'alice', '--out', path.join(scratch, 'nope', 'x.zip')], io: fakeIo() }),
    ).rejects.toThrow('does not exist');
    expect(await readdir(scratch)).toEqual(['there.zip']);
  });

  it('passes the settings file given with --secrets-env to the export, and refuses one it cannot read', async () => {
    const settings = path.join(scratch, 'old.env');
    await writeFile(settings, 'NEBIUS_API_KEY=invented-model-key-0000aaaa1111\n');
    const seen: (string | undefined)[] = [];
    const session = fakeSession({
      exportUser: ({ secretsEnvText }) => {
        seen.push(secretsEnvText);
        return Promise.resolve({ bytesWritten: 0, entries: 0, redactions: 0, personaVaultsLeftOut: 0 });
      },
    });
    await command(session)({
      args: ['--user', 'alice', '--out', path.join(scratch, 'a.zip'), '--secrets-env', settings],
      io: fakeIo(),
    });
    await command(session)({ args: ['--user', 'alice', '--out', path.join(scratch, 'b.zip')], io: fakeIo() });
    expect(seen).toEqual(['NEBIUS_API_KEY=invented-model-key-0000aaaa1111\n', undefined]);

    await expect(
      command(session)({
        args: ['--user', 'alice', '--out', path.join(scratch, 'c.zip'), '--secrets-env', path.join(scratch, 'none')],
        io: fakeIo(),
      }),
    ).rejects.toThrow(/could not be read\. Pass --secrets-env a readable \.env file\./);
    await expect(command(session)({ args: ['--list-users', '--secrets-env', settings], io: fakeIo() })).rejects.toThrow(
      '--list-users takes no other options except --migrate.',
    );
  });

  it('names the user ids that exist when the one asked for owns nothing', async () => {
    await expect(
      command(fakeSession())({ args: ['--user', 'mallory', '--out', path.join(scratch, 'x.zip')], io: fakeIo() }),
    ).rejects.toThrow('--list-users');
    expect(await readdir(scratch)).toEqual([]);
  });

  it('suggests --migrate when the database is from an older version', async () => {
    const session = fakeSession({
      listOwners: () => Promise.reject(new Error('SQLITE_ERROR: no such column: folder_id')),
    });
    await expect(command(session)({ args: ['--list-users'], io: fakeIo() })).rejects.toThrow('--migrate');
  });
});

describe('aman export-data against a real database', () => {
  /** The test environment is standalone (SQLite); narrowing here keeps SQLITE_PATH typed. */
  function standalone() {
    if (!configuration.STANDALONE) {
      throw new Error('This test needs the standalone (SQLite) configuration.');
    }
    return configuration;
  }

  const original = {
    SQLITE_PATH: standalone().SQLITE_PATH,
    MEMORY_MARKDOWN_DIR: configuration.MEMORY_MARKDOWN_DIR,
    PERSONA_KNOWLEDGE_DIR: configuration.PERSONA_KNOWLEDGE_DIR,
  };

  afterEach(() => {
    standalone().SQLITE_PATH = original.SQLITE_PATH;
    configuration.MEMORY_MARKDOWN_DIR = original.MEMORY_MARKDOWN_DIR;
    configuration.PERSONA_KNOWLEDGE_DIR = original.PERSONA_KNOWLEDGE_DIR;
  });

  const real = createExportData({ open: options => openExportDataSession(options) });

  async function database(seed: (db: ReturnType<typeof createSqliteDb>) => Promise<void>): Promise<void> {
    const file = path.join(scratch, 'db.sqlite');
    const db = createSqliteDb(file);
    await migrateSqliteToLatest(db);
    await seed(db);
    await db.destroy();
    standalone().SQLITE_PATH = file;
    configuration.MEMORY_MARKDOWN_DIR = path.join(scratch, 'memory');
    configuration.PERSONA_KNOWLEDGE_DIR = path.join(scratch, 'knowledge');
  }

  async function seedSession(db: ReturnType<typeof createSqliteDb>, user: string, sessionId: string) {
    await new SqliteSessionStore(db).createSession({
      tenant_id: 'default',
      session_id: sessionId,
      created_by_subject: { subject_id: user, subject_type: 'user', subject_display_name: `${user} (display)` },
      agent: {
        type: 'inline',
        spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
      },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
  }

  it('lists the owners with their session counts', async () => {
    await database(async db => {
      await seedSession(db, 'alice', 'a1');
      await seedSession(db, 'alice', 'a2');
      await seedSession(db, 'bob', 'b1');
    });
    const io = fakeIo();
    expect(await real({ args: ['--list-users'], io })).toBe(0);
    const listed = ListSchema.parse(JSON.parse(io.out.join('')));
    expect(listed.users).toEqual([
      { user_id: 'alice', display_name: 'alice (display)', sessions: 2 },
      { user_id: 'bob', display_name: 'bob (display)', sessions: 1 },
      { user_id: 'trueforge-default', display_name: 'trueforge-default', sessions: 0 },
    ]);
    expect(listed.sign_in).toBe('off');
    expect(listed.sign_in_off_user_id).toBe('trueforge-default');
  });

  it('exports the data a no-sign-in instance keeps under its one user id', async () => {
    await database(async db => {
      await seedSession(db, 'trueforge-default', 's1');
      await seedSession(db, 'someone-else', 's2');
      await new SqliteAgentStore(db).createAgent({
        tenant_id: 'default',
        created_by_subject: { subject_id: 'trueforge-default', subject_type: 'user', subject_display_name: 'x' },
        name: 'mine',
        description: 'My agent.',
        manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'Mine.' }),
        external_id: null,
      });
      await new SqlitePersonaStore(db).createPersona({
        tenant_id: 'default',
        created_by: 'trueforge-default',
        id: 'p1',
        display_name: 'Researcher',
        updated_by: 'trueforge-default',
        aliases: [],
        instructions: 'Research.',
        model_name: 'test-provider/test-model',
      });
    });
    await mkdir(path.join(scratch, 'memory', 'default'), { recursive: true });
    await writeFile(path.join(scratch, 'memory', 'default', 'MEMORY.md'), '# Remember\n');

    const out = path.join(scratch, 'out.zip');
    const io = fakeIo();
    expect(await real({ args: ['--user', 'trueforge-default', '--out', out, '--include-instance-data'], io })).toBe(0);
    expect(ResultSchema.parse(JSON.parse(io.out.join(''))).out).toBe(out);

    const { readFile } = await import('node:fs/promises');
    const entries = readZipEntries(await readFile(out));
    const manifest = z
      .object({ tenant_id: z.string(), sections: z.array(z.string()) })
      .parse(zipEntryJson(entries, 'manifest.json'));
    expect(manifest.tenant_id).toBe('default');
    expect(manifest.sections).toContain('agents.json');
    const sessions = z
      .array(z.object({ session: z.object({ session_id: z.string() }) }))
      .parse(legacySessionsOf(entries));
    expect(sessions.map(entry => entry.session.session_id)).toEqual(['s1']);
    expect(zipEntryText(entries, 'agents.json')).toContain('"mine"');
    expect(zipEntryText(entries, 'personas.json')).toContain('Researcher');
    expect(zipEntryText(entries, 'memory/default/MEMORY.md')).toBe('# Remember\n');
    expect(await readdir(scratch)).not.toContainEqual(expect.stringContaining('.partial'));

    // The export is audited in the same table the HTTP route uses, by the actor `cli`.
    const verify = createSqliteDb(path.join(scratch, 'db.sqlite'));
    const rows = await new SentinelAuditStore(verify).list({
      tenant_id: 'default',
      created_by: 'cli',
      conversation_id: '',
      limit: 10,
      offset: 0,
    });
    await verify.destroy();
    expect(rows.map(row => [row.tool_name, row.description])).toEqual([
      [
        'data_export',
        expect.stringMatching(/^Exported data of user trueforge-default from the command line \(\d+ bytes\)\.$/),
      ],
    ]);
  });

  it("keeps another person's memories out: the shared vault by default, and a persona vault that shares a name", async () => {
    const zara = (user: string, id: string) => ({
      tenant_id: 'default',
      created_by: user,
      id,
      display_name: 'Zara',
      updated_by: user,
      aliases: [],
      instructions: 'Help.',
      model_name: 'test-provider/test-model',
    });
    await database(async db => {
      await seedSession(db, 'alice', 'a1');
      await seedSession(db, 'bob', 'b1');
      const personas = new SqlitePersonaStore(db);
      await personas.createPersona(zara('alice', 'p-alice'));
      await personas.createPersona(zara('bob', 'p-bob'));
      await personas.createPersona({ ...zara('alice', 'p-alice-2'), display_name: 'Coach' });
    });
    const vaultDir = (name: string) =>
      path.join(
        scratch,
        'memory',
        sanitizeNamespace(
          vaultWriteNamespace({ tenantNamespace: 'default', scope: { personaName: name, personaId: '' } }),
        ),
      );
    await mkdir(path.join(scratch, 'memory', 'default'), { recursive: true });
    await writeFile(path.join(scratch, 'memory', 'default', 'MEMORY.md'), '# Shared\n\nBob: my locker code is 4471\n');
    await mkdir(vaultDir('Zara'), { recursive: true });
    await writeFile(path.join(vaultDir('Zara'), 'MEMORY.md'), '# Zara\n\nBob told Zara his bank pin\n');
    await mkdir(vaultDir('Coach'), { recursive: true });
    await writeFile(path.join(vaultDir('Coach'), 'MEMORY.md'), '# Coach\n\nAlice runs on Sundays\n');

    const out = path.join(scratch, 'alice.zip');
    const io = fakeIo();
    expect(await real({ args: ['--user', 'alice', '--out', out], io })).toBe(0);
    expect(ResultSchema.parse(JSON.parse(io.out.join('')))).toMatchObject({
      instance_data_included: false,
      persona_memory_left_out: 1,
    });
    const { readFile } = await import('node:fs/promises');
    const archive = await readFile(out);
    expect(archive.includes(Buffer.from('locker code'))).toBe(false);
    expect(archive.includes(Buffer.from('bank pin'))).toBe(false);
    expect(archive.includes(Buffer.from('Alice runs on Sundays'))).toBe(true);
  });

  it("blanks the credentials of the old stack's settings file in memory and chat text", async () => {
    const modelKey = 'invented-model-key-0000aaaa1111';
    const clientSecret = 'invented-client-secret-2222bbbb';
    const model = 'tokenfactory/nvidia/nemotron-3-super-120b-a12b';
    await database(async db => {
      await seedSession(db, 'alice', 'a1');
      await new SqliteSessionStore(db).createTurn(
        makeCreateTurnInput({
          sessionId: 'a1',
          turnId: 'a1-turn-1',
          new_context_appends: [
            {
              thread_id: 'main',
              context: [
                { role: 'user', content: `my key is ${modelKey}` },
                { role: 'assistant', content: 'The daily cap is 20000000 tokens.' },
              ],
              current_context_usage: null,
            },
          ],
        }),
      );
      await new SqliteAgentStore(db).createAgent({
        tenant_id: 'default',
        created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'Alice' },
        name: 'writer',
        description: 'Writes.',
        manifest: AgentSpecSchema.parse({ model: { name: model }, instructions: 'Write.' }),
        external_id: null,
      });
    });
    const settings = path.join(scratch, 'old.env');
    await writeFile(
      settings,
      [
        '# old stack settings',
        `NEBIUS_API_KEY=${modelKey}`,
        `export OIDC_CLIENT_SECRET="${clientSecret}"`,
        'PUBLIC_BASE_URL=http://localhost:8791/a-long-public-address',
        'TOKEN_FACTORY_MODEL=nvidia/nemotron-3-super-120b-a12b',
        'TOKEN_FACTORY_DAILY_TOKEN_CAP=20000000',
      ].join('\n'),
    );
    await mkdir(path.join(scratch, 'memory', 'default'), { recursive: true });
    await writeFile(
      path.join(scratch, 'memory', 'default', 'MEMORY.md'),
      `# Notes\n\nkey ${modelKey} and secret ${clientSecret} at http://localhost:8791/a-long-public-address\n`,
    );

    const out = path.join(scratch, 'alice.zip');
    const io = fakeIo();
    expect(
      await real({ args: ['--user', 'alice', '--out', out, '--include-instance-data', '--secrets-env', settings], io }),
    ).toBe(0);
    const { readFile } = await import('node:fs/promises');
    const entries = readZipEntries(await readFile(out));
    const chats = zipEntryText(entries, 'chats.json');
    expect(chats).toContain('my key is [redacted]');
    expect(chats).toContain('The daily cap is 20000000 tokens.');
    expect(zipEntryText(entries, 'sessions/0001.json')).not.toContain(modelKey);
    expect(zipEntryText(entries, 'agents.json')).toContain(`"${model}"`);
    const memory = zipEntryText(entries, 'memory/default/MEMORY.md');
    expect(memory).not.toContain(modelKey);
    expect(memory).not.toContain(clientSecret);
    expect(memory).toContain('[redacted]');
    expect(memory).toContain('http://localhost:8791/a-long-public-address');
  });

  it('fails with one plain line, and writes nothing, when the database does not exist', async () => {
    standalone().SQLITE_PATH = path.join(scratch, 'missing.sqlite');
    const out = path.join(scratch, 'out.zip');
    const failure = await real({ args: ['--user', 'alice', '--out', out], io: fakeIo() }).catch(
      (error: unknown) => error,
    );
    expect(failure instanceof Error ? failure.message : '').toMatch(/^No SQLite database at [^\n]+$/);
    expect(await readdir(scratch)).toEqual([]);
  });
});

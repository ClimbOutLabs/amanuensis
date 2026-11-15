import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runSecrets } from '../../../../src/cli/secrets';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteModelProviderStore } from '../../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import {
  closePersonaKnowledgeRepository,
  openPersonaKnowledgeRepository,
  usePersonaKnowledgeKeys,
} from '../../../../src/personaKnowledge/sqliteKnowledgeRepository';
import { EncryptedModelProviderStore } from '../../../../src/secrets/encryptedModelProviderStore';
import { FileKeyProvider } from '../../../../src/secrets/fileKeyProvider';
import { KeyRecordFile, keyRecordPath } from '../../../../src/secrets/keyRecordFile';
import { SecretVault } from '../../../../src/secrets/secretVault';
import { fakeIo } from '../../../unit/cli/fakeIo';

// One made-up value per kind of thing a person trusts Aman with.
const CANARIES = {
  chat: 'CANARY-nora-told-aman-about-the-surgery',
  login: 'sk-canary-model-key-51c08e',
  paidKey: 'canary-paid-account-key-0a9b8c7d6e5f',
  note: 'CANARY-pippa-allergy-note',
};

/** Every file under a folder, however deep, with its bytes. */
async function filesUnder(folder: string): Promise<{ file: string; bytes: Buffer }[]> {
  const found: { file: string; bytes: Buffer }[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      found.push({ file, bytes: await readFile(file) });
    }
  }
  return found;
}

/** The forms a value could sit in on disk without being encrypted. */
function formsOf(value: string): Buffer[] {
  const plain = Buffer.from(value, 'utf8');
  return [
    plain,
    Buffer.from(value, 'utf16le'),
    Buffer.from(plain.toString('base64')),
    Buffer.from(plain.toString('hex')),
  ];
}

describe('the data folder of an instance that is set up', () => {
  let dir: string;
  let dataDir: string;
  let keyFile: string;
  let sqlite: string;
  let library: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aman-data-folder-'));
    dataDir = path.join(dir, 'data');
    keyFile = path.join(dir, 'secrets', 'master.key');
    sqlite = path.join(dataDir, 'db', 'db.sqlite');
    library = path.join(dataDir, 'persona-knowledge', 'default', 'mannie.sqlite');
  });

  afterEach(async () => {
    closePersonaKnowledgeRepository({ dbPath: library });
    usePersonaKnowledgeKeys(undefined);
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('holds none of what a person saved in a readable form, even while Aman is running', async () => {
    expect(await runSecrets({ args: ['init', '--sqlite', sqlite, '--key-file', keyFile], io: fakeIo(), env: {} })).toBe(
      0,
    );
    const vault = new SecretVault({
      provider: new FileKeyProvider(keyFile),
      settings: new KeyRecordFile(keyRecordPath(sqlite)),
    });
    expect(await vault.refresh()).toEqual({ status: 'unlocked' });

    expect(
      await runSecrets({
        args: ['env', 'put', '--name', 'NEBIUS_API_KEY', '--sqlite', sqlite, '--key-file', keyFile],
        io: fakeIo({ stdin: CANARIES.paidKey }),
        env: {},
      }),
    ).toBe(0);

    usePersonaKnowledgeKeys({ ...vault.knowledgeKeys(), upgrade: true });
    const repo = openPersonaKnowledgeRepository({ dbPath: library, dimensions: 4 });
    const document = repo.createDocument({
      title: CANARIES.note,
      titleExplicit: true,
      source_kind: 'text',
      source_label: 'Pasted text',
      source_url: null,
    });
    repo.setDocumentChunks({
      documentId: document.id,
      chunks: [{ text: `${CANARIES.note} body`, embedding: new Float32Array([1, 0, 0, 0]) }],
    });

    const db = createSqliteDb(sqlite, { key: vault.databaseKey() });
    try {
      await migrateSqliteToLatest(db);
      // Any row stands for a chat here: the whole database file is encrypted, not single columns.
      await new SqliteGlobalSettingsStore(db).setSetting({ key: 'test_chat_line', value: CANARIES.chat });
      await new EncryptedModelProviderStore({ store: new SqliteModelProviderStore(db), vault }).upsertProvider({
        tenant_id: 'default',
        name: 'openai',
        manifest: {
          type: 'openai',
          base_url: 'https://api.openai.com/v1',
          auth: { api_key: CANARIES.login },
          models: [
            { model_id: 'gpt-test', name: 'gpt-test', properties: { context_length: 1000, max_output_tokens: 100 } },
          ],
        },
      });

      // Looked at with the database and the library still open, so their write-ahead files are checked too.
      const files = await filesUnder(dataDir);
      expect(files.map(found => path.relative(dataDir, found.file))).toEqual(
        expect.arrayContaining([
          path.join('db', 'db.sqlite'),
          path.join('persona-knowledge', 'default', 'mannie.sqlite'),
        ]),
      );
      const leaks: string[] = [];
      for (const [kind, value] of Object.entries(CANARIES)) {
        for (const form of formsOf(value)) {
          for (const found of files) {
            if (found.bytes.includes(form)) {
              leaks.push(`${kind} in ${path.relative(dataDir, found.file)}`);
            }
          }
        }
      }
      expect(leaks).toEqual([]);

      // The same values come back for a holder of this computer's key.
      expect((await new SqliteGlobalSettingsStore(db).getSetting({ key: 'test_chat_line' }))?.value).toBe(
        CANARIES.chat,
      );
      expect(repo.listDocuments().map(listed => listed.title)).toEqual([CANARIES.note]);
    } finally {
      await db.destroy();
    }
  }, 120_000);
});

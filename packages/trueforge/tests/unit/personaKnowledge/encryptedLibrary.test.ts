import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseKeyError } from '../../../src/db/sqlite/client';
import {
  closePersonaKnowledgeRepository,
  openPersonaKnowledgeRepository,
  usePersonaKnowledgeKeys,
} from '../../../src/personaKnowledge/sqliteKnowledgeRepository';

const DIMENSIONS = 4;
const CANARY = 'CANARY-pippa-allergy-note';

let scratch: string;
let dbPath: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'aman-library-key-'));
  dbPath = join(scratch, 'knowledge.sqlite');
});

afterEach(() => {
  closePersonaKnowledgeRepository({ dbPath });
  usePersonaKnowledgeKeys(undefined);
  rmSync(scratch, { recursive: true, force: true });
});

function addNote(): void {
  const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: DIMENSIONS });
  const document = repo.createDocument({
    title: CANARY,
    titleExplicit: true,
    source_kind: 'text',
    source_label: 'Pasted text',
    source_url: null,
  });
  repo.setDocumentChunks({
    documentId: document.id,
    chunks: [{ text: `${CANARY} body`, embedding: new Float32Array([1, 0, 0, 0]) }],
  });
  closePersonaKnowledgeRepository({ dbPath });
}

function titles(): string[] {
  const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: DIMENSIONS });
  try {
    return repo.listDocuments().map(document => document.title);
  } finally {
    closePersonaKnowledgeRepository({ dbPath });
  }
}

function readableOnDisk(): boolean {
  return readdirSync(scratch).some(name => readFileSync(join(scratch, name)).includes(CANARY));
}

describe('an encrypted knowledge library', () => {
  it('holds nothing readable on disk and opens again with the same key', () => {
    usePersonaKnowledgeKeys({ current: randomBytes(32), earlier: [], upgrade: true });
    addNote();
    expect(readableOnDisk()).toBe(false);
    expect(titles()).toEqual([CANARY]);
  });

  it('stays a readable file when this process has no key', () => {
    addNote();
    expect(readableOnDisk()).toBe(true);
  });

  it('encrypts a library from before encryption where it is, and keeps what was in it', () => {
    addNote();
    usePersonaKnowledgeKeys({ current: randomBytes(32), earlier: [], upgrade: true });
    expect(titles()).toEqual([CANARY]);
    expect(readableOnDisk()).toBe(false);
  });

  it('moves a library that came from another computer to this computer key', () => {
    const earlier = randomBytes(32);
    const current = randomBytes(32);
    usePersonaKnowledgeKeys({ current: earlier, earlier: [], upgrade: true });
    addNote();
    usePersonaKnowledgeKeys({ current, earlier: [randomBytes(32), earlier], upgrade: true });
    expect(titles()).toEqual([CANARY]);
    usePersonaKnowledgeKeys({ current, earlier: [], upgrade: true });
    expect(titles()).toEqual([CANARY]);
  });

  it('is read as it is, without being rewritten, by a command that only reads', () => {
    addNote();
    const current = randomBytes(32);
    usePersonaKnowledgeKeys({ current, earlier: [], upgrade: false });
    expect(titles()).toEqual([CANARY]);
    expect(readableOnDisk()).toBe(true);

    const earlier = randomBytes(32);
    usePersonaKnowledgeKeys({ current: earlier, earlier: [], upgrade: true });
    expect(titles()).toEqual([CANARY]);
    usePersonaKnowledgeKeys({ current, earlier: [earlier], upgrade: false });
    expect(titles()).toEqual([CANARY]);
    usePersonaKnowledgeKeys({ current, earlier: [], upgrade: false });
    expect(() => titles()).toThrow(DatabaseKeyError);
  });

  it('refuses a library that no key of this computer opens', () => {
    usePersonaKnowledgeKeys({ current: randomBytes(32), earlier: [], upgrade: true });
    addNote();
    usePersonaKnowledgeKeys({ current: randomBytes(32), earlier: [randomBytes(32)], upgrade: true });
    expect(() => titles()).toThrow(DatabaseKeyError);
  });
});

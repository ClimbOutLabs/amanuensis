/**
 * A help answer end to end at module level: the guide is installed for real, one of her pages is
 * indexed, retrieval builds the block the model would see, and the host's attribution post-pass
 * runs over a model answer that used the page. Her page labels are internal build bookkeeping, so
 * neither the block nor the finished answer may carry a build hash, a Sources line, or any status
 * text about sources. A person's own document in the same library keeps its Sources footer.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EMBEDDING_DIMENSIONS = 384;

function unitVector(): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 1;
  return vector;
}

const mockEmbeddingModel = {
  currentPhase: 'ready',
  failureReason: '',
  ensureReady: async () => true,
  embedQueries: async (texts: string[]) => texts.map(() => unitVector()),
  embedPassages: async (texts: string[]) => texts.map(() => unitVector()),
};

jest.mock('../../../../src/runtime/memory/embeddingModel', () => ({
  EMBEDDING_DIMENSIONS: 384,
  getSharedEmbeddingModel: () => mockEmbeddingModel,
  isEmbeddingModelCached: () => false,
}));

import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqlitePersonaStore } from '../../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import {
  knowledgeCitationMarker,
  repairAssistantMessageContent,
  repairKnowledgeAttribution,
} from '../../../../src/personaKnowledge/knowledgeAttribution';
import { personaKnowledgeLocation } from '../../../../src/personaKnowledge/knowledgePaths';
import { retrievePersonaKnowledge } from '../../../../src/personaKnowledge/knowledgeRetrieval';
import { openPersonaKnowledgeRepository } from '../../../../src/personaKnowledge/sqliteKnowledgeRepository';
import { amanGuidePersonaId } from '../../../../src/personas/amanGuide/identity';
import { amanGuideTopicLabel, ensureAmanGuide } from '../../../../src/personas/amanGuide/install';
import { AMAN_GUIDE_TOPICS } from '../../../../src/personas/amanGuide/knowledgePack.generated';

const TENANT = 'default';
const USER = 'person-a';
const MODEL = 'tokenfactory/guide-model';

/** One sentence from the morning brief page itself, indexed as the page's chunk. */
const BRIEF_SENTENCE = 'Your morning brief is one short list of what needs you today.';
const PERSONAL_SENTENCE = 'The Lisbon apartment costs 2900 euros a month and sits above the bakery on Rua Augusta.';

const logger = { warn: () => undefined };

async function installGuide() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const personaStore = new SqlitePersonaStore(db);
  const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'aman-guide-answer-'));
  await ensureAmanGuide({
    personaStore,
    tenantId: TENANT,
    userId: USER,
    modelName: MODEL,
    knowledgeDir,
    enqueue: jest.fn(),
    logger: { warn: jest.fn() },
  });
  return { knowledgeDir, personaId: amanGuidePersonaId(USER) };
}

function seedChunk(input: { knowledgeDir: string; personaId: string; title: string; text: string }): void {
  const { dbPath } = personaKnowledgeLocation({
    knowledgeDir: input.knowledgeDir,
    tenantId: TENANT,
    personaId: input.personaId,
  });
  const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: EMBEDDING_DIMENSIONS });
  try {
    const document = repo.listDocuments().find(candidate => candidate.title === input.title);
    if (document === undefined) {
      throw new Error(`No document titled ${input.title} in the guide library.`);
    }
    repo.setDocumentChunks({
      documentId: document.id,
      chunks: [{ text: input.text, embedding: Float32Array.from(unitVector()) }],
    });
    repo.updateDocumentStatus({ documentId: document.id, status: 'ready' });
  } finally {
    repo.close();
  }
}

function addPersonalDocument(input: { knowledgeDir: string; personaId: string }): void {
  const { dbPath } = personaKnowledgeLocation({
    knowledgeDir: input.knowledgeDir,
    tenantId: TENANT,
    personaId: input.personaId,
  });
  const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: EMBEDDING_DIMENSIONS });
  try {
    const document = repo.createDocument({
      title: 'My trip notes',
      titleExplicit: true,
      source_kind: 'text',
      source_label: 'Pasted text',
      source_url: null,
    });
    repo.setDocumentChunks({
      documentId: document.id,
      chunks: [{ text: PERSONAL_SENTENCE, embedding: Float32Array.from(unitVector()) }],
    });
    repo.updateDocumentStatus({ documentId: document.id, status: 'ready' });
  } finally {
    repo.close();
  }
}

async function retrieve(input: { knowledgeDir: string; personaId: string }) {
  const result = await retrievePersonaKnowledge({
    tenantId: TENANT,
    personaId: input.personaId,
    question: 'How do I get my morning brief?',
    knowledgeDir: input.knowledgeDir,
    modelDir: path.join(input.knowledgeDir, 'models'),
    logger,
  });
  if (result === undefined || result.block === undefined) {
    throw new Error('Retrieval returned no knowledge block.');
  }
  return result;
}

describe('a help answer drawn from the guide pages', () => {
  it('shows the model no build label and finishes with no Sources line or status text', async () => {
    const guide = await installGuide();
    seedChunk({ ...guide, title: 'Your morning brief', text: BRIEF_SENTENCE });

    const result = await retrieve(guide);
    const topic = AMAN_GUIDE_TOPICS.find(candidate => candidate.title === 'Your morning brief');
    if (topic === undefined) {
      throw new Error('The guide has no morning brief page.');
    }
    // The block the model sees: the page and its facts, never its stored build label, and no
    // announcement that a Sources list will follow.
    expect(result.block).toContain(BRIEF_SENTENCE);
    expect(result.block).toContain('Your morning brief');
    expect(result.block).not.toContain(amanGuideTopicLabel(topic));
    expect(result.block).not.toContain('build');
    expect(result.block).not.toContain('Sources:');

    // A model answer that used the page, marker and all, as the compliant path produces.
    const answer = `Click Chats in the left bar, then New chat, then click the Your morning brief card. ${BRIEF_SENTENCE} ${knowledgeCitationMarker(0)}`;
    const repaired = repairAssistantMessageContent(answer, result.hits);
    if (typeof repaired !== 'string') {
      throw new Error('Expected the repaired content to stay a string.');
    }
    expect(repaired).toContain('click the Your morning brief card');
    expect(repaired).not.toContain('Sources:');
    expect(repaired).not.toContain('build');
    expect(repaired).not.toContain('showing sources');
    expect(repaired).not.toContain('⟦src');
  });

  it('still cites a person document from the same library, and cites only that one', async () => {
    const guide = await installGuide();
    seedChunk({ ...guide, title: 'Your morning brief', text: BRIEF_SENTENCE });
    addPersonalDocument(guide);

    const result = await retrieve(guide);
    expect(result.hits).toHaveLength(2);
    // An answer that used both passages, each with its marker.
    const answer = result.hits.map((hit, index) => `${hit.text} ${knowledgeCitationMarker(index)}`).join(' ');
    const repaired = repairAssistantMessageContent(answer, result.hits);
    if (typeof repaired !== 'string') {
      throw new Error('Expected the repaired content to stay a string.');
    }
    expect(repaired).toContain('Sources:');
    const footer = repaired.slice(repaired.indexOf('Sources:'));
    expect(footer).toContain('My trip notes');
    expect(footer).toContain('Pasted text');
    expect(footer).not.toContain('Your morning brief');
    expect(repaired).not.toContain('build');
  });

  it('keys the repair off the stored label alone: same page, two provenances', () => {
    const topic = AMAN_GUIDE_TOPICS.find(candidate => candidate.title === 'Your morning brief');
    if (topic === undefined) {
      throw new Error('The guide has no morning brief page.');
    }
    const answer = `Here is the page. ${BRIEF_SENTENCE} ${knowledgeCitationMarker(0)}`;
    const guideHit = {
      text: BRIEF_SENTENCE,
      title: 'Your morning brief',
      sourceLabel: amanGuideTopicLabel(topic),
      sourceUrl: null,
      similarity: 1,
    };
    const ownHit = { ...guideHit, sourceLabel: 'Pasted text' };

    const fromGuide = repairKnowledgeAttribution(answer, [guideHit]);
    expect(fromGuide).not.toContain('Sources:');
    expect(fromGuide).not.toContain('build');
    expect(fromGuide).not.toContain('⟦src');

    const fromOwn = repairKnowledgeAttribution(answer, [ownHit]);
    expect(fromOwn).toContain('Sources: Your morning brief (Pasted text)');
  });
});

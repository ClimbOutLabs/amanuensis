import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AMAN_GUIDE_NAME } from '@truefoundry/trueforge-core/core/personas/guide';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqlitePersonaStore } from '../../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { personaKnowledgeLocation } from '../../../../src/personaKnowledge/knowledgePaths';
import { openPersonaKnowledgeRepository } from '../../../../src/personaKnowledge/sqliteKnowledgeRepository';
import { amanGuidePersonaId } from '../../../../src/personas/amanGuide/identity';
import {
  AMAN_GUIDE_INSTRUCTIONS,
  amanGuideTopicLabel,
  ensureAmanGuide,
} from '../../../../src/personas/amanGuide/install';
import { AMAN_GUIDE_TOPICS } from '../../../../src/personas/amanGuide/knowledgePack.generated';
import { EMBEDDING_DIMENSIONS } from '../../../../src/runtime/memory/embeddingModel';

const TENANT = 'default';
const USER = 'person-a';
const MODEL = 'tokenfactory/guide-model';

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const personaStore = new SqlitePersonaStore(db);
  const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'aman-guide-install-'));
  const enqueue = jest.fn();
  const logger = { warn: jest.fn() };
  const install = (input: { userId?: string; modelName?: string } = {}) =>
    ensureAmanGuide({
      personaStore,
      tenantId: TENANT,
      userId: input.userId ?? USER,
      modelName: input.modelName ?? MODEL,
      knowledgeDir,
      enqueue,
      logger,
    });
  return { personaStore, knowledgeDir, enqueue, logger, install };
}

function guideDocumentTitles(knowledgeDir: string): string[] {
  const repo = openPersonaKnowledgeRepository({
    dbPath: personaKnowledgeLocation({ knowledgeDir, tenantId: TENANT, personaId: amanGuidePersonaId(USER) }).dbPath,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  try {
    return repo
      .listDocuments()
      .filter(document => document.source_label.startsWith('Iris, build '))
      .map(document => document.title)
      .sort();
  } finally {
    repo.close();
  }
}

describe('ensureAmanGuide', () => {
  it('installs the guide with its name, instructions and model, and indexes every topic', async () => {
    const { personaStore, knowledgeDir, enqueue, install } = await setup();

    await install();

    const persona = await personaStore.getPersona({
      tenant_id: TENANT,
      created_by: USER,
      id: amanGuidePersonaId(USER),
    });
    expect(persona).toMatchObject({
      id: amanGuidePersonaId(USER),
      display_name: AMAN_GUIDE_NAME,
      instructions: AMAN_GUIDE_INSTRUCTIONS,
      model_name: MODEL,
      aliases: [],
    });
    expect(guideDocumentTitles(knowledgeDir)).toEqual(AMAN_GUIDE_TOPICS.map(topic => topic.title).sort());
    expect(enqueue).toHaveBeenCalledTimes(AMAN_GUIDE_TOPICS.length);
  });

  it('does nothing new when run again on the same build', async () => {
    const { personaStore, knowledgeDir, enqueue, install } = await setup();
    await install();
    enqueue.mockClear();

    await install();

    expect(enqueue).not.toHaveBeenCalled();
    expect(guideDocumentTitles(knowledgeDir)).toHaveLength(AMAN_GUIDE_TOPICS.length);
    expect(await personaStore.listPersonas({ tenant_id: TENANT, created_by: USER })).toHaveLength(1);
  });

  it('on upgrade removes a page from an older build, keeps a person document, and keeps the persona id', async () => {
    const { personaStore, knowledgeDir, enqueue, install } = await setup();
    await install();
    const repo = openPersonaKnowledgeRepository({
      dbPath: personaKnowledgeLocation({ knowledgeDir, tenantId: TENANT, personaId: amanGuidePersonaId(USER) }).dbPath,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    try {
      repo.createDocument({
        title: 'Old guide page',
        titleExplicit: true,
        source_kind: 'text',
        source_label: 'Iris, build 0000000000000000',
        source_url: null,
      });
      repo.createDocument({
        title: 'My notes',
        titleExplicit: true,
        source_kind: 'text',
        source_label: 'Pasted text',
        source_url: null,
      });
    } finally {
      repo.close();
    }
    enqueue.mockClear();

    await install({ modelName: 'tokenfactory/other-model' });

    const titles = guideDocumentTitles(knowledgeDir);
    expect(titles).not.toContain('Old guide page');
    expect(titles).toHaveLength(AMAN_GUIDE_TOPICS.length);
    // Every current page is already in the library, so nothing is indexed again.
    expect(enqueue).not.toHaveBeenCalled();
    const persona = await personaStore.getPersona({
      tenant_id: TENANT,
      created_by: USER,
      id: amanGuidePersonaId(USER),
    });
    expect(persona?.model_name).toBe(MODEL);
    const repoAfter = openPersonaKnowledgeRepository({
      dbPath: personaKnowledgeLocation({ knowledgeDir, tenantId: TENANT, personaId: amanGuidePersonaId(USER) }).dbPath,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    try {
      expect(repoAfter.listDocuments().map(document => document.title)).toContain('My notes');
    } finally {
      repoAfter.close();
    }
  });

  it('on upgrade re-indexes only the page that changed and keeps the rest as they are', async () => {
    const { knowledgeDir, enqueue, install } = await setup();
    await install();
    const dbPath = personaKnowledgeLocation({
      knowledgeDir,
      tenantId: TENANT,
      personaId: amanGuidePersonaId(USER),
    }).dbPath;
    const changed = AMAN_GUIDE_TOPICS[0];
    if (changed === undefined) {
      throw new Error('The guide has no pages.');
    }
    // The library as an older build left it: the first page holds the older text, every other page is current.
    const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: EMBEDDING_DIMENSIONS });
    let keptIds: string[];
    try {
      const current = repo.listDocuments().find(document => document.source_label === amanGuideTopicLabel(changed));
      if (current === undefined) {
        throw new Error('The first page was not installed.');
      }
      repo.deleteDocument({ documentId: current.id });
      repo.createDocument({
        title: changed.title,
        titleExplicit: true,
        source_kind: 'text',
        source_label: amanGuideTopicLabel({ title: changed.title, body: `${changed.body}\n\nAn older sentence.` }),
        source_url: null,
      });
      keptIds = repo
        .listDocuments()
        .filter(
          document =>
            document.source_label !==
            amanGuideTopicLabel({ title: changed.title, body: `${changed.body}\n\nAn older sentence.` }),
        )
        .map(document => document.id)
        .sort();
    } finally {
      repo.close();
    }
    enqueue.mockClear();

    await install();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const after = openPersonaKnowledgeRepository({ dbPath, dimensions: EMBEDDING_DIMENSIONS });
    try {
      const documents = after.listDocuments();
      expect(documents).toHaveLength(AMAN_GUIDE_TOPICS.length);
      const replaced = documents.find(document => document.source_label === amanGuideTopicLabel(changed));
      expect(enqueue).toHaveBeenCalledWith({
        tenantId: TENANT,
        personaId: amanGuidePersonaId(USER),
        documentId: replaced?.id,
      });
      expect(
        documents
          .filter(document => document.id !== replaced?.id)
          .map(document => document.id)
          .sort(),
      ).toEqual(keptIds);
    } finally {
      after.close();
    }
  });

  it('does not re-index her knowledge when only her instructions change', async () => {
    const { personaStore, enqueue, install } = await setup();
    await install();
    await personaStore.updatePersona({
      tenant_id: TENANT,
      created_by: USER,
      updated_by: USER,
      id: amanGuidePersonaId(USER),
      display_name: AMAN_GUIDE_NAME,
      aliases: [],
      instructions: 'Instructions from an older build.',
      model_name: MODEL,
    });
    enqueue.mockClear();

    await install();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('installs a separate guide for each person', async () => {
    const { personaStore, install } = await setup();

    await install({ userId: 'person-a' });
    await install({ userId: 'person-b' });

    expect(await personaStore.listPersonas({ tenant_id: TENANT, created_by: 'person-a' })).toHaveLength(1);
    expect(await personaStore.listPersonas({ tenant_id: TENANT, created_by: 'person-b' })).toHaveLength(1);
  });

  it('on upgrade refreshes her instructions but keeps the name, model and aliases the person set', async () => {
    const { personaStore, install } = await setup();
    await install();
    await personaStore.updatePersona({
      tenant_id: TENANT,
      created_by: USER,
      updated_by: USER,
      id: amanGuidePersonaId(USER),
      display_name: 'Guide for me',
      aliases: ['helper'],
      instructions: 'Old instructions.',
      model_name: 'tokenfactory/my-own-model',
    });

    await install({ modelName: MODEL });

    expect(
      await personaStore.getPersona({ tenant_id: TENANT, created_by: USER, id: amanGuidePersonaId(USER) }),
    ).toMatchObject({
      display_name: 'Guide for me',
      aliases: ['helper'],
      instructions: AMAN_GUIDE_INSTRUCTIONS,
      model_name: 'tokenfactory/my-own-model',
    });
  });

  it('leaves a persona the person already named "Iris" alone and says so', async () => {
    const { personaStore, logger, install } = await setup();
    await personaStore.createPersona({
      tenant_id: TENANT,
      created_by: USER,
      updated_by: USER,
      id: 'my-own-guide',
      display_name: AMAN_GUIDE_NAME,
      aliases: [],
      instructions: 'Mine.',
      model_name: MODEL,
    });

    await install();

    expect(await personaStore.getPersona({ tenant_id: TENANT, created_by: USER, id: amanGuidePersonaId(USER) })).toBe(
      undefined,
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('already in use'));
  });
});

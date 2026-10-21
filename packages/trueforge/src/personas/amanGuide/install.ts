import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { PersonaNameConflictError, type IPersonaStore } from '../../db/personaStore';
import { blobPath, writeKnowledgeBlob } from '../../personaKnowledge/knowledgeIndexer';
import { ensurePersonaKnowledgeRoot, personaKnowledgeLocation } from '../../personaKnowledge/knowledgePaths';
import { openPersonaKnowledgeRepository } from '../../personaKnowledge/sqliteKnowledgeRepository';
import { EMBEDDING_DIMENSIONS } from '../../runtime/memory/embeddingModel';
import { IRIS_NAME, amanGuidePersonaId } from './identity';
import { AMAN_GUIDE_TOPICS } from './knowledgePack.generated';

export const AMAN_GUIDE_INSTRUCTIONS = [
  `You are ${IRIS_NAME}, the guide to Aman. You explain Aman to the person and help them get started.`,
  'Answer questions about Aman only from the Aman knowledge in this chat. Keep answers short and friendly, in plain words, one idea per sentence.',
  'When a Tour card, setting or connector would help, name it and say where to find it, such as "Settings, then Connectors".',
  'If the answer is not in your knowledge, say so plainly. Do not guess.',
  'Never claim a feature that is not in your knowledge.',
  'You cannot change anything. You cannot send email, change the calendar, make a schedule or change settings. If asked, say so and point to where the person can do it themselves.',
].join('\n');

/** Marks the knowledge documents this module wrote, so a refresh replaces only them and never a person's own upload. */
const GUIDE_SOURCE_PREFIX = `${IRIS_NAME}, build `;

interface GuideKnowledgeInput {
  knowledgeDir: string;
  tenantId: string;
  personaId: string;
  enqueue: (input: { tenantId: string; personaId: string; documentId: string }) => void;
}

/** Hash of the knowledge pack and the instructions, so any change to either shows up as a new build. */
export function amanGuideBuildId(): string {
  return createHash('sha256')
    .update(JSON.stringify([AMAN_GUIDE_INSTRUCTIONS, AMAN_GUIDE_TOPICS]))
    .digest('hex')
    .slice(0, 16);
}

function renderTopic(topic: { title: string; body: string }): string {
  return `# ${topic.title}\n\n${topic.body}\n`;
}

/**
 * Replaces the guide's knowledge when the build changed. Documents from an
 * older build are removed and the current pack is indexed again; a person's
 * own documents are never touched.
 */
async function refreshGuideKnowledge(input: GuideKnowledgeInput): Promise<void> {
  const { knowledgeDir, tenantId, personaId, enqueue } = input;
  const buildLabel = `${GUIDE_SOURCE_PREFIX}${amanGuideBuildId()}`;
  await ensurePersonaKnowledgeRoot({ knowledgeDir, tenantId });
  const repo = openPersonaKnowledgeRepository({
    dbPath: personaKnowledgeLocation({ knowledgeDir, tenantId, personaId }).dbPath,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  try {
    const guideDocuments = repo
      .listDocuments()
      .filter(document => document.source_label.startsWith(GUIDE_SOURCE_PREFIX));
    const current =
      guideDocuments.length === AMAN_GUIDE_TOPICS.length &&
      guideDocuments.every(document => document.source_label === buildLabel);
    if (current) {
      return;
    }
    for (const document of guideDocuments) {
      repo.deleteDocument({ documentId: document.id });
      await rm(blobPath({ knowledgeDir, tenantId, personaId, documentId: document.id }), { force: true });
    }
    for (const topic of AMAN_GUIDE_TOPICS) {
      const document = repo.createDocument({
        title: topic.title,
        titleExplicit: true,
        source_kind: 'text',
        source_label: buildLabel,
        source_url: null,
      });
      await writeKnowledgeBlob({
        knowledgeDir,
        tenantId,
        personaId,
        documentId: document.id,
        bytes: new TextEncoder().encode(renderTopic(topic)),
      });
      enqueue({ tenantId, personaId, documentId: document.id });
    }
  } finally {
    repo.close();
  }
}

/**
 * Installs the Aman guide for one person, or brings it up to date. Creates the
 * persona on first sight and keeps its id, so existing chats stay attached.
 * A name clash with a persona the person already made leaves that persona alone.
 */
export async function ensureAmanGuide(input: {
  personaStore: IPersonaStore;
  tenantId: string;
  userId: string;
  modelName: string;
  knowledgeDir: string;
  enqueue: GuideKnowledgeInput['enqueue'];
  logger: { warn(message: string): void };
}): Promise<void> {
  const { personaStore, tenantId, userId, modelName, knowledgeDir, enqueue, logger } = input;
  const personaId = amanGuidePersonaId(userId);
  const key = { tenant_id: tenantId, created_by: userId, id: personaId };
  try {
    const existing = await personaStore.getPersona(key);
    if (existing === undefined) {
      await personaStore.createPersona({
        ...key,
        updated_by: userId,
        display_name: IRIS_NAME,
        aliases: [],
        instructions: AMAN_GUIDE_INSTRUCTIONS,
        model_name: modelName,
      });
    } else if (
      existing.display_name !== IRIS_NAME ||
      existing.instructions !== AMAN_GUIDE_INSTRUCTIONS ||
      existing.model_name !== modelName
    ) {
      await personaStore.updatePersona({
        ...key,
        updated_by: userId,
        display_name: IRIS_NAME,
        aliases: existing.aliases,
        instructions: AMAN_GUIDE_INSTRUCTIONS,
        model_name: modelName,
      });
    }
  } catch (error) {
    if (error instanceof PersonaNameConflictError) {
      logger.warn(`${IRIS_NAME} was not installed: the name "${IRIS_NAME}" is already in use.`);
      return;
    }
    throw error;
  }
  await refreshGuideKnowledge({ knowledgeDir, tenantId, personaId, enqueue });
}

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureWritableDataDir } from '../utils/dataDir';

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface PersonaKnowledgeLocation {
  /** Absolute path of the persona's dedicated SQLite database file. */
  dbPath: string;
}

/**
 * Maps a (tenant, persona) pair to its dedicated knowledge database file.
 *
 * Each persona gets its own SQLite file so knowledge can never leak across
 * personas through a shared connection: isolation is enforced by the
 * filesystem layout, not just by WHERE clauses. Segments are allowlisted to
 * block path traversal; anything outside the pattern throws.
 */
export function personaKnowledgeLocation(input: {
  knowledgeDir: string;
  tenantId: string;
  personaId: string;
}): PersonaKnowledgeLocation {
  const { knowledgeDir, tenantId, personaId } = input;
  for (const [label, segment] of [
    ['tenantId', tenantId],
    ['personaId', personaId],
  ] as const) {
    if (!SAFE_SEGMENT_PATTERN.test(segment)) {
      throw new Error(`Refusing to resolve a knowledge path for an unsafe ${label}.`);
    }
  }
  return { dbPath: path.resolve(knowledgeDir, tenantId, `${personaId}.sqlite`) };
}

/** Creates the knowledge root (and tenant directory) if missing. Idempotent. */
export async function ensurePersonaKnowledgeRoot(input: {
  knowledgeDir: string;
  tenantId: string;
}): Promise<void> {
  if (!SAFE_SEGMENT_PATTERN.test(input.tenantId)) {
    throw new Error('Refusing to create a knowledge directory for an unsafe tenantId.');
  }
  // Names PERSONA_KNOWLEDGE_DIR in the error instead of surfacing a bare EACCES.
  const root = await ensureWritableDataDir({
    dir: input.knowledgeDir,
    envVar: 'PERSONA_KNOWLEDGE_DIR',
  });
  await mkdir(path.join(root, input.tenantId), { recursive: true });
}

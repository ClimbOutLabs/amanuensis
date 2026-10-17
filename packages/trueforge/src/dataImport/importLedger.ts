import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import { rm } from 'node:fs/promises';
import { z } from 'zod';

import type { IAgentStore } from '../db/agentStore';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { removeKnowledgeFiles } from './knowledgeImport';

/**
 * What an import writes outside the database transaction, by id or path.
 * Compensation deletes only entries named here, and every entry was checked
 * not to exist before the import began, so it can never remove anything the
 * import did not create.
 */
const ImportLedgerSchema = z.object({
  agent_ids: z.array(z.string()),
  folder_ids: z.array(z.string()),
  session_ids: z.array(z.string()),
  knowledge_db_paths: z.array(z.string()),
  memory_files: z.array(z.string()),
});
export type ImportLedger = z.infer<typeof ImportLedgerSchema>;

export function emptyLedger(): ImportLedger {
  return { agent_ids: [], folder_ids: [], session_ids: [], knowledge_db_paths: [], memory_files: [] };
}

/** Global-setting key of the crash marker; present only while an import is writing. */
export const IMPORT_IN_PROGRESS_KEY = 'data_import_in_progress';

const ImportMarkerSchema = z.object({
  started_at: z.string(),
  tenant_id: z.string(),
  subject_id: z.string(),
  /** Everything the run plans to create: a superset of what it has created so far. */
  planned: ImportLedgerSchema,
});
export type ImportMarker = z.infer<typeof ImportMarkerSchema>;

export class UnreadableImportMarkerError extends Error {
  constructor(options?: ErrorOptions) {
    super(`The record of an interrupted import (setting ${IMPORT_IN_PROGRESS_KEY}) is unreadable.`, options);
    this.name = 'UnreadableImportMarkerError';
  }
}

export async function writeImportMarker<TTransaction>(
  store: IGlobalSettingsStore<TTransaction>,
  marker: ImportMarker,
): Promise<void> {
  await store.setSetting({ key: IMPORT_IN_PROGRESS_KEY, value: JSON.stringify(marker) });
}

/** Removes the marker; pass the commit transaction so the marker disappears with the data it guards. */
export async function clearImportMarker<TTransaction>(
  store: IGlobalSettingsStore<TTransaction>,
  transaction?: TTransaction,
): Promise<void> {
  await store.deleteSetting({ key: IMPORT_IN_PROGRESS_KEY }, transaction);
}

export async function readImportMarker<TTransaction>(
  store: IGlobalSettingsStore<TTransaction>,
): Promise<ImportMarker | undefined> {
  const record = await store.getSetting({ key: IMPORT_IN_PROGRESS_KEY });
  if (record === undefined) {
    return undefined;
  }
  try {
    return ImportMarkerSchema.parse(JSON.parse(record.value));
  } catch (cause) {
    throw new UnreadableImportMarkerError({ cause });
  }
}

export interface CompensationDeps<TTransaction> {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  agentStore: IAgentStore<TTransaction>;
}

/**
 * Undoes the ledger's entries. Each step is idempotent and isolated, so one
 * stuck item does not block the rest. Returns what could not be removed.
 */
export async function compensate<TTransaction>(
  deps: CompensationDeps<TTransaction>,
  input: { tenantId: string; subjectId: string; ledger: ImportLedger },
): Promise<string[]> {
  const { tenantId, subjectId, ledger } = input;
  const failures: string[] = [];
  const attempt = async (what: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch {
      failures.push(what);
    }
  };
  for (const sessionId of ledger.session_ids) {
    await attempt(`chat ${sessionId}`, () =>
      deps.sessionStore.deleteSession({ tenant_id: tenantId, session_id: sessionId }),
    );
  }
  for (const folderId of ledger.folder_ids) {
    await attempt(`folder ${folderId}`, () =>
      deps.sessionStore.deleteSessionFolder({ tenant_id: tenantId, folder_id: folderId, created_by: subjectId }),
    );
  }
  for (const dbPath of ledger.knowledge_db_paths) {
    await attempt(`knowledge file ${dbPath}`, () => removeKnowledgeFiles(dbPath));
  }
  for (const filePath of ledger.memory_files) {
    await attempt(`memory file ${filePath}`, () => rm(filePath, { force: true }));
  }
  for (const agentId of ledger.agent_ids) {
    await attempt(`agent ${agentId}`, () => deps.agentStore.deleteAgent({ tenant_id: tenantId, id: agentId }));
  }
  return failures;
}

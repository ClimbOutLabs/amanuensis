import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import { rm, stat } from 'node:fs/promises';
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

/** Global-setting key of the import marker; present only while an import holds the instance or left work behind. */
export const IMPORT_IN_PROGRESS_KEY = 'data_import_in_progress';

/** How often a running import renews its marker. */
export const IMPORT_HEARTBEAT_MS = 5_000;
/** A marker not renewed for this long belongs to a run that is no longer alive. */
export const IMPORT_STALE_MS = 60_000;

const ImportMarkerSchema = z.object({
  started_at: z.string(),
  /** Renewed while the run is alive. */
  heartbeat_at: z.string(),
  /** Set when the run ended without removing everything it wrote. */
  stopped_at: z.string().optional(),
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

/** Another run replaced this run's marker, so this run must stop writing. */
export class ImportLockLostError extends Error {
  constructor() {
    super('Another import took over this instance.');
    this.name = 'ImportLockLostError';
  }
}

export function newImportMarker(input: { tenantId: string; subjectId: string }): ImportMarker {
  const now = new Date().toISOString();
  return {
    started_at: now,
    heartbeat_at: now,
    tenant_id: input.tenantId,
    subject_id: input.subjectId,
    planned: emptyLedger(),
  };
}

/** The marker and its stored text, which a takeover must match exactly. */
export async function readImportMarker<TTransaction>(
  store: IGlobalSettingsStore<TTransaction>,
): Promise<{ marker: ImportMarker; raw: string } | undefined> {
  const record = await store.getSetting({ key: IMPORT_IN_PROGRESS_KEY });
  if (record === undefined) {
    return undefined;
  }
  try {
    return { marker: ImportMarkerSchema.parse(JSON.parse(record.value)), raw: record.value };
  } catch (cause) {
    throw new UnreadableImportMarkerError({ cause });
  }
}

/** Whether the run that wrote the marker may still be writing. */
export function isLiveImportMarker(marker: ImportMarker, now: number): boolean {
  return marker.stopped_at === undefined && now - Date.parse(marker.heartbeat_at) < IMPORT_STALE_MS;
}

/**
 * Every write the marker's run made happened before this instant; anything
 * later was made by someone else. A crashed run wrote for at most one
 * renewal period after its last renewal, so the cutoff allows two.
 */
export function importMarkerCutoff(marker: ImportMarker): number {
  return marker.stopped_at === undefined
    ? Date.parse(marker.heartbeat_at) + 2 * IMPORT_HEARTBEAT_MS
    : Date.parse(marker.stopped_at);
}

/**
 * The marker doubles as the instance-wide import lock: it is taken with an
 * insert-if-absent write, renewed while the run is alive, and every later
 * write replaces exactly the text this run last stored, so two processes can
 * never both hold it.
 */
export class ImportLock<TTransaction> {
  readonly #store: IGlobalSettingsStore<TTransaction>;
  #marker: ImportMarker;
  #raw: string;
  #held = true;
  #keepForCleanup = false;
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;

  private constructor(input: { store: IGlobalSettingsStore<TTransaction>; marker: ImportMarker; raw: string }) {
    this.#store = input.store;
    this.#marker = input.marker;
    this.#raw = input.raw;
    this.resumeRenewal();
  }

  /** Takes the marker when no run holds one (`replacing` null), or replaces exactly the marker text read before. */
  static async claim<TTransaction>(
    store: IGlobalSettingsStore<TTransaction>,
    input: { marker: ImportMarker; replacing: string | null },
  ): Promise<ImportLock<TTransaction> | undefined> {
    const raw = JSON.stringify(input.marker);
    const won = await store.compareAndSetSetting({
      key: IMPORT_IN_PROGRESS_KEY,
      expected: input.replacing,
      value: raw,
    });
    return won ? new ImportLock({ store, marker: input.marker, raw }) : undefined;
  }

  /** Replaces the marker's contents, keeping the lock. */
  async replace(marker: ImportMarker): Promise<void> {
    await this.#serialize(() => this.#write({ ...marker, heartbeat_at: new Date().toISOString() }));
  }

  /**
   * Stops renewing and waits for a renewal already under way. Call it before
   * opening the commit transaction: on SQLite a renewal queued behind that
   * transaction would wait for it forever.
   */
  async pauseRenewal(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#queue;
  }

  /** Renews the marker again, as after a commit transaction that failed. */
  resumeRenewal(): void {
    if (!this.#held || this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.#serialize(() => this.#write({ ...this.#marker, heartbeat_at: new Date().toISOString() })).catch(
        () => undefined,
      );
    }, IMPORT_HEARTBEAT_MS);
    this.#timer.unref();
  }

  /** Removes the marker inside the commit transaction, so it disappears with the data it guards. */
  async removeIn(transaction: TTransaction): Promise<void> {
    if (this.#timer !== undefined) {
      throw new Error('The import marker is still being renewed; pause renewal before the commit transaction.');
    }
    const removed = await this.#store.compareAndSetSetting(
      { key: IMPORT_IN_PROGRESS_KEY, expected: this.#raw, value: null },
      transaction,
    );
    if (!removed) {
      throw new ImportLockLostError();
    }
  }

  /** Called once the transaction that removed the marker has committed. */
  committed(): void {
    this.#held = false;
  }

  /** Leaves the marker behind, marked stopped, so the next run cleans up what this one could not. */
  keepForCleanup(): void {
    this.#keepForCleanup = true;
  }

  /** Ends the hold: the marker goes, unless the run left work behind. */
  async end(): Promise<void> {
    await this.pauseRenewal();
    if (!this.#held) {
      return;
    }
    this.#held = false;
    const next = this.#keepForCleanup
      ? JSON.stringify({ ...this.#marker, stopped_at: new Date().toISOString() })
      : null;
    await this.#store.compareAndSetSetting({ key: IMPORT_IN_PROGRESS_KEY, expected: this.#raw, value: next });
  }

  #serialize(write: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(write);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #write(marker: ImportMarker): Promise<void> {
    if (!this.#held) {
      throw new ImportLockLostError();
    }
    const raw = JSON.stringify(marker);
    const written = await this.#store.compareAndSetSetting({
      key: IMPORT_IN_PROGRESS_KEY,
      expected: this.#raw,
      value: raw,
    });
    if (!written) {
      this.#held = false;
      clearInterval(this.#timer);
      this.#timer = undefined;
      throw new ImportLockLostError();
    }
    this.#marker = marker;
    this.#raw = raw;
  }
}

/**
 * What of the ledger was changed after `cutoff`, by a person using the instance
 * after the run that planned it stopped. Missing items count as unchanged.
 */
export async function findChangedSince<TTransaction>(
  deps: CompensationDeps<TTransaction>,
  input: { tenantId: string; subjectId: string; ledger: ImportLedger; cutoff: number },
): Promise<string[]> {
  const { tenantId, subjectId, ledger, cutoff } = input;
  const changed: string[] = [];
  for (const sessionId of ledger.session_ids) {
    const session = await deps.sessionStore.getSession({ tenant_id: tenantId, session_id: sessionId });
    if (
      session !== undefined &&
      (session.updated_at.getTime() > cutoff || session.last_activity_timestamp_ms > cutoff)
    ) {
      changed.push(`chat ${sessionId}`);
    }
  }
  for (const folderId of ledger.folder_ids) {
    const folder = await deps.sessionStore.getSessionFolder({
      tenant_id: tenantId,
      folder_id: folderId,
      created_by: subjectId,
    });
    if (folder !== undefined && folder.updated_at.getTime() > cutoff) {
      changed.push(`folder ${folderId}`);
    }
  }
  for (const agentId of ledger.agent_ids) {
    const agent = await deps.agentStore.getAgent({ tenant_id: tenantId, id: agentId });
    if (agent !== undefined && Date.parse(agent.updated_at) > cutoff) {
      changed.push(`agent ${agentId}`);
    }
  }
  for (const filePath of [...ledger.memory_files, ...ledger.knowledge_db_paths]) {
    const info = await stat(filePath).catch(() => undefined);
    if (info !== undefined && info.mtimeMs > cutoff) {
      changed.push(`file ${filePath}`);
    }
  }
  return changed;
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

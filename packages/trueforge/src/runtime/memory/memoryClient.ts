/**
 * Backend-agnostic interface for the long-term memory provider Aman speaks to each turn.
 *
 * `HindsightClient` (REST API over a Hindsight bank) and `MarkdownMemoryClient` (local
 * Markdown files, OpenClaw-style) both implement this. Callers must depend on this
 * interface, never on a concrete client, so the backend selected by `MEMORY_BACKEND`
 * is a drop-in replacement.
 *
 * The contract mirrors `HindsightClient`'s: every method returns a discriminated `{ ok }`
 * result and never throws, so a memory failure degrades a turn instead of failing it.
 */
import type {
  GetOperationOutcome,
  GetProfileOutcome,
  ListMentalModelsOutcome,
  RecallOutcome,
  ReflectBudget,
  ReflectOutcome,
  RetainItem,
  RetainOutcome,
  RetryOperationOutcome,
} from './hindsightClient';

export interface MemoryClient {
  recall(params: {
    query: string;
    maxTokens: number;
    queryTimestamp: string;
    entityTokens: number;
    timeoutMs: number;
    /** The chat being answered: notes retained from it are never returned (its history is already in the conversation). */
    currentSessionId?: string | undefined;
  }): Promise<RecallOutcome>;

  retain(params: { items: RetainItem[]; operationId: string; timeoutMs: number }): Promise<RetainOutcome>;

  getOperation(id: string, timeoutMs: number): Promise<GetOperationOutcome>;

  retryOperation(id: string, timeoutMs: number): Promise<RetryOperationOutcome>;

  getProfile(timeoutMs: number): Promise<GetProfileOutcome>;

  listMentalModels(params: { limit: number; timeoutMs: number }): Promise<ListMentalModelsOutcome>;

  reflect(params: {
    query: string;
    budget: ReflectBudget;
    maxTokens: number;
    timeoutMs: number;
  }): Promise<ReflectOutcome>;

  /**
   * Memory vault: the effective entries of one vault namespace, newest first.
   * `namespace` is the wire namespace: empty or `default` for the shared vault,
   * `persona:<name>` for a persona vault, else a topic vault. Implementations
   * resolve it tenant-scoped, so one tenant's vault never addresses another's.
   * Vault edits and deletes are applied; deleted entries are omitted.
   */
  listEntries(params: { namespace: string; timeoutMs: number }): Promise<ListMemoryVaultEntriesOutcome>;

  /**
   * Memory vault: replace one entry's text. The store stays append-only: the old
   * entry is kept and a supersede marker records the new text. Unknown or deleted
   * ids fail with code `not_found`.
   */
  updateEntry(params: { entryId: string; text: string; timeoutMs: number }): Promise<UpdateMemoryVaultEntryOutcome>;

  /**
   * Memory vault: hide one entry. The store stays append-only: the old entry is
   * kept and a delete marker drops it from listings and recall. Idempotent:
   * deleting an already-deleted id succeeds.
   */
  deleteEntry(params: { entryId: string; timeoutMs: number }): Promise<DeleteMemoryVaultEntryOutcome>;

  /**
   * Optional: note the outcome of one turn-summary attempt for this client's vault, so a
   * failed summary stays visible on the Memories page until a later summary succeeds.
   * Only the markdown client implements it, matching the markdown-only gate on turn
   * summarization itself. Never throws.
   */
  noteSummaryOutcome?(params: SummaryOutcomeNote): Promise<void>;
}

/** One turn-summary attempt's outcome, noted on the client that owns the turn's vault. */
export interface SummaryOutcomeNote {
  outcome: 'summarized' | 'failed';
  /** The log's reason code when the attempt failed; omitted when a summary was made. */
  reason?: string | undefined;
}

/** One memory fact as the vault presents it. */
export interface MemoryVaultEntry {
  /** Stable id `md:{namespace}:{file}#{index}`; URL-encode for path params. */
  id: string;
  /** Replacement text after a vault edit, else the original retained text. */
  text: string;
  /** ISO-8601 instant: the edit time after a vault edit, else the retain time. */
  timestamp: string;
  /** Owning persona for `persona:<name>` vaults, else null. */
  persona: string | null;
}

export type MemoryVaultFailureCode = 'request_failed' | 'not_found' | 'timeout';

export interface MemoryVaultFailure {
  ok: false;
  code: MemoryVaultFailureCode;
  reason: string;
}

export type ListMemoryVaultEntriesOutcome = { ok: true; entries: MemoryVaultEntry[] } | MemoryVaultFailure;

export type UpdateMemoryVaultEntryOutcome = { ok: true; entry: MemoryVaultEntry } | MemoryVaultFailure;

export type DeleteMemoryVaultEntryOutcome = { ok: true } | MemoryVaultFailure;

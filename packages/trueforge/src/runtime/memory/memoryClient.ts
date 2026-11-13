/**
 * The long-term memory store Aman speaks to each turn, and the shapes its calls hand back.
 *
 * Every method returns a discriminated `{ ok }` result and never throws, so a memory failure
 * degrades a turn instead of failing it.
 */
import type { MeaningGate } from './meaningGate';
import type { RetainMetadata } from './memoryOrigin';
import type { LoadedPage, PageLoadStats } from './memoryPageLoader';
import type { PageListing } from './memoryPages';

export interface RecallItem {
  id: string;
  text: string;
  entities?: string[];
  occurred_start?: string;
  occurred_end?: string;
  context?: string;
  /** Provenance and bookkeeping stored with the memory (e.g. `origin`, `turn_id`), so the recall screen can read its origin. */
  metadata?: Record<string, string>;
  /** Relevance score, when the store ranks by one; absent means the array order is the ranking. */
  score?: number;
}

/** One failed call. `code` is what callers switch on; `reason` is the line for logs. */
export interface MemoryFailure {
  ok: false;
  code: 'request_failed' | 'timeout';
  reason: string;
}

export function timeoutFailure(timeoutMs: number): MemoryFailure {
  return { ok: false, code: 'timeout', reason: `request timed out after ${String(timeoutMs)}ms` };
}

export type RecallOutcome = { ok: true; results: RecallItem[] } | MemoryFailure;

export interface RetainItem {
  content: string;
  timestamp: string;
  context?: string;
  document_id: string;
  /** Always names where the memory came from; a save without it is refused. */
  metadata: RetainMetadata;
}

/** One entry a retain added to the daily log, as the log keeps it. */
export interface WrittenEntry {
  /** Stable id `md:{namespace}:{file}#{index}`. */
  id: string;
  /** The whole entry: heading, text and hidden trailer lines. */
  text: string;
}

export interface RetainOutcome {
  ok: boolean;
  reason?: string;
  /** The entries this call added. Absent when the call added none. */
  written?: readonly WrittenEntry[];
}

export type GetOperationOutcome = { ok: true; status: string } | MemoryFailure;

/** The only readings of an operation status the host relies on. */
export function isOperationCompletedStatus(status: string): boolean {
  return status === 'completed' || status === 'success' || status === 'succeeded';
}

export function isOperationFailedStatus(status: string): boolean {
  return status === 'failed' || status === 'error';
}

export interface RetryOperationOutcome {
  ok: boolean;
}

export interface MemoryClient {
  recall(params: {
    query: string;
    maxTokens: number;
    timeoutMs: number;
    /** The chat being answered: notes retained from it are never returned (its history is already in the conversation). */
    currentSessionId?: string | undefined;
    /** The meaning gate of this message, worked out once by `meaningGate`; left out, recall works it out itself. */
    gate?: MeaningGate | undefined;
  }): Promise<RecallOutcome>;

  retain(params: { items: RetainItem[]; operationId: string; timeoutMs: number }): Promise<RetainOutcome>;

  /**
   * Removes every memory stored under one document id. A document that does not exist is a success.
   * `context` is the line the document was retained with, so a store that kept copies before document
   * ids existed can remove those too.
   */
  deleteDocument(params: { documentId: string; context?: string; timeoutMs: number }): Promise<RetainOutcome>;

  getOperation(id: string, timeoutMs: number): Promise<GetOperationOutcome>;

  retryOperation(id: string, timeoutMs: number): Promise<RetryOperationOutcome>;

  /**
   * Memory vault: the effective entries of one vault namespace, newest first.
   * `namespace` is the wire namespace: empty or `default` for the shared vault,
   * `persona:<name>` for a persona vault, else a topic vault. Implementations
   * resolve it tenant-scoped, so one tenant's vault never addresses another's.
   * Vault edits and deletes are applied; deleted entries are omitted.
   */
  listEntries(params: { namespace: string; timeoutMs: number }): Promise<ListMemoryVaultEntriesOutcome>;

  /**
   * Memory vault: the live entries in the newest `maxDailyFiles` daily files of the vault this client's
   * `retain` writes into. Absent on a client without a cheap listing.
   */
  listRecentWrittenEntries?(params: {
    maxDailyFiles: number;
    timeoutMs: number;
  }): Promise<ListMemoryVaultEntriesOutcome>;

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
   * Never throws.
   */
  noteSummaryOutcome?(params: SummaryOutcomeNote): Promise<void>;

  /**
   * Optional: record a retain operation that stored nothing on purpose (a turn with no durable
   * facts) as completed, so a later sweep does not treat it as vanished and rebuild it from the
   * chat. Only the markdown client implements it. Never throws.
   */
  completeOperation?(operationId: string): Promise<void>;

  /**
   * Optional: the people and matter pages a message names, across every vault this client may
   * read, in priority order and within the caps, then the single statements it is about. Only the markdown client implements it, as
   * pages live beside the daily logs. Never throws.
   */
  loadPages?(params: {
    message: string;
    /** The person's earlier messages of this chat, oldest first; a page they name is loaded too. */
    earlierMessages: readonly string[];
    /** The calendar day `YYYY-MM-DD` in the person's time zone. */
    today: string;
    maxPages: number;
    maxTokens: number;
    /** The meaning gate of this message, worked out once by `meaningGate`; left out, it is worked out here. */
    gate?: MeaningGate | undefined;
  }): Promise<PageLoadResult>;

  /**
   * Optional: whether the message is clearly about something remembered, and which page statements and log
   * notes it is about. Worked out once per message and handed to both `recall` and `loadPages`, so the
   * page path and the log path never disagree. Only the markdown client implements it. Never throws.
   */
  meaningGate?(params: { message: string; currentSessionId?: string | undefined }): Promise<MeaningGate>;

  /**
   * Optional: the folder of the one vault this client's chat writes pages to (its persona's vault, else the
   * shared vault). Only the markdown client implements it, so only it offers the memory page tools.
   */
  pagesWriteDir?(): string;

  /**
   * Optional: the pages in this client's write vault whose statements are closest in meaning to a text, nearest
   * first. Empty until the meaning search is ready. Only the markdown client implements it. Never throws.
   */
  pagesByMeaning?(params: { text: string; limit: number }): Promise<PageListing[]>;
}

/** What `loadPages` hands back: the pages the model sees and the counts the memory event records. */
export interface PageLoadResult {
  pages: LoadedPage[];
  stats: PageLoadStats;
  /** Page files left out because their name is not a page name (e.g. `people/Wendy.md`). */
  skippedFiles: string[];
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
  /** The internal id the entry was filed under, when it has one. Not part of `text` and never shown to people. */
  context?: string;
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

/**
 * Markdown-file memory backend (OpenClaw-style).
 *
 * Stores memories as plain Markdown under `{baseDir}/{namespace}/`:
 * - `MEMORY.md`: curated long-term memory, read if present. No writer for this file
 *   and no curation; it is populated manually or by a future phase. `recall()`
 *   includes it when it exists.
 * - `memory/YYYY-MM-DD.md`: append-only daily logs. `retain()` appends here.
 *
 * A persona-scoped client retains into its persona vault and recalls from that vault,
 * the shared vault, and vaults shared with it; each vault ranks separately and the
 * results interleave. An unscoped client uses the shared vault only.
 *
 * `recall()` reads `MEMORY.md` plus every daily log and ranks entries by keyword
 * overlap with the query, so how long ago something was saved never decides whether
 * it can be found. When an `EmbeddingSubsystem` is attached, recall also
 * ranks by meaning: a local embedding model scores entries by semantic similarity
 * and the two rankings fuse (RRF). The vector leg only contributes when the model
 * is ready and the background backfill has indexed the history; otherwise recall
 * behaves exactly as the keyword-only version. No LLM calls, ever.
 *
 * Every method returns a discriminated `{ ok }` result and never throws, matching the
 * `MemoryClient` contract: a memory failure degrades the turn instead of failing it.
 */
import { PromiseTimeoutError, withTimeout } from '@truefoundry/trueforge-core/core';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  USER_FACING_STORAGE_UNAVAILABLE_MESSAGE,
  ensureWritableDataDir,
  isDataDirConfigurationError,
} from '../../utils/dataDir';
import { stripAssistantAbilityNotes } from './assistantAbilityNotes';
import type { EmbeddingSubsystemResolver, RankedMemory } from './embeddingRetrieval';
import {
  DOCUMENT_ID_METADATA_KEY,
  REPLACE_DOCUMENT_METADATA_KEY,
  appendVaultTombstone,
  clearSummaryPending,
  entryKeywordText,
  entryMetadata,
  entryOccurredAt,
  entryRecallText,
  estimateTokens,
  formatRetainEntry,
  isLegacyDocumentCopy,
  latestTombstonesByEntry,
  markSummaryFailed,
  namespaceDirFor,
  normalizedEntryBody,
  personaForVaultFilesystemNamespace,
  personaForVaultNamespace,
  readSummaryPending,
  readVaultTombstones,
  recallExcludedIds,
  sanitizeNamespace,
  scanNamespaceEntries,
  scanVaultEntries,
  splitEntries,
  vaultFilesystemNamespace,
  vaultReadNamespaces,
  vaultWriteNamespace,
  withOriginalHiddenMarkers,
  withoutHiddenMarkers,
  withoutSourceLines,
  type NamespaceScan,
  type VaultScope,
  type VaultTombstone,
} from './markdownMemoryFiles';
import { computeMeaningGate, type GateVault, type MeaningGate } from './meaningGate';
import type {
  DeleteMemoryVaultEntryOutcome,
  DeleteShownMemoryOutcome,
  ListMemoryVaultEntriesOutcome,
  MemoryClient,
  MemoryVaultEntry,
  MemoryVaultFailure,
  PageLoadResult,
  SummaryOutcomeNote,
  UpdateMemoryVaultEntryOutcome,
} from './memoryClient';
import {
  timeoutFailure,
  type GetOperationOutcome,
  type RecallItem,
  type RecallOutcome,
  type RetainItem,
  type RetainOutcome,
  type RetryOperationOutcome,
} from './memoryClient';
import { MISSING_ORIGIN_REASON, everyItemNamesOrigin } from './memoryOrigin';
import { loadPagesForMessage } from './memoryPageLoader';
import type { PageListing } from './memoryPages';
import { ensureMemorySourceLines } from './memorySourceLines';
import { forgetSortReport } from './pageSortReport';
import { recallFactExcluded, shownFactText } from './recallExclusions';
import { rankNamedPeopleFirst } from './recallNameBoost';
import { pagesNearText, statementIndexFor } from './statementIndex';
import { VaultEraseError, eraseMarkedEntries } from './vaultErase';
import { VaultBusyError, VaultLockLostError, withVaultLock } from './vaultLock';

export interface MarkdownMemoryClientConfig {
  /** Base directory for all memory files; each namespace gets a subdirectory. */
  baseDir: string;
  /** Tenant namespace; sanitized before use as a directory name. */
  namespace: string;
  /**
   * The vault this client retains into and recalls from. Omitted: the shared vault only.
   * With a persona: its own vault, the shared vault, and vaults shared with it.
   */
  vaultScope?: VaultScope | undefined;
  /**
   * Meaning-based recall. When omitted, recall is keyword-only. Subsystems are
   * process-wide singletons shared across client instances (see `getEmbeddingSubsystem`).
   */
  embeddings?: EmbeddingSubsystemResolver | undefined;
}

/**
 * Pending retains to each daily folder in this process. An entry's id is its position in the day's file,
 * counted before the append, so two retains running together would give different entries the same id.
 */
const retainQueues = new Map<string, Promise<void>>();

/** Pending writes to each operations file in this process, so concurrent recordings run one at a time. */
const operationsFileQueues = new Map<string, Promise<void>>();

/** Cap on tracked retain operation ids; oldest are dropped, newest kept. */
const OPERATIONS_LOG_CAP = 2000;

/** Lowercased query words worth matching; drops stopword-length fragments. */
function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 2);
}

function scoreEntry(words: string[], text: string): number {
  if (words.length === 0) {
    return 0;
  }
  const lower = text.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (lower.includes(word)) {
      score += 1;
    }
  }
  return score;
}

/** Merges ranked lists best-first, earlier lists leading each round, so no vault starves the others. */
function interleaveRanked(lists: RankedMemory[][]): RankedMemory[] {
  const merged: RankedMemory[] = [];
  const longest = Math.max(0, ...lists.map(list => list.length));
  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      const item = list[rank];
      if (item !== undefined) {
        merged.push(item);
      }
    }
  }
  return merged;
}

function failure(reason: string): { ok: false; code: 'request_failed'; reason: string } {
  return { ok: false, code: 'request_failed', reason };
}

function vaultTimeoutFailure(timeoutMs: number): MemoryVaultFailure {
  return { ok: false, code: 'timeout', reason: `request timed out after ${String(timeoutMs)}ms` };
}

function vaultNotFound(entryId: string): MemoryVaultFailure {
  return { ok: false, code: 'not_found', reason: `Memory vault entry not found: ${entryId}` };
}

/** Longest replacement text the vault accepts for one entry. */
const VAULT_MAX_ENTRY_TEXT_LENGTH = 32768;

/**
 * Builds the `reason` string for a failed memory operation. Storage
 * misconfiguration is an operator problem: the reason reaches the memory
 * provider health UI, so a config failure surfaces the shared static sentence
 * exactly — never the env var, path, or `-v` remediation from the thrown
 * error. Logs keep the full detail.
 */
function failureReason(prefix: string, error: unknown): string {
  if (isDataDirConfigurationError(error)) {
    return USER_FACING_STORAGE_UNAVAILABLE_MESSAGE;
  }
  if (error instanceof VaultEraseError || error instanceof VaultBusyError || error instanceof VaultLockLostError) {
    return error.message;
  }
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

export class MarkdownMemoryClient implements MemoryClient {
  private readonly baseDir: string;
  private readonly namespace: string;
  private readonly vaultScope: VaultScope | undefined;
  /** The one vault `retain` appends to; also owns this client's retain operation ids. */
  private readonly writeNamespace: string;
  private readonly embeddings: EmbeddingSubsystemResolver | undefined;

  constructor(input: MarkdownMemoryClientConfig) {
    this.baseDir = input.baseDir;
    this.namespace = sanitizeNamespace(input.namespace);
    this.vaultScope = input.vaultScope;
    this.writeNamespace = sanitizeNamespace(
      vaultWriteNamespace({ tenantNamespace: this.namespace, scope: input.vaultScope }),
    );
    this.embeddings = input.embeddings;
  }

  /** Directory of the vault this client writes into. */
  private namespaceDir(): string {
    return namespaceDirFor(this.baseDir, this.writeNamespace);
  }

  private dailyDir(): string {
    return path.join(this.namespaceDir(), 'memory');
  }

  private operationsFile(): string {
    return path.join(this.namespaceDir(), '.operations.json');
  }

  async recall(params: {
    query: string;
    maxTokens: number;
    timeoutMs: number;
    currentSessionId?: string | undefined;
    gate?: MeaningGate | undefined;
  }): Promise<RecallOutcome> {
    try {
      const budget = Math.max(params.maxTokens, 0);
      const results: RecallItem[] = [];
      let usedTokens = 0;

      const take = (item: RecallItem): boolean => {
        const cost = estimateTokens(item.text);
        if (usedTokens + cost > budget) {
          return false;
        }
        usedTokens += cost;
        results.push(item);
        return true;
      };

      const readable = await vaultReadNamespaces({
        baseDir: this.baseDir,
        tenantNamespace: this.namespace,
        scope: this.vaultScope,
      });
      const vaults = await Promise.all(
        readable.map(async namespace => ({
          namespace: sanitizeNamespace(namespace),
          scan: await scanNamespaceEntries({
            baseDir: this.baseDir,
            namespace,
            // Recall reads the whole log: a memory's age must never decide whether it can be found.
            maxDailyFiles: Number.POSITIVE_INFINITY,
            // Vault deletes hide entries and vault edits replace their text: recall
            // must see the same effective entries the vault lists.
            resolveTombstones: true,
          }),
        })),
      );

      // Curated memory first: it is the model's own long-term store.
      for (const { namespace, scan } of vaults) {
        if (scan.curated !== undefined) {
          // The file is read like any entry: it is the person's own only when it closes with the line that says so.
          take({
            id: `md:${namespace}:MEMORY.md`,
            text: withoutSourceLines(scan.curated).trim(),
            metadata: entryMetadata(scan.curated),
          });
        }
      }

      // Each vault ranks on its own corpus and index; the lists then interleave.
      const gate =
        params.gate ??
        (await computeMeaningGate({
          message: params.query,
          vaults: vaults.map(({ namespace, scan }) => this.gateVault({ namespace, scan })),
          currentSessionId: params.currentSessionId,
        }));
      const rankedLists = await Promise.all(
        vaults.map(({ namespace, scan }) =>
          this.rankVault({
            namespace,
            scan,
            query: params.query,
            timeoutMs: params.timeoutMs,
            currentSessionId: params.currentSessionId,
            gate,
          }),
        ),
      );
      // The same thing saved on several days is shown once, as its best-ranked copy.
      const shown = new Set<string>();
      for (const item of interleaveRanked(rankedLists)) {
        const body = normalizedEntryBody(item.text);
        if (shown.has(body)) {
          continue;
        }
        shown.add(body);
        const occurredAt = entryOccurredAt(item);
        // The time and the chat id travel as fields: recall shows the date, and can skip notes from the current chat.
        const ok = take({
          id: item.id,
          text: entryRecallText(item.text),
          ...(occurredAt !== undefined && { occurred_start: occurredAt }),
          metadata: entryMetadata(item.text),
        });
        if (!ok) {
          break;
        }
      }

      return { ok: true, results };
    } catch (error) {
      return failure(failureReason('markdown recall failed', error));
    }
  }

  /**
   * One vault's entries best-first. When the meaning gate judged the message, only the notes it chose are
   * shown, best standing first. Otherwise: keyword overlap, fused with the vault's own meaning index when
   * ready. Either way notes naming a person the query asks about move to the front, and the chat being
   * answered is left out.
   */
  private async rankVault(input: {
    namespace: string;
    scan: NamespaceScan;
    query: string;
    timeoutMs: number;
    currentSessionId: string | undefined;
    gate: MeaningGate;
  }): Promise<RankedMemory[]> {
    const { gate } = input;
    if (gate.state === 'judged' && gate.judgedNamespaces.has(input.namespace)) {
      const texts = new Map(input.scan.entries.map(entry => [entry.id, entry.text]));
      const chosen = gate.notes.flatMap(({ id }): RankedMemory[] => {
        const text = texts.get(id);
        return text === undefined ? [] : [{ id, text }];
      });
      return rankNamedPeopleFirst({ candidates: chosen, message: input.query });
    }
    const excludeIds = recallExcludedIds({
      entries: input.scan.entries,
      sessionId: input.currentSessionId,
    });
    const entries = input.scan.entries.filter(entry => !excludeIds.has(entry.id));
    const words = queryWords(input.query);
    const scored = entries
      .map(entry => ({ entry, score: scoreEntry(words, entryKeywordText(entry.text)) }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.file.localeCompare(a.entry.file));
    const keywordRanked = scored.map(candidate => ({ id: candidate.entry.id, text: candidate.entry.text }));

    // Meaning-based rank fuses with (never replaces) the keyword ranking. When the
    // vector leg cannot contribute, this resolves undefined and ranking stays
    // keyword-only, identical to the pre-embeddings behavior.
    const embeddings = this.embeddings?.(input.namespace);
    let ranked = keywordRanked;
    if (embeddings !== undefined) {
      embeddings.ensureWarmed();
      const fused = await embeddings.fusedRank({
        query: input.query,
        keywordHits: keywordRanked,
        entryTexts: new Map(entries.map(entry => [entry.id, entry.text])),
        excludeIds,
        timeoutMs: input.timeoutMs,
      });
      ranked = fused ?? keywordRanked;
    }
    // Applied after fusion so it wins over both legs: the budget cut in recall() happens before
    // the capability's gate ever sees these entries.
    return rankNamedPeopleFirst({ candidates: ranked, message: input.query });
  }

  async retain(params: { items: RetainItem[]; operationId: string; timeoutMs: number }): Promise<RetainOutcome> {
    const key = this.dailyDir();
    const run = (retainQueues.get(key) ?? Promise.resolve()).then(() => this.retainOne(params));
    retainQueues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async retainOne(params: {
    items: RetainItem[];
    operationId: string;
    timeoutMs: number;
  }): Promise<RetainOutcome> {
    try {
      if (params.items.length === 0) {
        return { ok: true };
      }
      if (!everyItemNamesOrigin(params.items)) {
        return failure(MISSING_ORIGIN_REASON);
      }
      // Ability notes about Aman never reach the log (see assistantAbilityNotes).
      const items = params.items
        .map(item => ({ ...item, content: stripAssistantAbilityNotes(item.content) }))
        .filter(item => item.content !== '');
      // Names MEMORY_MARKDOWN_DIR in the error instead of a bare EACCES; the
      // caller's catch converts it into a failed outcome, never a throw.
      await ensureWritableDataDir({ dir: this.dailyDir(), envVar: 'MEMORY_MARKDOWN_DIR' });
      // Older notes are marked first, so a "From you" line on disk is always one a save wrote.
      await ensureMemorySourceLines({ baseDir: this.baseDir });

      const seen = await this.readOperationIds();
      if (seen.has(params.operationId)) {
        return { ok: true };
      }
      if (items.length === 0) {
        // Everything retained was an ability note: store nothing, but record the
        // operation so a later sweep sees it as completed.
        await this.recordOperation(params.operationId);
        return { ok: true };
      }

      // Group items by day so one retain spanning midnight lands in both files.
      const byDay = new Map<string, RetainItem[]>();
      for (const item of items) {
        const day = this.dayOf(item.timestamp);
        const list = byDay.get(day);
        if (list === undefined) {
          byDay.set(day, [item]);
        } else {
          list.push(item);
        }
      }
      const indexed: { id: string; text: string }[] = [];
      // Looked up before the append so a retry after a half-finished attempt finds, and hides, the
      // copy that attempt wrote as well as the original: one entry remains.
      const replaced = await this.liveDocumentEntryIds(
        items.flatMap(item =>
          item.metadata[REPLACE_DOCUMENT_METADATA_KEY] === 'true'
            ? [{ documentId: item.document_id, context: item.context?.trim() }]
            : [],
        ),
      );
      // Counting what is there and appending are one step under the lock, so an erase rewriting the
      // same day's file cannot drop the new entries or shift their positions.
      await this.withWriteLock(this.writeNamespace, async () => {
        await this.finishEarlierErases(this.writeNamespace);
        for (const [day, items] of byDay) {
          const filePath = path.join(this.dailyDir(), `${day}.md`);
          // Entry ids are positional; count what is already there before appending.
          let existing = 0;
          try {
            existing = splitEntries(await readFile(filePath, 'utf8')).length;
          } catch {
            existing = 0;
          }
          const blocks = items.map((item, offset) => {
            const text = formatRetainEntry(item);
            const id = `md:${this.writeNamespace}:${day}.md#${String(existing + offset)}`;
            indexed.push({ id, text });
            return text;
          });
          // Each block ends with a newline and blocks are blank-line separated,
          // matching the historical append format exactly.
          await writeFile(filePath, `${blocks.map(block => `${block}\n`).join('\n')}\n`, {
            flag: 'a',
            encoding: 'utf8',
          });
        }
      });

      await this.hideEntries(replaced);
      await this.recordOperation(params.operationId);

      // New memories become searchable by meaning without waiting for a backfill.
      // Kicking the warm here (not just on recall) means a retain-only session
      // still downloads the model and builds the index in the background.
      const embeddings = this.embeddings?.(this.writeNamespace);
      embeddings?.ensureWarmed();
      embeddings?.indexNewEntries(indexed);
      return { ok: true, written: indexed };
    } catch (error) {
      return { ok: false, reason: failureReason('markdown retain failed', error) };
    }
  }

  async deleteDocument(params: { documentId: string; context?: string; timeoutMs: number }): Promise<RetainOutcome> {
    try {
      await withTimeout(
        this.liveDocumentEntryIds([{ documentId: params.documentId, context: params.context?.trim() }]).then(ids =>
          this.hideEntries(ids),
        ),
        params.timeoutMs,
        `markdown deleteDocument ${params.documentId}`,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: failureReason('markdown document delete failed', error) };
    }
  }

  async completeOperation(operationId: string): Promise<void> {
    try {
      await this.recordOperation(operationId);
    } catch {
      // Best effort: a sweep that still finds the operation missing is covered by the recovery rule.
    }
  }

  async getOperation(id: string, timeoutMs: number): Promise<GetOperationOutcome> {
    try {
      // Local reads are fast, but a stalled filesystem must not hold a turn open past its budget.
      const seen = await withTimeout(this.readOperationIds(), timeoutMs, `markdown getOperation ${id}`);
      // A vanished operation reads the same as "nothing to wait for" so a sweep drops it.
      return { ok: true, status: seen.has(id) ? 'completed' : 'unknown' };
    } catch (error) {
      if (error instanceof PromiseTimeoutError) {
        return timeoutFailure(timeoutMs);
      }
      return failure(failureReason('markdown operation lookup failed', error));
    }
  }

  async retryOperation(id: string, timeoutMs: number): Promise<RetryOperationOutcome> {
    // File appends are synchronous: there is nothing to retry. The timeout race upholds the
    // MemoryClient contract — no call settles later than its timeoutMs.
    try {
      return await withTimeout(Promise.resolve({ ok: true }), timeoutMs, `markdown retryOperation ${id}`);
    } catch {
      return { ok: false };
    }
  }

  /**
   * Entry ids are positional (`md:{namespace}:{file}#{index}`); the id carries its
   * own namespace, so it must stay inside this tenant's vaults to resolve.
   */
  private static readonly VAULT_ENTRY_ID_PATTERN = /^md:([^:]+):([^#]+)#(\d+)$/;

  private vaultTenantScope(filesystemNamespace: string): boolean {
    return filesystemNamespace === this.namespace || filesystemNamespace.startsWith(`${this.namespace}__`);
  }

  private async lookupVaultEntry(
    entryId: string,
    timeoutMs: number,
  ): Promise<{ filesystemNamespace: string; deleted: boolean; text: string } | undefined> {
    const match = MarkdownMemoryClient.VAULT_ENTRY_ID_PATTERN.exec(entryId);
    const filesystemNamespace = match?.[1] ?? '';
    if (match === null || !this.vaultTenantScope(filesystemNamespace)) {
      return undefined;
    }
    // One budget for the whole lookup: the scan and the marker read share it.
    return withTimeout(
      (async (): Promise<{ filesystemNamespace: string; deleted: boolean; text: string } | undefined> => {
        const tombstones = await readVaultTombstones({
          baseDir: this.baseDir,
          namespace: filesystemNamespace,
        });
        // A deleted entry's text is gone from its file, so the marker alone says it was there.
        if (latestTombstonesByEntry(tombstones).get(entryId)?.action === 'deleted') {
          return { filesystemNamespace, deleted: true, text: '' };
        }
        const scan = await scanNamespaceEntries({
          baseDir: this.baseDir,
          namespace: filesystemNamespace,
          maxDailyFiles: Number.POSITIVE_INFINITY,
        });
        const original = scan.entries.find(entry => entry.id === entryId);
        if (original === undefined) {
          return undefined;
        }
        return { filesystemNamespace, deleted: false, text: original.text };
      })(),
      timeoutMs,
      `markdown vault lookup ${entryId}`,
    );
  }

  /** Every vault this client may read, own vault first; the same order recall uses. */
  private async readVaults(): Promise<{ namespace: string; dir: string }[]> {
    const readable = await vaultReadNamespaces({
      baseDir: this.baseDir,
      tenantNamespace: this.namespace,
      scope: this.vaultScope,
    });
    return readable.map(namespace => ({ namespace, dir: namespaceDirFor(this.baseDir, namespace) }));
  }

  /** A vault as the meaning gate looks into it. Starts the model load when it has not run; the gate never waits for a download. */
  private gateVault({ namespace, scan }: { namespace: string; scan: NamespaceScan }): GateVault {
    const embeddings = this.embeddings?.(sanitizeNamespace(namespace));
    embeddings?.ensureWarmed();
    return { namespace: sanitizeNamespace(namespace), dir: namespaceDirFor(this.baseDir, namespace), scan, embeddings };
  }

  async meaningGate(params: { message: string; currentSessionId?: string | undefined }): Promise<MeaningGate> {
    try {
      const vaults = await Promise.all(
        (await this.readVaults()).map(async ({ namespace }) => ({
          namespace,
          scan: await scanNamespaceEntries({
            baseDir: this.baseDir,
            namespace,
            maxDailyFiles: Number.POSITIVE_INFINITY,
            resolveTombstones: true,
          }),
        })),
      );
      return await computeMeaningGate({
        message: params.message,
        vaults: vaults.map(vault => this.gateVault(vault)),
        currentSessionId: params.currentSessionId,
      });
    } catch {
      return { state: 'unavailable' };
    }
  }

  pagesWriteDir(): string {
    return this.namespaceDir();
  }

  async pagesByMeaning({ text, limit }: { text: string; limit: number }): Promise<PageListing[]> {
    try {
      const model = this.embeddings?.(this.writeNamespace).embeddingModel;
      if (model === undefined) {
        return [];
      }
      const index = statementIndexFor({ vaultDir: this.namespaceDir(), model });
      return await pagesNearText({ index, model, text, limit });
    } catch {
      return [];
    }
  }

  async loadPages(params: {
    message: string;
    earlierMessages: readonly string[];
    today: string;
    maxPages: number;
    maxTokens: number;
    gate?: MeaningGate | undefined;
  }): Promise<PageLoadResult> {
    let vaults: { namespace: string; dir: string }[];
    try {
      vaults = await this.readVaults();
    } catch {
      return {
        pages: [],
        stats: { candidates: 0, loaded: 0, dropped_over_count: 0, dropped_over_budget: 0 },
        skippedFiles: [],
      };
    }
    const { gate, ...rest } = params;
    return loadPagesForMessage({
      vaultDirs: vaults.map(vault => vault.dir),
      writeVaultDir: this.namespaceDir(),
      gate: gate ?? (await this.meaningGate({ message: params.message })),
      ...rest,
    });
  }

  async listEntries(params: { namespace: string; timeoutMs: number }): Promise<ListMemoryVaultEntriesOutcome> {
    return this.listVault({
      filesystemNamespace: vaultFilesystemNamespace(this.namespace, params.namespace),
      persona: personaForVaultNamespace(params.namespace),
      maxDailyFiles: Number.POSITIVE_INFINITY,
      timeoutMs: params.timeoutMs,
    });
  }

  async listRecentWrittenEntries(params: {
    maxDailyFiles: number;
    timeoutMs: number;
  }): Promise<ListMemoryVaultEntriesOutcome> {
    return this.listVault({
      filesystemNamespace: this.writeNamespace,
      persona: this.vaultScope?.personaName ?? null,
      maxDailyFiles: params.maxDailyFiles,
      timeoutMs: params.timeoutMs,
    });
  }

  private async listVault(input: {
    filesystemNamespace: string;
    persona: string | null;
    maxDailyFiles: number;
    timeoutMs: number;
  }): Promise<ListMemoryVaultEntriesOutcome> {
    try {
      const scanned = await withTimeout(
        scanVaultEntries({
          baseDir: this.baseDir,
          namespace: input.filesystemNamespace,
          maxDailyFiles: input.maxDailyFiles,
        }),
        input.timeoutMs,
        'markdown vault list',
      );
      const entries: MemoryVaultEntry[] = scanned.map(entry => ({
        id: entry.id,
        text: entry.text,
        timestamp: entry.timestamp,
        persona: input.persona,
        ...(entry.context === undefined ? {} : { context: entry.context }),
      }));
      return { ok: true, entries };
    } catch (error) {
      if (error instanceof PromiseTimeoutError) {
        return vaultTimeoutFailure(input.timeoutMs);
      }
      return { ok: false, code: 'request_failed', reason: failureReason('markdown vault list failed', error) };
    }
  }

  /**
   * Notes one turn-summary attempt's outcome on this client's write vault: a failure
   * leaves the summary-pending marker, a success clears it. Never throws: the marker
   * is page state, and losing it must never fail or delay the turn it belongs to.
   */
  async noteSummaryOutcome(params: SummaryOutcomeNote): Promise<void> {
    try {
      if (params.outcome === 'summarized') {
        await clearSummaryPending({ baseDir: this.baseDir, namespace: this.writeNamespace });
      } else {
        await markSummaryFailed({
          baseDir: this.baseDir,
          namespace: this.writeNamespace,
          mark: { failed_at: new Date().toISOString(), reason: params.reason ?? 'model_failed' },
        });
      }
    } catch {
      // Best effort only; the retain path logs the summary outcome itself.
    }
  }

  /** Whether the vault for a wire namespace is still owed a turn summary. Never throws. */
  async summaryPending(params: { namespace: string }): Promise<boolean> {
    try {
      const filesystemNamespace = vaultFilesystemNamespace(this.namespace, params.namespace);
      return (await readSummaryPending({ baseDir: this.baseDir, namespace: filesystemNamespace })) !== undefined;
    } catch {
      return false;
    }
  }

  async updateEntry(params: {
    entryId: string;
    text: string;
    timeoutMs: number;
  }): Promise<UpdateMemoryVaultEntryOutcome> {
    try {
      const clean = params.text.trim();
      if (clean.length === 0) {
        return { ok: false, code: 'request_failed', reason: 'Entry text must not be empty.' };
      }
      if (clean.length > VAULT_MAX_ENTRY_TEXT_LENGTH) {
        return {
          ok: false,
          code: 'request_failed',
          reason: `Entry text must be at most ${String(VAULT_MAX_ENTRY_TEXT_LENGTH)} characters.`,
        };
      }
      const target = await this.lookupVaultEntry(params.entryId, params.timeoutMs);
      if (target === undefined || target.deleted) {
        return vaultNotFound(params.entryId);
      }
      const timestamp = new Date().toISOString();
      await withTimeout(
        this.markAndErase({
          namespace: target.filesystemNamespace,
          tombstone: { entryId: params.entryId, action: 'updated', text: clean, timestamp },
        }),
        params.timeoutMs,
        `markdown vault mark ${params.entryId}`,
      );
      // The edit re-indexes in the vault that owns the entry, never in another vault's store.
      const embeddings = this.embeddings?.(target.filesystemNamespace);
      embeddings?.ensureWarmed();
      const stored = withOriginalHiddenMarkers({ original: target.text, edited: clean });
      embeddings?.indexNewEntries([{ id: params.entryId, text: stored }]);
      return {
        ok: true,
        entry: {
          id: params.entryId,
          // The same text a listing shows: the edit, closed by the line that says where the entry came from.
          text: withoutHiddenMarkers(stored),
          timestamp,
          persona: personaForVaultFilesystemNamespace(this.namespace, target.filesystemNamespace),
        },
      };
    } catch (error) {
      if (error instanceof PromiseTimeoutError) {
        return vaultTimeoutFailure(params.timeoutMs);
      }
      return { ok: false, code: 'request_failed', reason: failureReason('markdown vault update failed', error) };
    }
  }

  async deleteEntry(params: { entryId: string; timeoutMs: number }): Promise<DeleteMemoryVaultEntryOutcome> {
    try {
      const target = await this.lookupVaultEntry(params.entryId, params.timeoutMs);
      if (target === undefined) {
        return vaultNotFound(params.entryId);
      }
      // An entry already marked deleted still gets its erase run again: that is how a failed one is retried.
      await withTimeout(
        this.markAndErase({
          namespace: target.filesystemNamespace,
          tombstone: target.deleted
            ? undefined
            : { entryId: params.entryId, action: 'deleted', text: undefined, timestamp: new Date().toISOString() },
        }),
        params.timeoutMs,
        `markdown vault mark ${params.entryId}`,
      );
      return { ok: true };
    } catch (error) {
      if (error instanceof PromiseTimeoutError) {
        return vaultTimeoutFailure(params.timeoutMs);
      }
      return { ok: false, code: 'request_failed', reason: failureReason('markdown vault delete failed', error) };
    }
  }

  /**
   * Deletes every memory, in any of this tenant's vaults, that recall shows in these words. The side panel
   * of a chat only has the words, so the match is made here, with the same text recall builds its lines from.
   */
  async deleteEntriesShownAs(params: { shownText: string; timeoutMs: number }): Promise<DeleteShownMemoryOutcome> {
    try {
      const ids = await withTimeout(
        this.entryIdsShownAs(params.shownText),
        params.timeoutMs,
        'markdown vault find shown memory',
      );
      for (const entryId of ids) {
        const outcome = await this.deleteEntry({ entryId, timeoutMs: params.timeoutMs });
        if (!outcome.ok) {
          return outcome;
        }
      }
      return { ok: true, deleted: ids.length };
    } catch (error) {
      if (error instanceof PromiseTimeoutError) {
        return vaultTimeoutFailure(params.timeoutMs);
      }
      return { ok: false, code: 'request_failed', reason: failureReason('markdown vault delete failed', error) };
    }
  }

  /** Ids of the memories shown in these words. Words that were cut short must point at one memory only, else none is named. */
  private async entryIdsShownAs(shownText: string): Promise<string[]> {
    const shown = new Set([shownText]);
    let folders: string[] = [];
    try {
      folders = (await readdir(this.baseDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && this.vaultTenantScope(entry.name))
        .map(entry => entry.name);
    } catch {
      // No memory folder yet means nothing is stored.
    }
    const matches: { id: string; text: string }[] = [];
    for (const namespace of folders) {
      const scan = await scanNamespaceEntries({
        baseDir: this.baseDir,
        namespace,
        maxDailyFiles: Number.POSITIVE_INFINITY,
        resolveTombstones: true,
      });
      for (const entry of scan.entries) {
        const text = shownFactText(entryRecallText(entry.text));
        if (recallFactExcluded({ exclusions: shown, shownText: text })) {
          matches.push({ id: entry.id, text });
        }
      }
    }
    return new Set(matches.map(match => match.text)).size > 1 ? [] : matches.map(match => match.id);
  }

  private dayOf(timestamp: string): string {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
      return new Date().toISOString().slice(0, 10);
    }
    return parsed.toISOString().slice(0, 10);
  }

  /**
   * Ids of the visible entries in the write vault that are earlier copies of one of these documents:
   * entries carrying the document id, and (only when a context is given) copies written before ids
   * were recorded, which `isLegacyDocumentCopy` recognises. Those older copies recorded no user, so a
   * tenant vault shared by several people hides every person's older copy of the same document.
   */
  private async liveDocumentEntryIds(
    documents: readonly { documentId: string; context: string | undefined }[],
  ): Promise<string[]> {
    if (documents.length === 0) {
      return [];
    }
    const scan = await scanNamespaceEntries({
      baseDir: this.baseDir,
      namespace: this.writeNamespace,
      maxDailyFiles: Number.POSITIVE_INFINITY,
      resolveTombstones: true,
    });
    const documentIds = new Set(documents.map(document => document.documentId));
    const legacyContexts = documents.flatMap(document =>
      document.context === undefined || document.context === '' ? [] : [document.context],
    );
    return scan.entries
      .filter(entry => {
        const documentId = entryMetadata(entry.text)[DOCUMENT_ID_METADATA_KEY];
        if (documentId !== undefined) {
          return documentIds.has(documentId);
        }
        return legacyContexts.some(context => isLegacyDocumentCopy({ text: entry.text, context }));
      })
      .map(entry => entry.id);
  }

  /** Hides entries with the vault's delete marker and erases their text from the dated files. */
  private async hideEntries(entryIds: readonly string[]): Promise<void> {
    if (entryIds.length === 0) {
      return;
    }
    const timestamp = new Date().toISOString();
    await this.withWriteLock(this.writeNamespace, async () => {
      for (const entryId of entryIds) {
        await appendVaultTombstone({
          baseDir: this.baseDir,
          namespace: this.writeNamespace,
          tombstone: { entryId, action: 'deleted', text: undefined, timestamp },
        });
      }
      await eraseMarkedEntries({ baseDir: this.baseDir, namespace: this.writeNamespace });
      await forgetSortReport({ vaultDir: this.namespaceDir(), noteIds: entryIds });
    });
  }

  private async withWriteLock<T>(namespace: string, work: () => Promise<T>): Promise<T> {
    return withVaultLock({ vaultDir: namespaceDirFor(this.baseDir, namespace) }, work);
  }

  /**
   * Writes a marker, then erases from the dated files what it hides, in one hold of the vault lock. The marker
   * goes first so the person's view changes at once; when the erase fails the marker stays, the person is told
   * to try again, and the next write to the vault finishes the erase.
   */
  private async markAndErase(input: { namespace: string; tombstone: VaultTombstone | undefined }): Promise<void> {
    await this.withWriteLock(input.namespace, async () => {
      if (input.tombstone !== undefined) {
        await appendVaultTombstone({ baseDir: this.baseDir, namespace: input.namespace, tombstone: input.tombstone });
      }
      await eraseMarkedEntries({ baseDir: this.baseDir, namespace: input.namespace });
      if (input.tombstone !== undefined) {
        await forgetSortReport({
          vaultDir: namespaceDirFor(this.baseDir, input.namespace),
          noteIds: [input.tombstone.entryId],
        });
      }
    });
  }

  /** Finishes erases that markers asked for but an earlier failure or an older version left undone. Never blocks a save. */
  private async finishEarlierErases(namespace: string): Promise<void> {
    try {
      await eraseMarkedEntries({ baseDir: this.baseDir, namespace, onlyIfNew: true });
    } catch {
      // The save goes ahead; the marker file still holds the work, so the next write tries again.
    }
  }

  private async readOperationIds(): Promise<Set<string>> {
    try {
      const raw = await readFile(this.operationsFile(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return new Set();
      }
      const ids = new Set<string>();
      for (const entry of parsed) {
        if (typeof entry === 'string') {
          ids.add(entry);
        }
      }
      return ids;
    } catch {
      return new Set();
    }
  }

  /**
   * Adds one operation id to the log. Concurrent turns in this process queue on the file, and the
   * file is replaced whole, so no id is lost and a reader never sees half a write.
   */
  private async recordOperation(operationId: string): Promise<void> {
    const file = this.operationsFile();
    const previous = operationsFileQueues.get(file) ?? Promise.resolve();
    const run = previous.then(async () => {
      const ids = await this.readOperationIds();
      ids.add(operationId);
      await ensureWritableDataDir({ dir: this.namespaceDir(), envVar: 'MEMORY_MARKDOWN_DIR' });
      const temporary = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify([...ids].slice(-OPERATIONS_LOG_CAP)), 'utf8');
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
    // The queue carries on after a failed write; the caller still sees the failure.
    operationsFileQueues.set(
      file,
      run.catch(() => undefined),
    );
    await run;
  }
}

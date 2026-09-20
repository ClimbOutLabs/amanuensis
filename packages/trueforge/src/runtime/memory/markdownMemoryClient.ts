/**
 * Markdown-file memory backend (OpenClaw-style), Phase 1.
 *
 * Stores memories as plain Markdown under `{baseDir}/{namespace}/`:
 * - `MEMORY.md`: curated long-term memory, read if present. Phase 1 provides no
 *   writer for this file and performs no curation, validation, or schema enforcement;
 *   it is populated manually or by a future phase. `recall()` includes it when it exists.
 * - `memory/YYYY-MM-DD.md`: append-only daily logs. `retain()` appends here.
 *
 * `recall()` reads `MEMORY.md` plus recent daily logs and ranks entries by keyword
 * overlap with the query. No embeddings, no vector search, no LLM calls in Phase 1.
 *
 * Every method returns a discriminated `{ ok }` result and never throws, matching the
 * `MemoryClient` contract: a memory failure degrades the turn instead of failing it.
 */
import { PromiseTimeoutError, withTimeout } from '@truefoundry/trueforge-core/core';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  timeoutFailure,
  type GetOperationOutcome,
  type GetProfileOutcome,
  type ListMentalModelsOutcome,
  type RecallItem,
  type RecallOutcome,
  type ReflectBudget,
  type ReflectOutcome,
  type RetainItem,
  type RetainOutcome,
  type RetryOperationOutcome,
} from './hindsightClient';
import type { MemoryClient } from './memoryClient';

export interface MarkdownMemoryClientConfig {
  /** Base directory for all memory files; each namespace gets a subdirectory. */
  baseDir: string;
  /** Tenant namespace; sanitized before use as a directory name. */
  namespace: string;
}

/** Rough chars-per-token for budget estimates; recall truncates, never over-reads. */
const CHARS_PER_TOKEN = 4;

/** How many daily log files recall scans, newest first, before the token budget cuts it off. */
const RECALL_MAX_DAILY_FILES = 14;

/** Cap on tracked retain operation ids; oldest are dropped, newest kept. */
const OPERATIONS_LOG_CAP = 2000;

/** Filesystem-safe namespace; path traversal collapses to underscores. */
function sanitizeNamespace(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return safe.length > 0 ? safe : 'default';
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

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

/** Splits a daily log into entries on `## ` headings; unheaded content is one entry. */
function splitEntries(content: string): string[] {
  const parts = content.split(/\n## /);
  const entries: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) {
      continue;
    }
    const text = (i === 0 ? part : `## ${part}`).trim();
    if (text.length > 0) {
      entries.push(text);
    }
  }
  return entries;
}

function failure(reason: string): { ok: false; code: 'request_failed'; reason: string } {
  return { ok: false, code: 'request_failed', reason };
}

export class MarkdownMemoryClient implements MemoryClient {
  private readonly baseDir: string;
  private readonly namespace: string;

  constructor(input: MarkdownMemoryClientConfig) {
    this.baseDir = input.baseDir;
    this.namespace = sanitizeNamespace(input.namespace);
  }

  private namespaceDir(): string {
    return path.join(this.baseDir, this.namespace);
  }

  private memoryFile(): string {
    return path.join(this.namespaceDir(), 'MEMORY.md');
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
    queryTimestamp: string;
    entityTokens: number;
    timeoutMs: number;
  }): Promise<RecallOutcome> {
    try {
      const words = queryWords(params.query);
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

      // Curated memory first: it is the model's own long-term store.
      try {
        const curated = await readFile(this.memoryFile(), 'utf8');
        const text = curated.trim();
        if (text.length > 0) {
          take({ id: `md:${this.namespace}:MEMORY.md`, text, type: 'markdown' });
        }
      } catch {
        // Missing MEMORY.md is normal for a fresh namespace, not a failure.
      }

      // Daily logs, newest first, ranked by keyword overlap.
      const scored: { file: string; index: number; text: string; score: number }[] = [];
      let files: string[] = [];
      try {
        files = (await readdir(this.dailyDir()))
          .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
          .sort()
          .reverse()
          .slice(0, RECALL_MAX_DAILY_FILES);
      } catch {
        // Missing daily directory is normal for a fresh namespace.
      }
      for (const file of files) {
        let content: string;
        try {
          content = await readFile(path.join(this.dailyDir(), file), 'utf8');
        } catch {
          continue;
        }
        const entries = splitEntries(content);
        for (let index = 0; index < entries.length; index++) {
          const text = entries[index];
          if (text === undefined) {
            continue;
          }
          const score = scoreEntry(words, text);
          if (score > 0) {
            scored.push({ file, index, text, score });
          }
        }
      }
      scored.sort((a, b) => b.score - a.score || b.file.localeCompare(a.file));
      for (const entry of scored) {
        const ok = take({
          id: `md:${this.namespace}:${entry.file}#${String(entry.index)}`,
          text: entry.text,
          type: 'markdown',
        });
        if (!ok) {
          break;
        }
      }

      return { ok: true, results, entities: [] };
    } catch (error) {
      return failure(`markdown recall failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async retain(params: { items: RetainItem[]; operationId: string; timeoutMs: number }): Promise<RetainOutcome> {
    try {
      if (params.items.length === 0) {
        return { ok: true };
      }
      await mkdir(this.dailyDir(), { recursive: true });

      const seen = await this.readOperationIds();
      if (seen.has(params.operationId)) {
        return { ok: true };
      }

      // Group items by day so one retain spanning midnight lands in both files.
      const byDay = new Map<string, RetainItem[]>();
      for (const item of params.items) {
        const day = this.dayOf(item.timestamp);
        const list = byDay.get(day);
        if (list === undefined) {
          byDay.set(day, [item]);
        } else {
          list.push(item);
        }
      }
      for (const [day, items] of byDay) {
        const lines: string[] = [];
        for (const item of items) {
          lines.push(`## ${item.timestamp}`, '', item.content, '');
          if (item.context !== undefined && item.context.trim().length > 0) {
            lines.push(`> ${item.context.trim()}`, '');
          }
        }
        await writeFile(path.join(this.dailyDir(), `${day}.md`), `${lines.join('\n')}\n`, {
          flag: 'a',
          encoding: 'utf8',
        });
      }

      seen.add(params.operationId);
      await this.writeOperationIds(seen);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `markdown retain failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async getOperation(id: string, timeoutMs: number): Promise<GetOperationOutcome> {
    try {
      // Local reads are fast, but a stalled filesystem must not hold a turn open past its budget.
      const seen = await withTimeout(this.readOperationIds(), timeoutMs, `markdown getOperation ${id}`);
      // A vanished operation reads the same as "nothing to wait for" so a sweep drops it,
      // mirroring HindsightClient's 404 handling.
      return { ok: true, status: seen.has(id) ? 'completed' : 'unknown' };
    } catch (error) {
      if (error instanceof PromiseTimeoutError) {
        return timeoutFailure(timeoutMs);
      }
      return failure(`markdown operation lookup failed: ${error instanceof Error ? error.message : String(error)}`);
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

  async getProfile(timeoutMs: number): Promise<GetProfileOutcome> {
    // Phase 1 has no bank profile concept; the curated MEMORY.md serves this purpose.
    const outcome: GetProfileOutcome = {
      ok: true,
      profile: { name: undefined, mission: undefined, background: undefined },
    };
    try {
      return await withTimeout(Promise.resolve(outcome), timeoutMs, 'markdown getProfile');
    } catch {
      return timeoutFailure(timeoutMs);
    }
  }

  async listMentalModels(params: { limit: number; timeoutMs: number }): Promise<ListMentalModelsOutcome> {
    // Phase 1 has no mental-model store; the curated MEMORY.md serves this purpose.
    const outcome: ListMentalModelsOutcome = { ok: true, models: [] };
    try {
      return await withTimeout(Promise.resolve(outcome), params.timeoutMs, 'markdown listMentalModels');
    } catch {
      return timeoutFailure(params.timeoutMs);
    }
  }

  async reflect(params: {
    query: string;
    budget: ReflectBudget;
    maxTokens: number;
    timeoutMs: number;
  }): Promise<ReflectOutcome> {
    const outcome: ReflectOutcome = {
      ok: false,
      code: 'request_failed',
      reason: 'reflect is not supported by the markdown memory backend',
    };
    try {
      return await withTimeout(Promise.resolve(outcome), params.timeoutMs, 'markdown reflect');
    } catch {
      return timeoutFailure(params.timeoutMs);
    }
  }

  private dayOf(timestamp: string): string {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
      return new Date().toISOString().slice(0, 10);
    }
    return parsed.toISOString().slice(0, 10);
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

  private async writeOperationIds(ids: Set<string>): Promise<void> {
    const list = [...ids].slice(-OPERATIONS_LOG_CAP);
    await mkdir(this.namespaceDir(), { recursive: true });
    await writeFile(this.operationsFile(), JSON.stringify(list), 'utf8');
  }
}

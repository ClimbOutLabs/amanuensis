// Generic batch processor used by `batch_modify_emails` and `batch_delete_emails`.
//
// Honors an AbortSignal — bails between batches when the MCP host cancels the
// call (notifications/cancelled). If a whole batch fails, retries the items
// one-by-one so partial success is still reported (returns `successes` and
// `failures` separately).
//
// Pure / surface-agnostic — no Gmail / Google imports.

import { info as logInfo } from "@george43g/robustness";

export interface BatchFailure<T> {
  item: T;
  error: Error;
  /** 0-based index of the batch the item belonged to. */
  batchIndex: number;
}

export interface BatchResult<T, U> {
  successes: U[];
  failures: BatchFailure<T>[];
  /** Number of batches the input was split into. */
  batchesTotal: number;
  /** Batches fully attempted (including per-item fallback after a batch failure). */
  batchesCompleted: number;
  /** Total items handed to processBatches. */
  itemsTotal: number;
  /** True when the loop stopped early because the signal was aborted. */
  aborted: boolean;
}

export interface ProcessBatchesOptions {
  /** Tool name passed to the cancel log line so operators can correlate. */
  toolName: string;
  /** AbortSignal from the MCP request. If aborted between batches we stop. */
  signal?: AbortSignal;
}

/**
 * Process `items` in chunks of `batchSize`, calling `processFn` once per
 * batch. On per-batch failure, falls back to one-item-at-a-time so partial
 * success is captured. Returns both arrays — caller decides how to format.
 */
export async function processBatches<T, U>(
  items: T[],
  batchSize: number,
  processFn: (batch: T[]) => Promise<U[]>,
  opts: ProcessBatchesOptions,
): Promise<BatchResult<T, U>> {
  // Defense in depth: the zod schemas bound batchSize to [1, 500], but this
  // helper is shared — a batchSize of 0 would infinite-loop (`i += 0`), and
  // negatives/fractions would silently mis-chunk.
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`processBatches: batchSize must be a positive integer, got ${batchSize}`);
  }
  const successes: U[] = [];
  const failures: BatchFailure<T>[] = [];
  const { toolName, signal } = opts;
  const batchesTotal = Math.ceil(items.length / batchSize);
  let batchesCompleted = 0;
  let aborted = false;

  for (let i = 0; i < items.length; i += batchSize) {
    if (signal?.aborted) {
      logInfo("batch_cancelled_by_client", {
        tool: toolName,
        processed: i,
        total: items.length,
      });
      aborted = true;
      break;
    }
    const batchIndex = Math.floor(i / batchSize);
    const batch = items.slice(i, i + batchSize);
    try {
      const results = await processFn(batch);
      successes.push(...results);
    } catch (_error) {
      // If batch fails, try individual items
      for (const item of batch) {
        if (signal?.aborted) break;
        try {
          const result = await processFn([item]);
          successes.push(...result);
        } catch (itemError) {
          failures.push({ item, error: itemError as Error, batchIndex });
        }
      }
    }
    batchesCompleted += 1;
  }

  return { successes, failures, batchesTotal, batchesCompleted, itemsTotal: items.length, aborted };
}

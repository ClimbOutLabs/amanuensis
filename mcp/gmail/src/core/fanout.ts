// Bounded fan-out helper for the "list then get-details per row" pattern
// (search results, thread listings, draft listings, unread samples).
//
// Why this exists: a naive `Promise.all(rows.map(get))` fires up to `maxResults`
// (500) Gmail API calls at once — a self-inflicted thundering herd that trips
// Google's per-user rate limits and exhausts sockets. This helper:
//   - caps in-flight calls at FANOUT_CONCURRENCY (8),
//   - acquires the process token-bucket before each call,
//   - retries transient failures (429 / 5xx / network, plus Google's 403
//     rateLimitExceeded) with exponential backoff via withRetry,
//   - skips rows that 404 (deleted between the list call and the get —
//     common under concurrent mailbox mutation) instead of failing the page,
//   - preserves input order in the output.
//
// Pure / surface-agnostic — no Gmail imports; callers pass the per-row fn.

import { isTransientError, rateLimitAcquire, withRetry } from "@george43g/robustness";
import { isRateLimit403 } from "../auth-errors.js";

/** Max parallel in-flight Gmail API calls in a fan-out. */
export const FANOUT_CONCURRENCY = 8;

const SKIPPED = Symbol("fanout-skipped");

/**
 * Gmail-flavoured retry predicate: the library's transient set (429, 5xx,
 * network codes) plus Google's 403 rate-limit/quota responses, which
 * isTransientError deliberately does not cover (a bare 403 is usually auth).
 */
export function isRetryableGmailError(err: unknown): boolean {
  return isTransientError(err) || isRateLimit403(err);
}

export interface FanoutOptions {
  /** Max in-flight calls (default FANOUT_CONCURRENCY). */
  concurrency?: number;
  /** Tag for retry log lines (default "gmail_fanout"). */
  label?: string;
}

/**
 * Map `items` through `fn` with bounded concurrency, per-call rate limiting,
 * transient retry, and 404-skip. Non-404, non-transient errors still fail
 * the whole fan-out (same as the old Promise.all behaviour, minus the herd).
 */
export async function fanoutMap<T, U>(
  items: T[],
  fn: (item: T, index: number) => Promise<U>,
  opts: FanoutOptions = {},
): Promise<U[]> {
  const concurrency = Math.max(1, opts.concurrency ?? FANOUT_CONCURRENCY);
  const label = opts.label ?? "gmail_fanout";
  const out = new Array<U | typeof SKIPPED>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await rateLimitAcquire();
      try {
        out[i] = await withRetry(() => fn(items[i], i), {
          label,
          shouldRetry: isRetryableGmailError,
        });
      } catch (err) {
        if (isNotFoundError(err)) continue; // deleted between list and get — skip
        throw err;
      }
    }
  });

  await Promise.all(workers);
  return out.filter((v): v is U => v !== SKIPPED);
}

/**
 * Detects Gmail API 404s, which arrive as `err.code === 404`,
 * `err.status === 404`, `err.response.status === 404`, or
 * `err.errors[].reason === "notFound"`.
 */
export function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: number | string;
    status?: number;
    errors?: Array<{ reason?: string }>;
    response?: { status?: number };
  };
  if (e.code === 404 || e.code === "404" || e.status === 404) return true;
  if (e.response?.status === 404) return true;
  return Array.isArray(e.errors) && e.errors.some((x) => x?.reason === "notFound");
}
